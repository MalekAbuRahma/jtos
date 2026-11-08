import { addDays, daysBetween } from '../common/dates';
import { DocType } from '../db/database';
import { SettingsValues } from '../settings/definitions';

export const DOC_LABELS: Record<DocType, string> = {
  licence: 'Driving licence', registration: 'Car registration', insurance: 'Insurance',
  face_photo: 'Face photo', id_document: 'ID card or passport', good_conduct: 'Good conduct certificate',
};
/** Documents with an expiry date the driver must enter (T-002 TC-03). */
export const EXPIRING: DocType[] = ['licence', 'registration', 'insurance', 'id_document'];
export const ALL_TYPES = Object.keys(DOC_LABELS) as DocType[];

export function requiredTypes(v: SettingsValues): DocType[] {
  const base: DocType[] = ['licence', 'registration', 'insurance', 'face_photo', 'id_document'];
  return v.goodConductRequired ? [...base, 'good_conduct'] : base;
}

export interface VehicleIn { type: 'car' | 'van'; make: string; model: string; year: number; colour: string; plate: string; seats: number; }

/** Problems with a vehicle in plain words (T-002 TC-06/07/08). */
export function vehicleProblems(v: Partial<VehicleIn>, s: SettingsValues, today: string): string[] {
  const out: string[] = [];
  if (v.type !== 'car' && v.type !== 'van') out.push('Vehicle type must be car or van.');
  for (const f of ['make', 'model', 'colour', 'plate'] as const) if (typeof v[f] !== 'string' || !(v[f] as string).trim()) out.push(`Enter the ${f}.`);
  const year = Number(today.slice(0, 4));
  const maxAge = s.carMaxAgeYears as number;
  if (!Number.isInteger(v.year) || (v.year as number) > year + 1) out.push('Enter a valid model year.');
  else if (year - (v.year as number) > maxAge) out.push(`The car must be ${maxAge} years old or newer (${year - maxAge} or later).`);
  const max = v.type === 'van' ? (s.vanMaxSeats as number) : (s.carMaxSeats as number);
  if (!Number.isInteger(v.seats) || (v.seats as number) < 1 || (v.seats as number) > max) out.push(`A ${v.type === 'van' ? 'van' : 'car'} can offer 1 to ${max} passenger seats.`);
  return out;
}

export interface Check { key: string; label: string; ok: boolean; detail?: string; }

export function applicationChecks(o: {
  fullName: string | null;
  vehicle: Partial<VehicleIn> | null;
  docs: Partial<Record<DocType, { expires_at: string | null }>>;
  settings: SettingsValues;
  today: string;
}): Check[] {
  const checks: Check[] = [];
  checks.push({ key: 'name', label: 'Full name entered', ok: !!o.fullName?.trim() });
  for (const t of requiredTypes(o.settings)) {
    const d = o.docs[t];
    checks.push({ key: `doc_${t}`, label: `${DOC_LABELS[t]} uploaded`, ok: !!d });
    if (d && EXPIRING.includes(t)) {
      if (!d.expires_at) checks.push({ key: `exp_${t}`, label: `${DOC_LABELS[t]} expiry date entered`, ok: false });
      else checks.push({ key: `exp_${t}`, label: `${DOC_LABELS[t]} not expired`, ok: d.expires_at >= o.today, detail: `Expires ${d.expires_at}` });
    }
  }
  const vp = o.vehicle ? vehicleProblems(o.vehicle, o.settings, o.today) : ['Add your vehicle.'];
  checks.push({ key: 'vehicle', label: 'Vehicle meets the rules', ok: vp.length === 0, detail: vp.join(' ') || undefined });
  return checks;
}

/** Plain-words warnings shown to staff and driver, e.g. "Insurance expires in 20 days". */
export function expiryWarnings(docs: { type: DocType; expires_at: string | null }[], today: string, warnDays: number): string[] {
  return docs.filter((d) => d.expires_at).flatMap((d) => {
    const left = daysBetween(today, d.expires_at!);
    if (left < 0) return [`${DOC_LABELS[d.type]} expired on ${d.expires_at}`];
    if (d.expires_at! <= addDays(today, warnDays)) return [`${DOC_LABELS[d.type]} expires in ${left} day${left === 1 ? '' : 's'}`];
    return [];
  });
}
