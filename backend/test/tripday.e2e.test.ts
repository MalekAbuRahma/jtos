import { randomUUID } from 'crypto';
import { addDays, jordanDate } from '../src/common/dates';
import { PassengerTripDayService } from '../src/tripday/passenger-tripday.service';
import { ABDALI, adult, baby, confirmedBooking, FAR, passenger, S, shiftToNow } from './fixtures';
import { buildApp, resetDb } from './helpers';

/** Sam's test cases T-019–T-023, T-026–T-028, T-035, automated. */
describe('Trip day, cash, cases, corrections, cancelling', () => {
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
  const ageArrival = (tripId: string, minutesAgo: number) => t.db.updateTable('trip_stops').set({ arrived_at: new Date(Date.now() - minutesAgo * 60_000), pickup_at: new Date(Date.now() - minutesAgo * 60_000) }).where('trip_id', '=', tripId).where('seq', '=', 1).execute();
  const ready = async (travellers: object[] = [adult()]) => {
    const x = await confirmedBooking(t, travellers);
    await shiftToNow(t, x.tripId);
    return x;
  };

  // ---------- T-019 ----------
  it('T-019 TC-01: "I\'ve arrived" 1 km away is refused; at the stop it works and passengers are told', async () => {
    const x = await ready();
    const r = await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, FAR).expect(400);
    expect(r.body.message).toBe("You're not at the stop yet.");
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, {}).expect(400);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ to: x.p.phone, template: 'driver_arrived', body: expect.stringContaining('Your driver is at Amman') });
  });

  it('T-019 TC-02: early arrival → waiting starts at the pickup time', async () => {
    const x = await ready();
    const r = await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    const pickup = (await t.db.selectFrom('trip_stops').select('pickup_at').where('trip_id', '=', x.tripId).where('seq', '=', 1).executeTakeFirstOrThrow()).pickup_at;
    expect(new Date(r.body.noShowFrom).getTime()).toBe(pickup.getTime() + 15 * 60_000);
  });

  it('T-019 TC-03/04/05: late arrival → waiting starts at arrival; no-show only after the wait and a call', async () => {
    const x = await ready();
    await t.db.updateTable('trip_stops').set({ pickup_at: new Date(Date.now() - 10 * 60_000) }).where('trip_id', '=', x.tripId).where('seq', '=', 1).execute();
    const r = await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    expect(new Date(r.body.noShowFrom).getTime() - new Date(r.body.arrivedAt).getTime()).toBe(15 * 60_000);
    expect((await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/no-show`).expect(409)).body.code).toBe('STILL_WAITING');
    await ageArrival(x.tripId, 16);
    expect((await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/no-show`).expect(409)).body.code).toBe('CONTACT_FIRST');
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/contact-attempt`, { kind: 'call' }).expect(200);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/no-show`).expect(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ to: x.p.phone, template: 'marked_no_show' });
  });

  it('T-019 TC-06/07: "I was there" within 48 h opens a case and the no-show stops counting; after 48 h it is refused', async () => {
    const x = await ready();
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    await ageArrival(x.tripId, 30);
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/contact-attempt`, { kind: 'message' }).expect(200);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/no-show`).expect(200);
    const r = await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/dispute-no-show`, { statement: 'I was at gate 3 at 07:05, he left early.' }).expect(200);
    expect(r.body.caseCode).toMatch(/^C-\d+/);
    const w = await t.db.selectFrom('warnings').select(['under_review']).where('ref_id', '=', x.travellerIds[0]).executeTakeFirstOrThrow();
    expect(w.under_review).toBe(true);
    const y = await ready();
    await post(y.d.tok, `/v1/driver/trips/${y.tripId}/stops/1/arrived`, ABDALI).expect(200);
    await ageArrival(y.tripId, 30);
    await post(y.d.tok, `/v1/driver/bookings/${y.bookingId}/contact-attempt`, { kind: 'call' }).expect(200);
    await post(y.d.tok, `/v1/driver/travellers/${y.travellerIds[0]}/no-show`).expect(200);
    await t.db.updateTable('travellers').set({ no_show_at: new Date(Date.now() - 49 * 3600_000) }).where('id', '=', y.travellerIds[0]).execute();
    expect((await post(y.p.tok, `/v1/passenger/bookings/${y.bookingId}/dispute-no-show`, { statement: 'I was there all along' }).expect(409)).body.code).toBe('TOO_LATE');
  });

  // ---------- T-020 / T-026 ----------
  it('T-020 TC-01 / T-026 TC-01: 4 booked, 3 board, 1 no-show → trip continues; booking completed; full cash receipt', async () => {
    const x = await ready([adult(), adult({ fullName: 'Omar Mansour' }), adult({ fullName: 'Hiba Mansour' }), adult({ fullName: 'Rami Mansour' })]);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    for (const id of x.travellerIds.slice(0, 3)) await post(x.d.tok, `/v1/driver/travellers/${id}/boarded`).expect(200);
    const c = await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/cash`, { status: 'full' }).expect(200);
    expect(c.body).toMatchObject({ status: 'full', received: 120000, due: 120000 });
    await ageArrival(x.tripId, 20);
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/contact-attempt`, { kind: 'call' }).expect(200);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[3]}/no-show`).expect(200);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/leave`).expect(200);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/complete`).expect(200);
    const b = await t.http().get(`/v1/passenger/bookings/${x.bookingId}`).set(S(x.p.tok)).expect(200);
    expect(b.body.status).toBe('completed');
    expect(b.body.receipt).toMatchObject({ text: 'Paid in cash to the driver', received: 120000 });
    expect(JSON.stringify(b.body)).not.toMatch(/paid to JTOS/i);
  });

  it('T-020 TC-02: a booking where everyone was a no-show is closed as no-show, not completed', async () => {
    const x = await ready();
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    await ageArrival(x.tripId, 20);
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/contact-attempt`, { kind: 'call' }).expect(200);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/no-show`).expect(200);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/complete`).expect(200);
    expect((await t.http().get(`/v1/passenger/bookings/${x.bookingId}`).set(S(x.p.tok))).body.status).toBe('no_show');
  });

  it('T-020 TC-03/04: can\'t leave a stop with someone unmarked; another driver can\'t mark boarding; a baby boards with the adult', async () => {
    const x = await ready([adult(), baby(0)]);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    const r = await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/leave`).expect(409);
    expect(r.body.message).toMatch(/Mark everyone first: Sara Mansour/);
    const other = await confirmedBooking(t, [adult()]);
    await post(other.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/boarded`).expect(404);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/boarded`).expect(200);
    const baby1 = await t.db.selectFrom('travellers').select('boarding_status').where('id', '=', x.travellerIds[1]).executeTakeFirstOrThrow();
    expect(baby1.boarding_status).toBe('boarded');
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/leave`).expect(200);
  });

  it('T-020 TC-05/06: completing asks passengers to rate; the same action twice gives one result', async () => {
    const x = await ready();
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/boarded`).expect(200);
    const key = randomUUID();
    const a = await t.http().post(`/v1/driver/trips/${x.tripId}/complete`).set(S(x.d.tok)).set('Idempotency-Key', key).send({}).expect(200);
    const b = await t.http().post(`/v1/driver/trips/${x.tripId}/complete`).set(S(x.d.tok)).set('Idempotency-Key', key).send({}).expect(200);
    expect(b.body).toEqual(a.body);
    expect(t.messaging.sent.some((m) => m.to === x.p.phone && m.template === 'trip_completed')).toBe(true);
  });

  // ---------- T-026 / T-027 ----------
  it('T-026 TC-02/03/04: part payment opens a case; more than due is refused; recorded once', async () => {
    const x = await ready([adult(), adult({ fullName: 'Omar Mansour' })]);
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/cash`, { status: 'part', amount: 70000 }).expect(400);
    const key = randomUUID();
    const a = await t.http().post(`/v1/driver/bookings/${x.bookingId}/cash`).set(S(x.d.tok)).set('Idempotency-Key', key).send({ status: 'part', amount: 30000 }).expect(200);
    expect(a.body.caseCode).toMatch(/^C-/);
    const b = await t.http().post(`/v1/driver/bookings/${x.bookingId}/cash`).set(S(x.d.tok)).set('Idempotency-Key', key).send({ status: 'part', amount: 30000 }).expect(200);
    expect(b.body).toEqual(a.body);
    expect((await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/cash`, { status: 'full' }).expect(409)).body.code).toBe('CASH_ALREADY_RECORDED');
  });

  it('T-027 TC-01/02/04: driver reports non-payment; both statements kept apart; resolving creates no debt', async () => {
    const x = await ready();
    await t.db.updateTable('trips').set({ status: 'completed', completed_at: new Date() }).where('id', '=', x.tripId).execute();
    const r = await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/cash-case`, { reason: 'passenger_did_not_pay', statement: 'He said he would pay at Damascus, then left.' }).expect(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ to: x.p.phone, template: 'cash_case_statement_request' });
    const cases = (await t.http().get('/v1/passenger/cases').set(S(x.p.tok))).body;
    await post(x.p.tok, `/v1/passenger/cases/${cases[0].id}/statement`, { text: 'I paid 30 JOD in cash at Abdali.' }).expect(200);
    const detail = (await t.http().get(`/v1/staff/cases/${cases[0].id}`).set(S(support))).body;
    expect(detail.code).toBe(r.body.caseCode);
    expect(detail.statements.map((s: any) => s.authorType)).toEqual(['driver', 'passenger']);
    await post(support, `/v1/staff/cases/${cases[0].id}/resolve`, { note: 'Both agree it was paid.' }).expect(200);
    expect(await t.db.selectFrom('warnings').select('id').where('ref_id', '=', cases[0].id).execute()).toHaveLength(0);
  });

  it('T-027 TC-03/06: reports after 48 h are refused; the 3rd confirmed non-payment sends the passenger to review', async () => {
    const x = await ready();
    await t.db.updateTable('trips').set({ status: 'completed', completed_at: new Date(Date.now() - 49 * 3600_000) }).where('id', '=', x.tripId).execute();
    expect((await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/cash-case`, { reason: 'wrong_amount' }).expect(409)).body.code).toBe('TOO_LATE');
    const payer = await passenger(t);
    for (let i = 0; i < 3; i++) {
      const c = await t.app.get(PassengerTripDayService);
      const y = await ready();
      await t.db.updateTable('bookings').set({ passenger_id: payer.id }).where('id', '=', y.bookingId).execute();
      await t.db.updateTable('trips').set({ status: 'completed', completed_at: new Date() }).where('id', '=', y.tripId).execute();
      const r = await post(y.d.tok, `/v1/driver/bookings/${y.bookingId}/cash-case`, { reason: 'passenger_did_not_pay' }).expect(200);
      const id = (await t.db.selectFrom('cases').select('id').where('code', '=', r.body.caseCode).executeTakeFirstOrThrow()).id;
      await post(support, `/v1/staff/cases/${id}/resolve`, { note: 'Confirmed not paid.', warn: 'passenger' }).expect(200);
      void c;
    }
    expect((await t.db.selectFrom('passengers').select('status').where('id', '=', payer.id).executeTakeFirstOrThrow()).status).toBe('under_review');
  });

  // ---------- T-021 / T-028 ----------
  it('T-021 TC-01/02/03/05/06: Admin corrects a no-show to boarded; count goes down; cash untouched; Support can only request', async () => {
    const x = await ready();
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    await ageArrival(x.tripId, 20);
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/contact-attempt`, { kind: 'call' }).expect(200);
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/no-show`).expect(200);
    await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/cash`, { status: 'not_paid' }).expect(200);
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/complete`).expect(200);
    await post(admin, '/v1/staff/corrections/service', { travellerId: x.travellerIds[0], status: 'boarded' }).expect(400);
    await post(support, '/v1/staff/corrections/service', { travellerId: x.travellerIds[0], status: 'boarded', reason: 'x' }).expect(403);
    const req = await post(support, '/v1/staff/corrections/requests', { travellerId: x.travellerIds[0], status: 'boarded', reason: 'GPS shows he left early.' }).expect(200);
    expect(req.body.status).toBe('for_admin');
    await post(admin, '/v1/staff/corrections/service', { travellerId: x.travellerIds[0], status: 'boarded', reason: 'Driver GPS shows he left before the wait ended.' }).expect(200);
    expect((await t.db.selectFrom('warnings').select('void').where('ref_id', '=', x.travellerIds[0]).executeTakeFirstOrThrow()).void).toBe(true);
    expect((await t.http().get(`/v1/passenger/bookings/${x.bookingId}`).set(S(x.p.tok))).body.status).toBe('completed');
    expect((await t.db.selectFrom('cash_records').select('status').where('booking_id', '=', x.bookingId).executeTakeFirstOrThrow()).status).toBe('not_paid');
    expect(t.messaging.sent.filter((m) => m.template === 'record_corrected').slice(-2).map((m) => m.to).sort()).toEqual([x.d.phone, x.p.phone].sort());
    const audit = await t.db.selectFrom('audit_log').select('action').where('record_id', '=', x.travellerIds[0]).where('action', '=', 'service.corrected').execute();
    expect(audit).toHaveLength(1);
  });

  it('T-028 TC-01/02/03/04: Admin corrects cash JOD 30 → 15 with a reason; history kept; Support refused; same key once', async () => {
    const x = await ready();
    const c = await post(x.d.tok, `/v1/driver/bookings/${x.bookingId}/cash`, { status: 'full' }).expect(200);
    await post(support, '/v1/staff/corrections/cash', { cashRecordId: c.body.cashRecordId, received: 15000, reason: 'x' }).expect(403);
    await post(admin, '/v1/staff/corrections/cash', { cashRecordId: c.body.cashRecordId, received: 15000 }).expect(400);
    const key = randomUUID();
    for (let i = 0; i < 2; i++) await t.http().post('/v1/staff/corrections/cash').set(S(admin)).set('Idempotency-Key', key).send({ cashRecordId: c.body.cashRecordId, received: 15000, reason: 'Passenger showed a photo of half payment.' }).expect(200);
    const h = (await t.http().get(`/v1/staff/bookings/${x.bookingId}/cash`).set(S(admin))).body;
    expect(h).toMatchObject({ due: 30000, received: 15000, status: 'part' });
    expect(h.corrections).toHaveLength(1);
    expect(h.corrections[0]).toMatchObject({ old: 30000, new: 15000 });
  });

  // ---------- T-022 ----------
  it('T-022 TC-01/03/04: offline actions sync later with their real time; repeats are ignored; invalid ones are rejected with a reason', async () => {
    const x = await ready([adult(), adult({ fullName: 'Omar Mansour' })]);
    const y = await ready();
    const arrivedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const actions = [
      { actionId: `a-${randomUUID()}`, type: 'arrived', tripId: x.tripId, seq: 1, at: arrivedAt, ...ABDALI },
      { actionId: `b-${randomUUID()}`, type: 'boarded', travellerId: x.travellerIds[0] },
      { actionId: `c-${randomUUID()}`, type: 'boarded', travellerId: x.travellerIds[1] },
    ];
    const r = await t.http().post('/v1/driver/sync').set(S(x.d.tok)).send({ actions }).expect(200);
    expect(r.body.results.map((a: any) => a.status)).toEqual(['sent', 'sent', 'sent']);
    const stop = await t.db.selectFrom('trip_stops').select('arrived_at').where('trip_id', '=', x.tripId).where('seq', '=', 1).executeTakeFirstOrThrow();
    expect(stop.arrived_at!.toISOString()).toBe(arrivedAt);
    const again = await t.http().post('/v1/driver/sync').set(S(x.d.tok)).send({ actions }).expect(200);
    expect(again.body.results.map((a: any) => a.status)).toEqual(['sent', 'sent', 'sent']);
    expect(await t.db.selectFrom('driver_actions').select('action_id').where('driver_id', '=', x.d.id).execute()).toHaveLength(3);
    await post(y.p.tok, `/v1/passenger/bookings/${y.bookingId}/cancel`).expect(200);
    const late = await t.http().post('/v1/driver/sync').set(S(y.d.tok)).send({ actions: [{ actionId: `d-${randomUUID()}`, type: 'boarded', travellerId: y.travellerIds[0] }] }).expect(200);
    expect(late.body.results[0]).toMatchObject({ status: 'rejected', code: 'BOOKING_NOT_ACTIVE' });
  });

  it('Q04 / T-014 TC-10: traveller documents are deleted 30 days after the trip', async () => {
    const x = await confirmedBooking(t, [adult()]);
    await t.db.updateTable('trips').set({ travel_date: addDays(jordanDate(), -31) }).where('id', '=', x.tripId).execute();
    expect(await t.app.get(PassengerTripDayService).deleteOldTravellerData()).toBeGreaterThanOrEqual(1);
    const tr = await t.db.selectFrom('travellers').selectAll().where('id', '=', x.travellerIds[0]).executeTakeFirstOrThrow();
    expect(tr).toMatchObject({ doc_number_enc: null, doc_hash: null, date_of_birth: null });
    expect(tr.personal_deleted_at).not.toBeNull();
  });

  // ---------- T-023 ----------
  it('T-023 TC-01/02/03: at 30 min late passengers are told (not at 29); cancelling then is free and not counted', async () => {
    const x = await ready();
    const svc = t.app.get(PassengerTripDayService);
    await t.db.updateTable('trip_stops').set({ pickup_at: new Date(Date.now() - 29 * 60_000) }).where('trip_id', '=', x.tripId).where('seq', '=', 1).execute();
    await svc.lateDrivers();
    expect(t.messaging.sent.some((m) => m.to === x.p.phone && m.template === 'driver_late')).toBe(false);
    await t.db.updateTable('trip_stops').set({ pickup_at: new Date(Date.now() - 30 * 60_000 - 1000) }).where('trip_id', '=', x.tripId).where('seq', '=', 1).execute();
    await svc.lateDrivers();
    expect(t.messaging.sent.find((m) => m.to === x.p.phone && m.template === 'driver_late')!.body).toMatch(/30 minutes late/);
    const pv = await t.http().get(`/v1/passenger/bookings/${x.bookingId}/cancel-preview`).set(S(x.p.tok)).expect(200);
    expect(pv.body).toMatchObject({ canCancel: true, countsTowardWarning: false });
    const c = await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/cancel`, { reason: 'driver_late' }).expect(200);
    expect(c.body).toMatchObject({ fee: 0, refund: 0, countsTowardWarning: false });
    await post(x.d.tok, `/v1/driver/travellers/${x.travellerIds[0]}/no-show`).expect(409);
  });

  it('T-023 TC-05: the 3rd late arrival in 30 days warns the driver; Admin sees the late-drivers report', async () => {
    const x = await ready();
    const svc = t.app.get(PassengerTripDayService);
    await t.db.insertInto('warnings').values([{ subject_type: 'driver', subject_id: x.d.id, kind: 'late', ref_type: 'trip', ref_id: randomUUID() }, { subject_type: 'driver', subject_id: x.d.id, kind: 'late', ref_type: 'trip', ref_id: randomUUID() }]).execute();
    await t.db.updateTable('trip_stops').set({ pickup_at: new Date(Date.now() - 31 * 60_000) }).where('trip_id', '=', x.tripId).where('seq', '=', 1).execute();
    await svc.lateDrivers();
    expect(t.messaging.sent.some((m) => m.to === x.d.phone && m.template === 'late_warning')).toBe(true);
    const rep = (await t.http().get('/v1/staff/reports/late-drivers').set(S(admin)).expect(200)).body;
    expect(rep.find((r: any) => r.id === x.d.id).lateCount).toBe(3);
  });

  // ---------- T-035 ----------
  it('T-035 TC-01/05: cancel the day before → free, seats back on sale, driver told, no refund or debt', async () => {
    const x = await confirmedBooking(t, [adult(), adult({ fullName: 'Omar Mansour' })]);
    const pv = await t.http().get(`/v1/passenger/bookings/${x.bookingId}/cancel-preview`).set(S(x.p.tok)).expect(200);
    expect(pv.body.message).toMatch(/Cancelling is free. You've cancelled 0 bookings/);
    const r = await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/cancel`).expect(200);
    expect(r.body).toMatchObject({ fee: 0, refund: 0, countsTowardWarning: true });
    expect((await t.db.selectFrom('trips').select('seats_booked').where('id', '=', x.tripId).executeTakeFirstOrThrow()).seats_booked).toBe(0);
    expect(t.messaging.sent.some((m) => m.to === x.d.phone && m.template === 'booking_cancelled')).toBe(true);
  });

  it('T-035 TC-02: after the driver taps "I\'ve arrived", cancelling is refused', async () => {
    const x = await ready();
    await post(x.d.tok, `/v1/driver/trips/${x.tripId}/stops/1/arrived`, ABDALI).expect(200);
    expect((await post(x.p.tok, `/v1/passenger/bookings/${x.bookingId}/cancel`).expect(409)).body.code).toBe('DRIVER_ARRIVED');
  });

  it('T-035 TC-03: the 3rd cancellation in 30 days sends a warning', async () => {
    const p = await passenger(t);
    for (let i = 0; i < 3; i++) {
      const x = await confirmedBooking(t, [adult()]);
      await t.db.updateTable('bookings').set({ passenger_id: p.id }).where('id', '=', x.bookingId).execute();
      await post(p.tok, `/v1/passenger/bookings/${x.bookingId}/cancel`).expect(200);
    }
    expect(t.messaging.sent.at(-1)).toMatchObject({ to: p.phone, template: 'cancellation_warning' });
  });
});
