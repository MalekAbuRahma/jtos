import { randomUUID } from 'crypto';
import { addDays, jordanDate } from '../src/common/dates';
import { buildApp } from './helpers';

type T = Awaited<ReturnType<typeof buildApp>>;
let seq = 0;
const today = jordanDate();
export const S = (tok: string) => ({ Authorization: `Bearer ${tok}` });

/** Approved driver with an active car and valid documents (seeded directly), signed in. */
export async function approvedDriver(t: T, o: { seats?: number; type?: 'car' | 'van'; ratings?: number } = {}) {
  const phone = `+962781${String(seq++).padStart(6, '0')}`;
  const d = await t.db.insertInto('drivers').values({ phone, email: null, full_name: 'Ahmad Khalil', rating_avg: o.ratings ? '4.80' : null, rating_count: o.ratings ?? 0, status: 'approved' }).returning('id').executeTakeFirstOrThrow();
  await t.db.insertInto('vehicles').values({ driver_id: d.id, status: 'active', type: o.type ?? 'car', make: 'Hyundai', model: 'Elantra', year: 2021, colour: 'White', plate: `12-${seq}`, seats: o.seats ?? 4 }).execute();
  const blob = await t.db.insertInto('file_blobs').values({ owner_type: 'driver', owner_id: d.id, mime: 'image/jpeg', size_bytes: 3, sha256: 'x', data: Buffer.from([1, 2, 3]) }).returning('id').executeTakeFirstOrThrow();
  for (const type of ['licence', 'registration', 'insurance', 'id_document', 'face_photo'] as const)
    await t.db.insertInto('driver_documents').values({ driver_id: d.id, type, file_id: blob.id, status: 'approved', review_note: null, expiry_warned_at: null, expires_at: type === 'face_photo' ? null : addDays(today, 365) }).execute();
  const c = await t.http().post('/v1/driver/auth/code').send({ phone }).expect(200);
  const v = await t.http().post('/v1/driver/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode(phone) }).expect(200);
  return { id: d.id, phone, tok: v.body.token as string };
}

export const amman4Stops = (date: string, o: { times?: string[] } = {}) => {
  const tm = o.times ?? ['07:00', '07:30', '08:30', '11:30'];
  return {
    date, seatsOffered: 4, bookingType: 'both', wholePrice: 110000, responseWindowMinutes: 120,
    stops: [
      { city: 'AMM', spot: 'Abdali Bus Station, gate 3', time: tm[0], price: 30000 },
      { city: 'ZRQ', spot: 'New Zarqa roundabout', time: tm[1], price: 27000 },
      { city: 'IRB', spot: 'Irbid New Bus Station', time: tm[2], price: 20000 },
      { city: 'DAM', spot: 'Al-Samariyah station', time: tm[3] },
    ],
  };
};

export async function publishedTrip(t: T, driverTok: string, body: object) {
  const c = await t.http().post('/v1/driver/trips').set(S(driverTok)).send(body).expect(201);
  await t.http().post(`/v1/driver/trips/${c.body.id}/publish`).set(S(driverTok)).expect(200);
  return c.body.id as string;
}

/** A signed-up passenger. */
export async function passenger(t: T, name = 'Sara Mansour') {
  const phone = `+962771${String(seq++).padStart(6, '0')}`;
  const email = `p${seq}@example.com`;
  const c = await t.http().post('/v1/passenger/auth/code').send({ phone }).expect(200);
  const v = await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode(phone) }).expect(200);
  const s = await t.http().post('/v1/passenger/auth/signup').send({ signupToken: v.body.signupToken, fullName: name, email }).expect(200);
  const f = await t.http().post('/v1/passenger/auth/signup/verify-email').send({ emailTicket: s.body.emailTicket, code: t.lastCode(email) }).expect(200);
  const me = await t.http().get('/v1/passenger/me').set(S(f.body.token));
  return { id: me.body.id as string, phone, tok: f.body.token as string };
}

let docN = 1000000;
export const adult = (o: Record<string, unknown> = {}) => ({ type: 'adult', fullName: 'Sara Mansour', dateOfBirth: '1990-04-12', docType: 'passport', docNumber: `N${docN++}`, docExpiry: addDays(today, 2000), boardSeq: 1, ...o });
export const child = (o: Record<string, unknown> = {}) => ({ type: 'child', fullName: 'Lina Mansour', dateOfBirth: '2016-02-01', docType: 'passport', docNumber: `N${docN++}`, docExpiry: addDays(today, 2000), boardSeq: 1, ...o });
export const baby = (lapOf: number, o: Record<string, unknown> = {}) => ({ type: 'baby', fullName: 'Omar Mansour', dateOfBirth: addDays(today, -400), docType: 'passport', docNumber: `N${docN++}`, docExpiry: addDays(today, 2000), lapOf, ...o });

export function request(t: T, tok: string, body: object, key = randomUUID()) {
  return t.http().post('/v1/passenger/requests').set(S(tok)).set('Idempotency-Key', key).send({ consent: true, ...body });
}

/** A confirmed (cash) booking on a 4-stop trip; returns everything a trip-day test needs. */
export async function confirmedBooking(t: T, travellers: object[], o: { date?: string } = {}) {
  const d = await approvedDriver(t);
  const date = o.date ?? addDays(today, 30 + seq);
  const tripId = await publishedTrip(t, d.tok, amman4Stops(date));
  const p = await passenger(t);
  const r = await request(t, p.tok, { tripId, travellers }).expect(201);
  const a = await t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok)).expect(200);
  await t.http().post(`/v1/passenger/bookings/${a.body.bookingId}/complete`).set(S(p.tok)).send({ paymentMethod: 'cash' }).expect(200);
  const tr = await t.db.selectFrom('travellers').select(['id', 'idx', 'type']).where('request_id', '=', r.body.id).orderBy('idx').execute();
  return { d, p, tripId, requestId: r.body.id as string, bookingId: a.body.bookingId as string, travellerIds: tr.map((x) => x.id) };
}

/** Moves a trip to "now": stop i is at now + offsets[i] minutes. Stop 1 gets a map pin at Abdali. */
export async function shiftToNow(t: T, tripId: string, offsets = [10, 40, 100, 280]) {
  const at = (m: number) => new Date(Date.now() + m * 60_000);
  await t.db.updateTable('trips').set({ travel_date: jordanDate(at(offsets[0])) }).where('id', '=', tripId).execute();
  for (const [i, m] of offsets.entries()) await t.db.updateTable('trip_stops').set({ pickup_at: at(m) }).where('trip_id', '=', tripId).where('seq', '=', i + 1).execute();
  await t.db.updateTable('trip_stops').set({ lat: 31.9644, lng: 35.9101 }).where('trip_id', '=', tripId).where('seq', '=', 1).execute();
}
export const ABDALI = { lat: 31.9646, lng: 35.9104 };     // ~35 m from the pin
export const FAR = { lat: 31.9739, lng: 35.9101 };        // ~1 km away
