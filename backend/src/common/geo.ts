/** Distance in metres between two points (haversine). */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Team decision (Prof, 9 Nov): stops without a map pin are checked against the city centre. */
export const CITY_RADIUS_M = 15_000;
