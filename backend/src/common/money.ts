/** Money is integer fils (ADR 0006). 1 JOD = 1000 fils. */
export const toFils = (jod: number) => Math.round(jod * 1000);
export const formatJod = (fils: number) => `JOD ${(fils / 1000).toFixed(3)}`;
/** Accepts fils as an integer from the apps. */
export function isFils(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000_000;
}
