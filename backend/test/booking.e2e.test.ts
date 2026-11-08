import { randomUUID } from 'crypto';
import { BookingService } from '../src/booking/booking.service';
import { addDays, jordanDate } from '../src/common/dates';
import { addMonths } from '../src/booking/rules';
import { adult, amman4Stops, approvedDriver, baby, child, passenger, publishedTrip, request, S } from './fixtures';
import { buildApp, resetDb } from './helpers';

/** Sam's test cases T-013–T-018 (booking), automated. */
describe('Booking: request, accept, reject, withdraw, expire, limits', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  const today = jordanDate();
  let dayN = 3;
  const nextDay = () => addDays(today, dayN++);
  beforeAll(async () => { await resetDb(); t = await buildApp(); });
  afterAll(() => t.close());

  async function setup(o: { seats?: number } = {}) {
    const d = await approvedDriver(t, { seats: o.seats ?? 4 });
    const date = nextDay();
    const trip = await publishedTrip(t, d.tok, { ...amman4Stops(date), seatsOffered: o.seats ?? 4 });
    return { d, trip, date };
  }
  const tripRow = (id: string) => t.db.selectFrom('trips').select(['seats_held', 'seats_booked', 'whole_taken']).where('id', '=', id).executeTakeFirstOrThrow();

  // ---------- T-014 ----------
  it('T-014 TC-01: 2 adults + 1 lap baby from Amman → JOD 60.000; the baby is free and takes no seat', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult(), adult({ fullName: 'Omar Mansour', dateOfBirth: '1988-01-01' }), baby(0)] }).expect(201);
    expect(r.body).toMatchObject({ status: 'waiting', total: 60000, seats: 2, headCount: 3 });
    expect(r.body.travellers.map((x: any) => x.price)).toEqual([30000, 30000, 0]);
    expect(r.body.travellers[0].document).toMatch(/^passport •+\d{3}$/);
    expect(await tripRow(trip)).toMatchObject({ seats_held: 2 });
  });

  it('T-014 TC-02/03: a child alone, or 2 babies with 1 adult, are refused', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const a = await request(t, p.tok, { tripId: trip, travellers: [child()] }).expect(400);
    expect(a.body.message).toMatch(/At least one adult/);
    const b = await request(t, p.tok, { tripId: trip, travellers: [adult(), baby(0), baby(0)] }).expect(400);
    expect(b.body.message).toMatch(/only one baby/);
  });

  it('T-014 TC-04: a traveller getting on at Irbid pays the Irbid price (JOD 20.000)', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult({ boardSeq: 3, boardSpot: 'Near University Street gate' })] }).expect(201);
    expect(r.body.total).toBe(20000);
    expect(r.body.travellers[0].boardSpot).toBe('Near University Street gate');
  });

  it('T-014 TC-05: passport expiring 2 months after the trip → warning; needs "I take responsibility"', async () => {
    const { trip, date } = await setup();
    const p = await passenger(t);
    const exp = addMonths(date, 2);
    const a = await request(t, p.tok, { tripId: trip, travellers: [adult({ docExpiry: exp })] }).expect(400);
    expect(a.body.message).toMatch(/I take responsibility/);
    const b = await request(t, p.tok, { tripId: trip, travellers: [adult({ docExpiry: exp, responsibility: true })] }).expect(201);
    expect(b.body.warnings[0].message).toMatch(/less than 3 months after the trip/);
  });

  it('T-014 TC-06: a national ID on a trip to Damascus is refused', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult({ docType: 'national_id' })] }).expect(400);
    expect(r.body.message).toMatch(/passport is needed/);
  });

  it('T-014 TC-07/09: the request keeps its saved total even if prices change later; prices from the app are ignored', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, total: 1, travellers: [{ ...adult(), price: 1 }] }).expect(201);
    expect(r.body.total).toBe(30000);
    await t.db.updateTable('trip_stops').set({ section_price_fils: 33000 }).where('trip_id', '=', trip).where('seq', '=', 1).execute();
    const v = await t.http().get(`/v1/passenger/requests/${r.body.id}`).set(S(p.tok)).expect(200);
    expect(v.body.terms.total).toBe(30000);
    expect(v.body.terms.prices[0]).toEqual({ seq: 1, city: 'AMM', price: 30000 });
  });

  it('T-014: consent to keep documents is required', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    await t.http().post('/v1/passenger/requests').set(S(p.tok)).set('Idempotency-Key', randomUUID()).send({ tripId: trip, travellers: [adult()] }).expect(400);
  });

  it('T-014: whole vehicle needs a head count; traveller forms are optional', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, kind: 'whole', headCount: 4 }).expect(201);
    expect(r.body).toMatchObject({ kind: 'whole', total: 110000, seats: 4 });
    expect(await tripRow(trip)).toMatchObject({ seats_held: 4, whole_taken: true });
  });

  // ---------- T-013 ----------
  it('T-013 TC-01: two passengers ask for the last seat at the same moment → only one gets it', async () => {
    const { trip } = await setup({ seats: 1 });
    const [a, b] = [await passenger(t), await passenger(t)];
    const res = await Promise.all([request(t, a.tok, { tripId: trip, travellers: [adult()] }), request(t, b.tok, { tripId: trip, travellers: [adult()] })]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.message).toBe('This seat is no longer available.');
    expect(await tripRow(trip)).toMatchObject({ seats_held: 1 });
  });

  it('T-013 TC-02 / T-016: rejecting releases the seat at once', async () => {
    const { d, trip } = await setup({ seats: 1 });
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    await t.http().post(`/v1/driver/requests/${r.body.id}/reject`).set(S(d.tok)).send({ reason: 'pickup_too_far' }).expect(200);
    expect(await tripRow(trip)).toMatchObject({ seats_held: 0 });
  });

  // ---------- T-015 ----------
  it('T-015 TC-01: driver sees passports, accepts; passenger completes with cash → confirmed', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const tr = adult();
    const r = await request(t, p.tok, { tripId: trip, travellers: [tr] }).expect(201);
    const v = await t.http().get(`/v1/driver/requests/${r.body.id}`).set(S(d.tok)).expect(200);
    expect(v.body.travellers[0]).toMatchObject({ fullName: 'Sara Mansour', docNumber: tr.docNumber, getsOnAt: 'Amman', time: '07:00' });
    const a = await t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok)).expect(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ to: p.phone, template: 'request_accepted' });
    await t.http().post(`/v1/passenger/bookings/${a.body.bookingId}/complete`).set(S(p.tok)).send({ paymentMethod: 'cash' }).expect(200);
    const b = await t.http().get(`/v1/passenger/bookings/${a.body.bookingId}`).set(S(p.tok)).expect(200);
    expect(b.body).toMatchObject({ status: 'confirmed', paymentMethod: 'cash', total: 30000 });
    expect(await tripRow(trip)).toMatchObject({ seats_held: 0, seats_booked: 1 });
  });

  it('T-015 TC-02 / T-016 TC-04: accepting after the deadline is refused and the seat is released', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    await t.db.updateTable('booking_requests').set({ deadline_at: new Date(Date.now() - 1000) }).where('id', '=', r.body.id).execute();
    const a = await t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok)).expect(409);
    expect(a.body.code).toBe('REQUEST_EXPIRED');
    expect(await tripRow(trip)).toMatchObject({ seats_held: 0, seats_booked: 0 });
  });

  it('T-015 TC-03: accept tapped twice → one booking', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    const [a, b] = await Promise.all([1, 2].map(() => t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok))));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.bookingId).toBe(b.body.bookingId);
    expect(await tripRow(trip)).toMatchObject({ seats_booked: 1 });
  });

  it('T-015 TC-04/05: reject needs a reason; the passenger never sees it', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    await t.http().post(`/v1/driver/requests/${r.body.id}/reject`).set(S(d.tok)).send({}).expect(400);
    await t.http().post(`/v1/driver/requests/${r.body.id}/reject`).set(S(d.tok)).send({ reason: 'cant_make_it', note: 'Family emergency' }).expect(200);
    const v = await t.http().get(`/v1/passenger/requests/${r.body.id}`).set(S(p.tok)).expect(200);
    expect(v.body.message).toBe('Request not accepted.');
    expect(JSON.stringify(v.body)).not.toMatch(/cant_make_it|emergency/i);
  });

  it('T-015 TC-06: from the 4th rejection on one trip the driver is warned, but it still works', async () => {
    const { d, trip } = await setup();
    let last: any;
    for (let i = 0; i < 4; i++) {
      const p = await passenger(t);
      const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
      last = await t.http().post(`/v1/driver/requests/${r.body.id}/reject`).set(S(d.tok)).send({ reason: 'other' }).expect(200);
      if (i < 3) expect(last.body.warning).toBeUndefined();
    }
    expect(last.body.warning).toMatch(/rejected 4 requests/);
  });

  it('T-015 TC-08: no reaction to the push for 1 hour → WhatsApp backup to the driver (once)', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    const svc = t.app.get(BookingService);
    await t.db.updateTable('booking_requests').set({ created_at: new Date(Date.now() - 61 * 60_000) } as any).where('id', '=', r.body.id).execute();
    expect(await svc.whatsappBackups()).toBeGreaterThanOrEqual(1);
    expect(t.messaging.sent.some((m) => m.to === d.phone && m.channel === 'whatsapp')).toBe(true);
    const before = t.messaging.sent.length;
    await svc.whatsappBackups();
    expect(t.messaging.sent.filter((m, i) => i >= before && m.to === d.phone)).toHaveLength(0);
  });

  it('T-015 TC-09: "Pay online" cannot be chosen in Release 1', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    const a = await t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok)).expect(200);
    const x = await t.http().post(`/v1/passenger/bookings/${a.body.bookingId}/complete`).set(S(p.tok)).send({ paymentMethod: 'online' }).expect(400);
    expect(x.body.code).toBe('COMING_SOON');
  });

  // ---------- T-016 ----------
  it('T-016 TC-01/06: withdraw frees the seats at once and no longer counts as waiting', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult(), adult({ fullName: 'Omar Mansour' })] }).expect(201);
    await t.http().post(`/v1/passenger/requests/${r.body.id}/withdraw`).set(S(p.tok)).expect(200);
    expect(await tripRow(trip)).toMatchObject({ seats_held: 0 });
  });

  it('T-016 TC-02/03 / T-013 TC-06: expiry at the deadline releases seats; requesting again straight away is allowed', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    await t.db.updateTable('booking_requests').set({ deadline_at: new Date(Date.now() - 1000) }).where('id', '=', r.body.id).execute();
    expect(await t.app.get(BookingService).expireDue()).toBeGreaterThanOrEqual(1);
    expect(t.messaging.sent.some((m) => m.to === p.phone && m.template === 'request_expired')).toBe(true);
    expect(await tripRow(trip)).toMatchObject({ seats_held: 0 });
    await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
  });

  it('T-016 TC-05: accept and withdraw at the same moment → one wins, numbers stay right', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    const [a, w] = await Promise.all([
      t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok)),
      t.http().post(`/v1/passenger/requests/${r.body.id}/withdraw`).set(S(p.tok)),
    ]);
    expect([a.status, w.status].sort()).toEqual([200, 409]);
    const row = await tripRow(trip);
    expect(row.seats_held + row.seats_booked).toBe(a.status === 200 ? 1 : 0);
  });

  // ---------- T-018 ----------
  it('T-018 TC-01/07: the 4th waiting request is refused with a plain message', async () => {
    const p = await passenger(t);
    for (let i = 0; i < 3; i++) { const { trip } = await setup(); await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201); }
    const { trip } = await setup();
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(409);
    expect(r.body).toEqual({ code: 'WAITING_LIMIT', message: 'You already have 3 waiting requests. Withdraw one to send a new request.' });
  });

  it('T-018 TC-02/03/04: same destination same day refused; return trip allowed; clashing times refused', async () => {
    const d1 = await approvedDriver(t), d2 = await approvedDriver(t), d3 = await approvedDriver(t);
    const date = nextDay();
    const a = await publishedTrip(t, d1.tok, amman4Stops(date));
    const b = await publishedTrip(t, d2.tok, amman4Stops(date, { times: ['13:00', '13:30', '14:30', '17:30'] }));
    const back = await publishedTrip(t, d3.tok, { date, seatsOffered: 4, bookingType: 'seats', responseWindowMinutes: 120,
      stops: [{ city: 'DAM', spot: 'Samariyah', time: '18:30', price: 30000 }, { city: 'AMM', spot: 'Abdali', time: '22:30' }] });
    const p = await passenger(t);
    await request(t, p.tok, { tripId: a, travellers: [adult()] }).expect(201);
    expect((await request(t, p.tok, { tripId: b, travellers: [adult()] }).expect(409)).body.code).toBe('SAME_ROUTE_DAY');
    await request(t, p.tok, { tripId: back, travellers: [adult()] }).expect(201);
    const d4 = await approvedDriver(t);
    const clash = await publishedTrip(t, d4.tok, { date, seatsOffered: 4, bookingType: 'seats', responseWindowMinutes: 120,
      stops: [{ city: 'AMM', spot: 'Abdali', time: '09:00', price: 6000 }, { city: 'IRB', spot: 'Irbid', time: '10:30' }] });
    expect((await request(t, p.tok, { tripId: clash, travellers: [adult()] }).expect(409)).body.code).toBe('TIME_CLASH');
  });

  it('T-018 TC-05: a retry with the same key returns the same request and holds seats once', async () => {
    const { trip } = await setup();
    const p = await passenger(t);
    const key = randomUUID();
    const body = { tripId: trip, travellers: [adult({ docNumber: 'X7777777' })] };
    const a = await request(t, p.tok, body, key).expect(201);
    const b = await request(t, p.tok, body, key).expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await tripRow(trip)).toMatchObject({ seats_held: 1 });
  });

  it('the same traveller cannot be booked twice on one trip', async () => {
    const { trip } = await setup();
    const [p1, p2] = [await passenger(t), await passenger(t)];
    await request(t, p1.tok, { tripId: trip, travellers: [adult({ docNumber: 'Z1112223' })] }).expect(201);
    expect((await request(t, p2.tok, { tripId: trip, travellers: [adult({ docNumber: 'z111 2223' })] }).expect(409)).body.code).toBe('TRAVELLER_ALREADY_BOOKED');
  });

  // ---------- T-017 (booking page basics) ----------
  it('T-017 TC-02/03: plate hidden until the booking step is completed; another passenger cannot open it', async () => {
    const { d, trip } = await setup();
    const [p, other] = [await passenger(t), await passenger(t)];
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult({ contact: '+962790000111' })] }).expect(201);
    const a = await t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok)).expect(200);
    const before = await t.http().get(`/v1/passenger/bookings/${a.body.bookingId}`).set(S(p.tok)).expect(200);
    expect(before.body.vehicle.plate).toBeNull();
    await t.http().get(`/v1/passenger/bookings/${a.body.bookingId}`).set(S(other.tok)).expect(404);
    await t.http().post(`/v1/passenger/bookings/${a.body.bookingId}/complete`).set(S(p.tok)).send({ paymentMethod: 'cash' }).expect(200);
    const after = await t.http().get(`/v1/passenger/bookings/${a.body.bookingId}`).set(S(p.tok)).expect(200);
    expect(after.body.vehicle.plate).toMatch(/^12-/);
    expect(after.body.chatOpen).toBe(true);
    expect(t.messaging.sent.some((m) => m.to === '+962790000111' && m.template === 'booked_by')).toBe(true);
  });

  it("drivers only see requests for their own trips", async () => {
    const { trip } = await setup();
    const other = await approvedDriver(t);
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    await t.http().get(`/v1/driver/requests/${r.body.id}`).set(S(other.tok)).expect(404);
    await t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(other.tok)).expect(404);
  });

  it('T-011 TC-07: when the driver cancels the trip, passengers are told and nothing is owed', async () => {
    const { d, trip } = await setup();
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    const a = await t.http().post(`/v1/driver/requests/${r.body.id}/accept`).set(S(d.tok)).expect(200);
    await t.http().post(`/v1/driver/trips/${trip}/cancel`).set(S(d.tok)).send({ reason: 'Car broke down' }).expect(200);
    expect((await t.http().get(`/v1/passenger/bookings/${a.body.bookingId}`).set(S(p.tok))).body.status).toBe('cancelled');
    expect(t.messaging.sent.some((m) => m.to === p.phone && m.template === 'trip_cancelled')).toBe(true);
  });
});
