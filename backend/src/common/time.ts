/**
 * Jordan (and Syria) use UTC+3 all year since 2022. Stop times entered as local "HH:MM"
 * on the trip date are stored as UTC instants.
 */
export function jordanDateTime(date: string, hhmm: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  const d = new Date(`${date}T${hhmm}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function jordanHHMM(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
