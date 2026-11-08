import { isDate } from '../common/dates';
import { normalizePhone } from '../common/phone';

export type TravellerType = 'adult' | 'child' | 'baby';
export interface TravellerIn {
  type: TravellerType; fullName: string; dateOfBirth: string; docType: 'passport' | 'national_id'; docNumber: string; docExpiry: string;
  boardSeq?: number; boardSpot?: string; lapOf?: number; contact?: string; responsibility?: boolean;
}

/** Age in whole years on the travel date. */
export function ageOn(dob: string, date: string): number {
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = date.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
export function typeForAge(age: number): TravellerType {
  return age >= 18 ? 'adult' : age >= 3 ? 'child' : 'baby';
}
export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export interface TravellerCheck { errors: string[]; warnings: { idx: number; message: string }[]; }

/**
 * Q04 traveller rules: adults 18+, children 3–17, babies under 3; one free lap baby per adult;
 * at least one adult; passport for cross-border trips (national ID allowed on Jordan-only trips);
 * passport expiring within N months of the trip = warning + "I take responsibility" (never blocks).
 */
export function checkTravellers(list: TravellerIn[], o: { date: string; crossBorder: boolean; warnMonths: number }): TravellerCheck {
  const errors: string[] = [];
  const warnings: TravellerCheck['warnings'] = [];
  if (!Array.isArray(list) || !list.length) return { errors: ['Add at least one traveller.'], warnings };
  if (list.length > 14) errors.push('Too many travellers in one request.');
  const lapCount = new Map<number, number>();
  list.forEach((t, i) => {
    const n = `Traveller ${i + 1}`;
    if (typeof t?.fullName !== 'string' || t.fullName.trim().length < 3) errors.push(`${n}: enter the full name as on the passport.`);
    if (!isDate(t?.dateOfBirth)) { errors.push(`${n}: enter the date of birth.`); return; }
    const age = ageOn(t.dateOfBirth, o.date);
    if (age < 0 || age > 120) { errors.push(`${n}: check the date of birth.`); return; }
    const real = typeForAge(age);
    if (t.type !== real) errors.push(`${n}: is ${age} on the trip date, so counts as ${real === 'adult' ? 'an adult' : `a ${real}`}.`);
    if (t.docType !== 'passport' && t.docType !== 'national_id') errors.push(`${n}: choose passport or national ID.`);
    else if (o.crossBorder && t.docType !== 'passport') errors.push(`${n}: a passport is needed for trips to Syria.`);
    if (typeof t.docNumber !== 'string' || !/^[A-Za-z0-9 ]{5,20}$/.test(t.docNumber.trim())) errors.push(`${n}: check the document number.`);
    if (!isDate(t.docExpiry)) errors.push(`${n}: enter the document expiry date.`);
    else if (t.docExpiry < addMonths(o.date, o.warnMonths)) {
      warnings.push({ idx: i, message: `${t.fullName ?? n}: the document expires on ${t.docExpiry}, less than ${o.warnMonths} months after the trip. Border staff may refuse it.` });
      if (t.responsibility !== true) errors.push(`${n}: tick "I take responsibility" for the document expiry.`);
    }
    if (t.contact != null && t.contact !== '' && !normalizePhone(t.contact) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(t.contact))) errors.push(`${n}: contact must be a phone number or email.`);
    if (t.type === 'baby') {
      if (!Number.isInteger(t.lapOf) || !list[t.lapOf!] || list[t.lapOf!].type !== 'adult') errors.push(`${n}: choose which adult the baby sits with.`);
      else lapCount.set(t.lapOf!, (lapCount.get(t.lapOf!) ?? 0) + 1);
    }
  });
  if (!list.some((t) => t.type === 'adult')) errors.push('At least one adult (18+) must travel.');
  if ([...lapCount.values()].some((c) => c > 1)) errors.push('Each adult can hold only one baby on their lap.');
  return { errors, warnings };
}

export const REJECT_REASONS = ['trip_full', 'pickup_too_far', 'cant_make_it', 'other'] as const;
