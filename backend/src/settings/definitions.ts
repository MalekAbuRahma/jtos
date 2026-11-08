/**
 * Every admin setting with its default (owner decisions, 8 Nov 2026) and allowed range.
 * Durations are minutes unless the key says otherwise.
 */
export interface SettingDef {
  key: string;
  group: 'Booking' | 'Trip day' | 'Ratings' | 'Accounts' | 'Drivers' | 'Money' | 'Privacy';
  label: string;
  type: 'int' | 'decimal' | 'bool';
  default: number | boolean;
  min?: number;
  max?: number;
  unit?: string;
}

export const SETTINGS: SettingDef[] = [
  { key: 'driverResponseMinMinutes', group: 'Booking', label: 'Driver response time — shortest', type: 'int', default: 15, min: 5, max: 1440, unit: 'min' },
  { key: 'driverResponseMaxMinutes', group: 'Booking', label: 'Driver response time — longest', type: 'int', default: 1440, min: 15, max: 2880, unit: 'min' },
  { key: 'waitingRequestsMax', group: 'Booking', label: 'Waiting requests per passenger', type: 'int', default: 3, min: 1, max: 10 },
  { key: 'bookingCutoffMinutes', group: 'Booking', label: 'Booking closes before each stop', type: 'int', default: 60, min: 15, max: 720, unit: 'min' },
  { key: 'whatsappBackupMinutes', group: 'Booking', label: 'WhatsApp backup if push not opened', type: 'int', default: 60, min: 15, max: 360, unit: 'min' },
  { key: 'rejectionWarningPerTrip', group: 'Booking', label: 'Driver rejection warning per trip', type: 'int', default: 3, min: 1, max: 10 },
  { key: 'arrivalRadiusMeters', group: 'Trip day', label: 'Arrival check distance', type: 'int', default: 300, min: 100, max: 1000, unit: 'm' },
  { key: 'stopWaitMinutes', group: 'Trip day', label: 'Waiting time at a stop', type: 'int', default: 15, min: 5, max: 30, unit: 'min' },
  { key: 'driverLateMinutes', group: 'Trip day', label: 'Driver late after', type: 'int', default: 30, min: 15, max: 90, unit: 'min' },
  { key: 'lateWarningCount', group: 'Trip day', label: 'Late-driver warning after', type: 'int', default: 3, min: 1, max: 10 },
  { key: 'lateWarningWindowDays', group: 'Trip day', label: 'Late-driver warning window', type: 'int', default: 30, min: 7, max: 90, unit: 'days' },
  { key: 'noShowWarningCount', group: 'Trip day', label: 'No-show warning (passenger) after', type: 'int', default: 3, min: 1, max: 10 },
  { key: 'cancellationWarningAfter', group: 'Ratings', label: 'Cancellation warning after', type: 'int', default: 2, min: 1, max: 5 },
  { key: 'ratingWindowHours', group: 'Ratings', label: 'Rating window after trip', type: 'int', default: 48, min: 24, max: 168, unit: 'h' },
  { key: 'ratingWarnBelow', group: 'Ratings', label: 'Rating warning below', type: 'decimal', default: 4.0, min: 3.0, max: 4.5 },
  { key: 'ratingReviewBelow', group: 'Ratings', label: 'Admin review below', type: 'decimal', default: 3.5, min: 2.5, max: 4.0 },
  { key: 'loginCodeMinutes', group: 'Accounts', label: 'Login code valid for', type: 'int', default: 5, min: 2, max: 15, unit: 'min' },
  { key: 'loginCodeMaxResends', group: 'Accounts', label: 'Login code resends', type: 'int', default: 3, min: 1, max: 5 },
  { key: 'loginLockMinutes', group: 'Accounts', label: 'Wait after too many tries', type: 'int', default: 30, min: 5, max: 120, unit: 'min' },
  { key: 'documentWarningDays', group: 'Drivers', label: 'Document expiry warning', type: 'int', default: 30, min: 7, max: 90, unit: 'days' },
  { key: 'carMaxAgeYears', group: 'Drivers', label: 'Car maximum age', type: 'int', default: 10, min: 1, max: 25, unit: 'years' },
  { key: 'carMaxSeats', group: 'Drivers', label: 'Car seats (max)', type: 'int', default: 4, min: 1, max: 4 },
  { key: 'vanMaxSeats', group: 'Drivers', label: 'Van seats (max)', type: 'int', default: 7, min: 5, max: 7 },
  { key: 'goodConductRequired', group: 'Drivers', label: 'Good conduct certificate required', type: 'bool', default: false },
  { key: 'driverReviewTargetHours', group: 'Drivers', label: 'Application review target', type: 'int', default: 48, min: 12, max: 168, unit: 'h' },
  { key: 'maxActiveTrips', group: 'Drivers', label: 'Active trips per driver', type: 'int', default: 10, min: 1, max: 50 },
  { key: 'passportWarningMonths', group: 'Privacy', label: 'Passport expiry warning', type: 'int', default: 3, min: 0, max: 12, unit: 'months' },
  { key: 'travellerDataDeleteDays', group: 'Privacy', label: 'Delete traveller documents after trip', type: 'int', default: 30, min: 7, max: 90, unit: 'days' },
  { key: 'commissionPercent', group: 'Money', label: 'Commission', type: 'decimal', default: 0, min: 0, max: 50, unit: '%' },
];

export type SettingsValues = Record<string, number | boolean>;
export const DEFAULTS: SettingsValues = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));

/** Returns a list of problems in plain words; empty means valid. */
export function validate(values: SettingsValues): string[] {
  const errors: string[] = [];
  for (const def of SETTINGS) {
    const v = values[def.key];
    if (def.type === 'bool') {
      if (typeof v !== 'boolean') errors.push(`${def.label}: must be yes or no.`);
      continue;
    }
    if (typeof v !== 'number' || Number.isNaN(v)) { errors.push(`${def.label}: must be a number.`); continue; }
    if (def.type === 'int' && !Number.isInteger(v)) errors.push(`${def.label}: must be a whole number.`);
    if (def.type === 'decimal' && Math.round(v * 100) !== v * 100) errors.push(`${def.label}: at most 2 decimals.`);
    if (v < def.min! || v > def.max!) errors.push(`${def.label}: allowed ${def.min} – ${def.max}${def.unit ? ' ' + def.unit : ''}.`);
  }
  if ((values.driverResponseMinMinutes as number) > (values.driverResponseMaxMinutes as number))
    errors.push('Driver response time: shortest must not be longer than longest.');
  if ((values.ratingReviewBelow as number) > (values.ratingWarnBelow as number))
    errors.push('Admin review level must not be higher than the warning level.');
  return errors;
}
