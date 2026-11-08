import { addDays, jordanDate } from '../src/common/dates';
import { buildApp, resetDb } from './helpers';

/** Sam's test cases T-010, T-011, T-012, T-013, automated. */
describe('Trips: create, publish, search', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  let admin: string;
  const today = jordanDate();
  const D = addDays(today, 3);
  const S = (tok: string) => ({ Authorization: `Bearer ${tok}` });
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    t = await buildApp();
    await t.seedStaff({ email: 'malek@jtos.jo', role: 'admin', main: true });
    admin = await t.signIn('malek@jtos.jo');
  });
  afterAll(() => t.close());

  /** Approved driver with an active car and valid documents (seeded directly). */
  async function driver(o: { name?: string; ratings?: number; type?: 'car' | 'van'; seats?: number; insuranceExpires?: string } = {}) {
    const phone = `+962796${String(n++).padStart(6, '0')}`;
    const d = await t.db.insertInto('drivers').values({ phone, email: null, full_name: o.name ?? 'Ahmad Khalil', rating_avg: o.ratings ? '4.80' : null, rating_count: o.ratings ?? 0, status: 'approved' }).returning('id').executeTakeFirstOrThrow();
    await t.db.insertInto('vehicles').values({ driver_id: d.id, status: 'active', type: o.type ?? 'car', make: 'Hyundai', model: 'Elantra', year: 2021, colour: 'White', plate: `12-${n}`, seats: o.seats ?? 4 }).execute();
    const blob = await t.db.insertInto('file_blobs').values({ owner_type: 'driver', owner_id: d.id, mime: 'image/jpeg', size_bytes: 3, sha256: 'x', data: Buffer.from([1, 2, 3]) }).returning('id').executeTakeFirstOrThrow();
    for (const type of ['licence', 'registration', 'insurance', 'id_document', 'face_photo'] as const)
      await t.db.insertInto('driver_documents').values({ driver_id: d.id, type, file_id: blob.id, status: 'approved', review_note: null, expiry_warned_at: null,
        expires_at: type === 'face_photo' ? null : type === 'insurance' && o.insuranceExpires ? o.insuranceExpires : addDays(today, 365) }).execute();
    const c = await t.http().post('/v1/driver/auth/code').send({ phone }).expect(200);
    const v = await t.http().post('/v1/driver/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode(phone) }).expect(200);
    return { id: d.id, tok: v.body.token as string };
  }

  const trip = (o: Record<string, unknown> = {}) => ({
    date: D, seatsOffered: 4, bookingType: 'both', wholePrice: 110000, responseWindowMinutes: 120, notes: 'Air conditioning',
    stops: [
      { city: 'AMM', spot: 'Abdali Bus Station, gate 3', time: '07:00', price: 30000 },
      { city: 'ZRQ', spot: 'New Zarqa roundabout', time: '07:30', price: 27000 },
      { city: 'IRB', spot: 'Irbid New Bus Station', time: '08:30', price: 20000 },
      { city: 'DAM', spot: 'Al-Samariyah station', time: '11:30' },
    ], ...o,
  });
  async function published(tok: string, o: Record<string, unknown> = {}) {
    const c = await t.http().post('/v1/driver/trips').set(S(tok)).send(trip(o)).expect(201);
    await t.http().post(`/v1/driver/trips/${c.body.id}/publish`).set(S(tok)).expect(200);
    return c.body.id as string;
  }

  // ---------- T-010 ----------
  it('T-010 TC-01: driver creates Amman → Zarqa → Irbid → Damascus; saved as a draft', async () => {
    const d = await driver();
    const r = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip()).expect(201);
    expect(r.body).toMatchObject({ status: 'draft', seatsOffered: 4, wholePrice: 110000 });
    expect(r.body.stops.map((s: any) => `${s.city} ${s.time}`)).toEqual(['AMM 07:00', 'ZRQ 07:30', 'IRB 08:30', 'DAM 11:30']);
  });

  it('T-010 TC-02: a price above the admin highest is refused', async () => {
    const d = await driver();
    const s = trip().stops; s[0].price = 36000;
    const r = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip({ stops: s })).expect(400);
    expect(r.body.message).toMatch(/Amman → Damascus: allowed JOD 25.000 – JOD 35.000/);
  });

  it('T-010 TC-03: 5 seats in a 4-seat car is refused', async () => {
    const d = await driver();
    await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip({ seatsOffered: 5 })).expect(400);
  });

  it('T-010 TC-04: stop times out of order are refused', async () => {
    const d = await driver();
    const s = trip().stops; s[2].time = '07:15';
    const r = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip({ stops: s })).expect(400);
    expect(r.body.message).toMatch(/Irbid is not after Zarqa/);
  });

  it('T-010 TC-05: "Repeat trip" creates a new draft on a new date with the same stops and prices', async () => {
    const d = await driver();
    const id = await published(d.tok);
    const r = await t.http().post(`/v1/driver/trips/${id}/repeat`).set(S(d.tok)).send({ date: addDays(D, 7) }).expect(201);
    expect(r.body).toMatchObject({ status: 'draft', date: addDays(D, 7) });
    expect(r.body.stops.map((s: any) => s.price)).toEqual([30000, 27000, 20000, null]);
  });

  it('T-010 TC-06: the 11th upcoming trip is refused while the limit is 10', async () => {
    const d = await driver();
    for (let i = 0; i < 10; i++) await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip({ date: addDays(today, 2 + i) })).expect(201);
    const r = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip({ date: addDays(today, 20) })).expect(409);
    expect(r.body.code).toBe('TOO_MANY_TRIPS');
  });

  it('T-010 TC-07: a phone number in the notes or spot is hidden', async () => {
    const d = await driver();
    const s = trip().stops; s[0].spot = 'Gate 3, call 0791234567';
    const r = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip({ stops: s, notes: 'WhatsApp me +962 79 123 4567 or www.mysite.com' })).expect(201);
    expect(r.body.stops[0].spot).toBe('Gate 3, call [hidden]');
    expect(r.body.notes).not.toMatch(/\d{6}|mysite/);
  });

  it("T-010 TC-08: a driver cannot see or edit another driver's trip; the attempt is logged", async () => {
    const a = await driver(), b = await driver();
    const id = await published(a.tok);
    await t.http().get(`/v1/driver/trips/${id}`).set(S(b.tok)).expect(404);
    await t.http().put(`/v1/driver/trips/${id}`).set(S(b.tok)).send(trip()).expect(404);
    const log = await t.db.selectFrom('audit_log').select('action').where('actor_id', '=', b.id).where('action', '=', 'trip.access_denied').execute();
    expect(log.length).toBe(2);
  });

  it('a driver who is not approved cannot create trips', async () => {
    const phone = '+962799999999';
    const c = await t.http().post('/v1/driver/auth/code').send({ phone }).expect(200);
    const v = await t.http().post('/v1/driver/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode(phone) }).expect(200);
    const r = await t.http().post('/v1/driver/trips').set(S(v.body.token)).send(trip()).expect(403);
    expect(r.body.code).toBe('NOT_APPROVED');
  });

  // ---------- T-011 ----------
  it('T-011 TC-01: an approved driver publishes; the trip appears in search at once', async () => {
    const d = await driver();
    const id = await published(d.tok);
    const s = await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${D}`).expect(200);
    expect(s.body.results.some((r: any) => r.tripId === id)).toBe(true);
  });

  it('T-011 TC-02: insurance expires before the trip date → publishing is refused with the reason', async () => {
    const d = await driver({ insuranceExpires: addDays(today, 1) });
    const c = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip()).expect(201);
    const r = await t.http().post(`/v1/driver/trips/${c.body.id}/publish`).set(S(d.tok)).expect(409);
    expect(r.body).toMatchObject({ code: 'DOCUMENT_EXPIRES' });
    expect(r.body.message).toMatch(/insurance expires on/);
  });

  it('T-011 TC-03: an overlapping trip time is refused', async () => {
    const d = await driver();
    await published(d.tok);
    const s = trip().stops.map((x: any, i: number) => ({ ...x, time: ['09:00', '09:30', '10:30', '13:00'][i] }));
    const c = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip({ stops: s })).expect(201);
    const r = await t.http().post(`/v1/driver/trips/${c.body.id}/publish`).set(S(d.tok)).expect(409);
    expect(r.body.code).toBe('TRIP_OVERLAP');
  });

  it('T-011 TC-04: a double tap on Publish creates one published trip', async () => {
    const d = await driver();
    const c = await t.http().post('/v1/driver/trips').set(S(d.tok)).send(trip()).expect(201);
    const [a, b] = await Promise.all([
      t.http().post(`/v1/driver/trips/${c.body.id}/publish`).set(S(d.tok)).set('Idempotency-Key', 'tap-1'),
      t.http().post(`/v1/driver/trips/${c.body.id}/publish`).set(S(d.tok)).set('Idempotency-Key', 'tap-1'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await t.db.selectFrom('trips').select('status').where('driver_id', '=', d.id).execute();
    expect(rows).toEqual([{ status: 'published' }]);
  });

  it('T-011 TC-05: after a booking, changing a stop time is refused', async () => {
    const d = await driver();
    const id = await published(d.tok);
    await t.db.updateTable('trips').set({ seats_booked: 1 }).where('id', '=', id).execute(); // stands in for a booking (T-014)
    const s = trip().stops; s[0].time = '06:30';
    const r = await t.http().put(`/v1/driver/trips/${id}`).set(S(d.tok)).send(trip({ stops: s })).expect(409);
    expect(r.body.code).toBe('TRIP_LOCKED');
  });

  it('T-011 TC-06: last-chance price below the admin lowest is refused; a valid one shows in search with the old price', async () => {
    const d = await driver();
    const id = await published(d.tok);
    await t.http().post(`/v1/driver/trips/${id}/last-chance`).set(S(d.tok)).send({ prices: [{ seq: 1, price: 24000 }] }).expect(400);
    await t.http().post(`/v1/driver/trips/${id}/last-chance`).set(S(d.tok)).send({ prices: [{ seq: 1, price: 26000 }] }).expect(200);
    const s = await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${D}`).expect(200);
    expect(s.body.results.find((r: any) => r.tripId === id)).toMatchObject({ pricePerPerson: 26000, originalPrice: 30000, badges: expect.arrayContaining(['last_chance']) });
  });

  it('T-011 TC-07: cancelling published trips counts toward the warning (after 2)', async () => {
    const d = await driver();
    for (let i = 0; i < 3; i++) {
      const id = await published(d.tok, { date: addDays(today, 4 + i) });
      await t.http().post(`/v1/driver/trips/${id}/cancel`).set(S(d.tok)).send({ reason: 'Car problem' }).expect(200);
    }
    expect(t.messaging.sent.at(-1)).toMatchObject({ template: 'driver_cancellation_warning' });
  });

  it('T-011 TC-08: suspend needs a reason; a suspended trip leaves search; the action is audited', async () => {
    const d = await driver();
    const id = await published(d.tok, { date: addDays(today, 5) });
    await t.http().post(`/v1/staff/trips/${id}/suspend`).set(S(admin)).send({}).expect(400);
    await t.http().post(`/v1/staff/trips/${id}/suspend`).set(S(admin)).send({ reason: 'Fake listing' }).expect(200);
    const s = await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${addDays(today, 5)}`).expect(200);
    expect(s.body.results.some((r: any) => r.tripId === id)).toBe(false);
    const log = await t.db.selectFrom('audit_log').select('action').where('record_id', '=', id).where('action', '=', 'trip.suspended').execute();
    expect(log).toHaveLength(1);
  });

  // ---------- T-012 ----------
  it('T-012 TC-01/06: search is cheapest first and shows badges (Good price, New)', async () => {
    const date = addDays(today, 8);
    const a = await driver({ ratings: 37 }), b = await driver({ ratings: 0 }), c = await driver({ ratings: 12 });
    await published(a.tok, { date });
    const s2 = trip().stops; s2[0].price = 27000;
    await published(b.tok, { date, stops: s2 });
    const s3 = trip().stops; s3[0].price = 32000;
    await published(c.tok, { date, stops: s3 });
    const r = await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${date}&travellers=2`).expect(200);
    expect(r.body.results.map((x: any) => x.pricePerPerson)).toEqual([27000, 30000, 32000]);
    expect(r.body.results[0].badges).toEqual(['good_price', 'new']);
    expect(r.body.results[0].driver).toMatchObject({ isNew: true, rating: null });
    expect(r.body.results[1].driver).toMatchObject({ rating: 4.8, name: 'Ahmad K.' });
  });

  it('T-012 TC-02: a stop whose booking has closed is not offered (cutoff 1 h before that stop)', async () => {
    const d = await driver();
    const id = await published(d.tok, { date: addDays(today, 6) });
    // Move the trip to "now": Amman pickup in 30 min (closed), Irbid in 3 h (open), Damascus in 6 h.
    const at = (min: number) => new Date(Date.now() + min * 60_000);
    const date = jordanDate(at(30));
    await t.db.updateTable('trips').set({ travel_date: date }).where('id', '=', id).execute();
    for (const [seq, min] of [[1, 30], [2, 60], [3, 180], [4, 360]]) await t.db.updateTable('trip_stops').set({ pickup_at: at(min) }).where('trip_id', '=', id).where('seq', '=', seq).execute();
    const amm = await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${date}`).expect(200);
    const irb = await t.http().get(`/v1/public/search?from=IRB&to=DAM&date=${date}`).expect(200);
    expect(amm.body.results.some((r: any) => r.tripId === id)).toBe(false);
    expect(irb.body.results.some((r: any) => r.tripId === id)).toBe(true);
    const detail = (await t.http().get(`/v1/public/trips/${id}`)).body;
    expect(detail.stops.map((x: any) => x.open)).toEqual([false, false, true, false]);
  });

  it('T-012 TC-03 / T-002 TC-11: trip details show car and driver but never the plate or documents', async () => {
    const d = await driver({ ratings: 37 });
    const id = await published(d.tok, { date: addDays(today, 9) });
    const r = await t.http().get(`/v1/public/trips/${id}?from=IRB`).expect(200);
    expect(r.body.vehicle).toEqual({ type: 'car', make: 'Hyundai', model: 'Elantra', colour: 'White' });
    expect(r.body.stops.find((s: any) => s.city === 'IRB').yourStop).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/12-\d|plate"|licence|insurance|phone/);
    await t.http().get(r.body.driver.photoUrl).expect(200);
  });

  it('T-012 TC-04: no trips → suggestions for the day before and after', async () => {
    const date = addDays(today, 12);
    const d = await driver();
    await published(d.tok, { date: addDays(date, 1) });
    const r = await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${date}`).expect(200);
    expect(r.body.results).toEqual([]);
    expect(r.body.suggestions).toEqual([{ date: addDays(date, -1), trips: 0 }, { date: addDays(date, 1), trips: 1 }]);
  });

  it('T-012 TC-05: guests can search and view trips without signing in', async () => {
    await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${D}`).expect(200);
    await t.http().get('/v1/public/cities').expect(200);
  });

  it('T-012: "to" must be the final stop (everyone gets off at the final stop)', async () => {
    const r = await t.http().get(`/v1/public/search?from=AMM&to=IRB&date=${D}`).expect(200);
    expect(r.body.results).toEqual([]);
  });

  it('T-012 TC-07: more than 60 searches a minute from one device are limited', async () => {
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) limited = (await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${D}`)).status === 429;
    expect(limited).toBe(true);
  });

  // ---------- T-013 ----------
  it('T-013 TC-03/04: seats held → whole vehicle unavailable; whole vehicle taken → no seats', async () => {
    const d = await driver();
    const date = addDays(today, 14);
    const id = await published(d.tok, { date });
    await t.db.updateTable('trips').set({ seats_held: 1 }).where('id', '=', id).execute();
    expect((await t.http().get(`/v1/public/trips/${id}`)).body).toMatchObject({ wholeAvailable: false, seatsLeft: 3 });
    await t.db.updateTable('trips').set({ seats_held: 0, whole_taken: true }).where('id', '=', id).execute();
    expect((await t.http().get(`/v1/public/trips/${id}`)).body).toMatchObject({ wholeAvailable: false, seatsLeft: 0 });
    const s = await t.http().get(`/v1/public/search?from=AMM&to=DAM&date=${date}`).set('X-Forwarded-For', '10.0.0.2');
    expect((s.body.results ?? []).some((r: any) => r.tripId === id)).toBe(false);
  });

  it('T-013 TC-05: the database refuses more booked + held seats than offered', async () => {
    const d = await driver();
    const id = await published(d.tok, { date: addDays(today, 15) });
    await expect(t.db.updateTable('trips').set({ seats_booked: 3, seats_held: 2 }).where('id', '=', id).execute()).rejects.toThrow(/check/);
  });

  it('price ranges: Admin can change a range; Support cannot', async () => {
    await t.http().put('/v1/staff/price-ranges').set(S(admin)).send({ from: 'AMM', to: 'DAM', vehicleType: 'car', min: 26000, max: 36000, normal: 31000, wholeMin: 90000, wholeMax: 130000, wholeNormal: 110000 }).expect(200);
    await t.seedStaff({ email: 'sup@jtos.jo', role: 'support' });
    const sup = await t.signIn('sup@jtos.jo');
    await t.http().put('/v1/staff/price-ranges').set(S(sup)).send({ from: 'AMM', to: 'DAM', vehicleType: 'car', min: 1, max: 2, normal: 1 }).expect(403);
    const list = await t.http().get('/v1/staff/price-ranges').set(S(sup)).expect(200);
    expect(list.body.find((r: any) => r.from === 'AMM' && r.to === 'DAM' && r.vehicleType === 'car').min).toBe(26000);
  });
});
