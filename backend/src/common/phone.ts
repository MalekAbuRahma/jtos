/** Accepts international format, e.g. +962791234567. Also accepts Jordan local 07XXXXXXXX. */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let p = input.replace(/[\s\-()]/g, '');
  if (/^07\d{8}$/.test(p)) p = '+962' + p.slice(1);
  if (p.startsWith('00')) p = '+' + p.slice(2);
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
