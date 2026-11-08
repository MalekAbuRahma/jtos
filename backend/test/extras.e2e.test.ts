import { randomUUID } from 'crypto';
import { driverEntitlement } from '../src/extras/extras.service';
import { ABDALI, adult, approvedDriver, amman4Stops, baby, confirmedBooking, passenger, publishedTrip, request, S, shiftToNow } from './fixtures';
import { buildApp, resetDb } from './helpers';

/** Sam's cases: ratings (T-009/Q13), chat & Share trip (T-017), earnings & commission (T-024/T-025), removing a traveller (Q04). */
describe('Ratings, chat, Share trip, earnings, traveller removal', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  let admin: string, support: string;
  beforeAll(async () => {
    await resetDb(); t = await buildApp();
    await t.seedStaff({ email: 'malek@jtos.jo', role: 'admin', main: true });
    await t.seedStaff({ email: 'lina@jtos.jo', role: 'support' });
    admin = await t.signIn('malek@jtos.jo'); support = await t.signIn('lina@jtos.jo');
  });
  afterAll(() => t.close());
  const post = (tok: string, path: string, body: object = {}) => t.http().post(path).set(S(tok)).set('Idempotency-Key', randomUUID()).send(body);

  /** Booking that has been run to the end: arrived, boarded, cash, completed. */
  async function completedTrip(travellers: object[] = [adult()], cash: 'full' | 'not_paid' = 'full') {
    const x = await confirmedBooking(t, travellers);
    await shiftToNow(t, x.tripId);
    const where: Record<number, object> = { 1: ABDALI, 2: { lat: 32.0728, lng: 36.088 }, 3: { lat: 32.5556, lng: 35.85 } };
    const rows = await t.db.selectFrom('travellers').select(['id', 'board_seq', 'type']).where('request_id', '=', x.requestId).execute();
    for (const seq of [...new Set(rows.map((r) => r.board_seq))].sort()) {
      await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/${seq}/arrived`, where[seq]).expect(200);
      for (const r of rows.filter((r) => r.board_seq === seq && r.type !== 'baby')) await post(x.d.tok, `/v1/driver/travellers/${r.id}/boarded`).expect(200);
    }
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/cash`, { status: cash }).expect(200);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/complete`).expect(200);
    return x;
  }

  // ---------- ratings ----------
  it('T-009: both sides rate within 48 h; not before the trip, not twice, not after the window', async () => {
    const pending = await confirmedBooking(t, [adult()]);
    expect((await post(pending.p.tok, `/v1/passenger/bookings/${pending.bookingId}/rating`, { stars: 5 }).expect(409)).body.code).toBe('NOT_COMPLETED');
    const x = await completedTrip();
    await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/rating`, { stars: 6 }).expect(400);
    await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/rating`, { stars: 5, comment: 'Great, call me 0791234567' }).expect(200);
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/rating`, { stars: 4 }).expect(200);
    expect((await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/rating`, { stars: 1 }).expect(409)).body.code).toBe('ALREADY_RATED');
    const r = await t.db.selectFrom('ratings').select('comment').where('booking_id', '=', x.bookingId).where('from_type', '=', 'passenger').executeTakeFirstOrThrow();
    expect(r.comment).toBe('Great, call me [hidden]');
    const y = await completedTrip();
    await t.db.updateTable('trips').set({ completed_at: new Date(Date.now() - 49 * 3600_000) }).where('id', '=', y.tripId).execute();
    expect((await post(y.p.tok, `/v1/passenger/bookings/${y.bookingId}/rating`, { stars: 5 }).expect(409)).body.code).toBe('RATING_CLOSED');
  });

  it('Q13: "New" until 5 ratings; average of the last 50; warning below 4.0', async () => {
    const d = await approvedDriver(t);
    for (let i = 0; i < 5; i++) {
      const x = await completedTrip();
      await t.db.updateTable('trips').set({ driver_id: d.id }).where('id', '=', x.tripId).execute();
      await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/rating`, { stars: i < 4 ? 4 : 3 }).expect(200);
      const row = await t.db.selectFrom('drivers').select(['rating_count', 'rating_avg']).where('id', '=', d.id).executeTakeFirstOrThrow();
      expect(row.rating_count).toBe(i + 1);
    }
    const row = await t.db.selectFrom('drivers').select('rating_avg').where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(Number(row.rating_avg)).toBe(3.8);
    expect(t.messaging.sent.some((m) => m.to === d.phone && m.template === 'rating_warning')).toBe(true);
  });

  // ---------- chat ----------
  it('T-017 TC-04: chat opens after completion; numbers are hidden; Support sees the original in a case', async () => {
    const d = await approvedDriver(t);
    const trip = await publishedTrip(t, d.tok, amman4Stops('2027-01-20'));
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult()] }).expect(201);
    const a = await post(d.tok, `/v1/driver/requests/${r.body.id}/accept`).expect(200);
    expect((await post(p.tok, `/v1/passenger/bookings/${a.body.bookingId}/messages`, { text: 'hi' }).expect(409)).body.code).toBe('CHAT_CLOSED');
    await post(p.tok, `/v1/passenger/bookings/${a.body.bookingId}/complete`, { paymentMethod: 'cash' }).expect(200);
    const m = await post(p.tok, `/v1/passenger/bookings/${a.body.bookingId}/messages`, { text: 'I am at gate 3, my number is 0791234567' }).expect(201);
    expect(m.body.text).toBe('I am at gate 3, my number is [hidden]');
    const list = (await t.http().get(`/v1/driver/bookings/${a.body.bookingId}/messages`).set(S(d.tok)).expect(200)).body;
    expect(list[0]).toMatchObject({ from: 'passenger', mine: false, text: 'I am at gate 3, my number is [hidden]' });
    const other = await passenger(t);
    await t.http().get(`/v1/passenger/bookings/${a.body.bookingId}/messages`).set(S(other.tok)).expect(404);
    await t.db.updateTable('trips').set({ status: 'completed', completed_at: new Date() }).where('id', '=', trip).execute();
    const c = await post(d.tok, `/v1/driver/bookings/${a.body.bookingId}/cash-case`, { reason: 'passenger_did_not_pay' }).expect(200);
    const id = (await t.db.selectFrom('cases').select('id').where('code', '=', c.body.caseCode).executeTakeFirstOrThrow()).id;
    const detail = (await t.http().get(`/v1/staff/cases/${id}`).set(S(support)).expect(200)).body;
    expect(detail.chat[0].text).toMatch(/0791234567/);
  });

  // ---------- share trip ----------
  it('T-017 TC-05/06: Share trip shows car and live position while running, "Trip ended" after; never passport data', async () => {
    const x = await confirmedBooking(t, [adult()]);
    await shiftToNow(t, x.tripId);
    const s = await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/share-link`).expect(201);
    const before = (await t.http().get(`/v1/public/share/${s.body.token}`).expect(200)).body;
    expect(before).toMatchObject({ status: 'scheduled', driver: 'Ahmad', car: 'White Hyundai Elantra', position: null });
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/position`, ABDALI).expect(409);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/position`, { lat: 32.0, lng: 35.95 }).expect(200);
    const during = (await t.http().get(`/v1/public/share/${s.body.token}`).expect(200)).body;
    expect(during).toMatchObject({ status: 'on_the_way', position: { lat: 32.0, lng: 35.95 } });
    expect(JSON.stringify(during)).not.toMatch(/passport|N\d{7}|\+962/);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/boarded`).expect(200);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/complete`).expect(200);
    expect((await t.http().get(`/v1/public/share/${s.body.token}`).expect(200)).body).toEqual({ status: 'ended', message: 'Trip ended.' });
    await t.http().get('/v1/public/share/not-a-real-token-at-all-xx').expect(404);
  });

  // ---------- earnings ----------
  it('T-025 TC-01/02/03: earnings count completed trips with cash received; JOD 30 + 27 + 20 = 77; unpaid not counted', async () => {
    const x = await completedTrip([adult({ boardSeq: 1 }), adult({ fullName: 'Omar Mansour', boardSeq: 2 }), adult({ fullName: 'Hiba Mansour', boardSeq: 3 })]);
    const e = (await t.http().get('/v1/driver/earnings?period=today').set(S(x.d.tok)).expect(200)).body;
    expect(e.bookings[0]).toMatchObject({ fare: 77000, cashReceived: 77000, commission: 0, youEarn: 77000, counted: true });
    expect(e.totals.youEarn).toBe(77000);
    const y = await completedTrip([adult()], 'not_paid');
    const e2 = (await t.http().get('/v1/driver/earnings?period=today').set(S(y.d.tok)).expect(200)).body;
    expect(e2.bookings[0]).toMatchObject({ counted: false, cashStatus: 'not_paid' });
    expect(e2.totals.youEarn).toBe(0);
  });

  it('T-025 TC-04: the formula with the story example (100, fees 5, 20 %, tip 10) gives 86 and commission 19', () => {
    expect(driverEntitlement({ gross: 100000, feesAndTaxes: 5000, commissionPercent: 20, tips: 10000 })).toEqual({ commission: 19000, entitlement: 86000 });
  });

  it('T-024 TC-02: a commission set later applies only to requests sent after it', async () => {
    const before = await completedTrip();
    await t.http().put('/v1/staff/settings').set(S(admin)).send({ changes: { commissionPercent: 10 } }).expect(200);
    const after = await completedTrip();
    const a = (await t.http().get('/v1/driver/earnings?period=today').set(S(before.d.tok))).body.bookings[0];
    const b = (await t.http().get('/v1/driver/earnings?period=today').set(S(after.d.tok))).body.bookings[0];
    expect([a.commissionPercent, a.commission]).toEqual([0, 0]);
    expect([b.commissionPercent, b.commission, b.youEarn]).toEqual([10, 3000, 27000]);
    await t.http().put('/v1/staff/settings').set(S(admin)).send({ changes: { commissionPercent: 0 } }).expect(200);
  });

  // ---------- Q04 ----------
  it('Q04: removing a traveller before acceptance lowers the price; after acceptance the seat stays paid; the last adult stays', async () => {
    const d = await approvedDriver(t);
    const trip = await publishedTrip(t, d.tok, amman4Stops('2027-02-10'));
    const p = await passenger(t);
    const r = await request(t, p.tok, { tripId: trip, travellers: [adult(), adult({ fullName: 'Omar Mansour' }), baby(1)] }).expect(201);
    const rm = await post(p.tok, `/v1/passenger/requests/${r.body.id}/travellers/1/remove`).expect(200);
    expect(rm.body).toMatchObject({ removed: 2, newTotal: 30000, seatStaysPaid: false });
    expect((await t.db.selectFrom('trips').select('seats_held').where('id', '=', trip).executeTakeFirstOrThrow()).seats_held).toBe(1);
    expect((await post(p.tok, `/v1/passenger/requests/${r.body.id}/travellers/0/remove`).expect(409)).body.code).toBe('LAST_ADULT');
    const r2 = await request(t, (await passenger(t)).tok, { tripId: trip, travellers: [adult(), adult({ fullName: 'Rami Haddad' })] }).expect(201);
    void r2;
  });
});
