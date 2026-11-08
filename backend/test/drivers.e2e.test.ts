import { addDays, jordanDate } from '../src/common/dates';
import { ExpiryJobService } from '../src/drivers/expiry-job.service';
import { buildApp, resetDb } from './helpers';

/** Sam's test cases T-002, T-003, T-004 (drivers, review, expiry), automated. */
describe('Drivers: application, review and expiry', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  let admin: string, auditor: string;
  const today = jordanDate();
  const in1y = addDays(today, 365);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const year = Number(today.slice(0, 4));
  const car = { type: 'car', make: 'Hyundai', model: 'Elantra', year: year - 5, colour: 'White', plate: '12-34567', seats: 4 };
  const S = (tok: string) => ({ Authorization: `Bearer ${tok}` });
  let phoneN = 100;

  beforeAll(async () => {
    await resetDb();
    t = await buildApp();
    await t.seedStaff({ email: 'malek@jtos.jo', role: 'admin', main: true });
    await t.seedStaff({ email: 'aud@jtos.jo', role: 'auditor' });
    admin = await t.signIn('malek@jtos.jo');
    auditor = await t.signIn('aud@jtos.jo');
  });
  afterAll(() => t.close());

  async function newDriver() {
    const phone = `+962795${String(phoneN++).padStart(6, '0')}`;
    const c = await t.http().post('/v1/driver/auth/code').send({ phone }).expect(200);
    const v = await t.http().post('/v1/driver/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode(phone) }).expect(200);
    return { phone, tok: v.body.token as string };
  }
  const upload = (tok: string, type: string, expiresAt?: string) => {
    const r = t.http().post('/v1/driver/me/documents').set(S(tok)).field('type', type);
    if (expiresAt) r.field('expiresAt', expiresAt);
    return r.attach('file', JPG, { filename: `${type}.jpg`, contentType: 'image/jpeg' });
  };
  async function fillApplication(tok: string, o: { vehicle?: object; exp?: Partial<Record<string, string>>; skip?: string[] } = {}) {
    await t.http().put('/v1/driver/me/profile').set(S(tok)).send({ fullName: 'Ahmad K.', email: 'ahmad@example.com' }).expect(200);
    await t.http().put('/v1/driver/me/vehicle').set(S(tok)).send(o.vehicle ?? car).expect(200);
    for (const type of ['licence', 'registration', 'insurance', 'id_document', 'face_photo']) {
      if (o.skip?.includes(type)) continue;
      await upload(tok, type, type === 'face_photo' ? undefined : o.exp?.[type] ?? in1y).expect(201);
    }
  }
  async function submitted() {
    const d = await newDriver();
    await fillApplication(d.tok);
    const r = await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(200);
    return { ...d, appId: r.body.applicationId as string };
  }
  async function approved(exp?: Partial<Record<string, string>>) {
    const d = await newDriver();
    await fillApplication(d.tok, { exp });
    const r = await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(200);
    await t.http().post(`/v1/staff/applications/${r.body.applicationId}/decision`).set(S(admin)).send({ decision: 'approve' }).expect(200);
    return d;
  }

  // ---------- T-002 ----------
  it('T-002 TC-01: submit with everything → waiting for approval', async () => {
    const d = await submitted();
    const me = await t.http().get('/v1/driver/me').set(S(d.tok)).expect(200);
    expect(me.body.status).toBe('submitted');
  });

  it('T-002 TC-02: a missing document blocks submission', async () => {
    const d = await newDriver();
    await fillApplication(d.tok, { skip: ['insurance'] });
    const r = await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(400);
    expect(r.body.message).toMatch(/Insurance uploaded/);
  });

  it('T-002 TC-03: a document without expiry date is refused', async () => {
    const d = await newDriver();
    const r = await upload(d.tok, 'licence').expect(400);
    expect(r.body.code).toBe('EXPIRY_REQUIRED');
  });

  it('T-002 TC-04/05: good conduct optional by default; required once Admin switches it on', async () => {
    await submitted();
    await t.http().put('/v1/staff/settings').set(S(admin)).send({ changes: { goodConductRequired: true } }).expect(200);
    const d = await newDriver();
    await fillApplication(d.tok);
    const r = await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(400);
    expect(r.body.message).toMatch(/Good conduct/);
    await upload(d.tok, 'good_conduct').expect(201);
    await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(200);
    await t.http().put('/v1/staff/settings').set(S(admin)).send({ changes: { goodConductRequired: false } }).expect(200);
  });

  it('T-002 TC-06: car exactly 10 years old accepted; 11 years refused', async () => {
    const d = await newDriver();
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, year: year - 10 }).expect(200);
    const r = await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, year: year - 11 }).expect(400);
    expect(r.body.message).toMatch(/10 years old or newer/);
  });

  it('T-002 TC-07/08: car 5 seats and van 8 seats refused; only car or van', async () => {
    const d = await newDriver();
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, seats: 5 }).expect(400);
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, type: 'van', seats: 8 }).expect(400);
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, type: 'bus', seats: 4 }).expect(400);
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, type: 'van', seats: 7 }).expect(200);
  });

  it('T-002 TC-09: one car per driver — a second car becomes a change request, not a second car', async () => {
    const d = await approved();
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, plate: '99-11111' }).expect(200);
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, plate: '99-22222' }).expect(409);
    const me = (await t.http().get('/v1/driver/me').set(S(d.tok))).body;
    expect(me.vehicle.plate).toBe('12-34567');
    expect(me.pendingVehicleChange.plate).toBe('99-11111');
  });

  it('T-002 TC-10 / T-004 TC-09: expiry warning at 30 days, not 31, and only once', async () => {
    const d = await approved({ insurance: addDays(today, 31) });
    const job = t.app.get(ExpiryJobService);
    await job.run();
    expect(t.messaging.sent.some((m) => m.to === d.phone && m.template === 'document_expiring')).toBe(false);
    await t.db.updateTable('driver_documents').set({ expires_at: addDays(today, 30) }).where('type', '=', 'insurance').where('status', '=', 'approved').execute();
    await job.run();
    expect(t.messaging.sent.filter((m) => m.to === d.phone && m.template === 'document_expiring')).toHaveLength(1);
    await job.run();
    expect(t.messaging.sent.filter((m) => m.to === d.phone && m.template === 'document_expiring')).toHaveLength(1);
  });

  it('T-002 TC-12: documents are not visible to drivers or passengers', async () => {
    const a = await submitted();
    const b = await newDriver();
    const docId = (await t.http().get('/v1/driver/me').set(S(a.tok))).body.documents[0].id;
    expect(JSON.stringify((await t.http().get('/v1/driver/me').set(S(b.tok))).body)).not.toContain(docId);
    await t.http().get(`/v1/staff/documents/${docId}/file`).set(S(a.tok)).expect(401);
  });

  // ---------- T-003 ----------
  it('T-003 TC-01: Admin approves a complete application; driver is told and can publish', async () => {
    const d = await submitted();
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin)).send({ decision: 'approve' }).expect(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ to: d.phone, template: 'driver_application_approved' });
    const e = await t.http().get(`/v1/driver/me/eligibility?date=${addDays(today, 7)}`).set(S(d.tok)).expect(200);
    expect(e.body.canPublish).toBe(true);
  });

  it('T-003 TC-02: approve is blocked when the insurance has expired', async () => {
    const d = await submitted();
    await t.db.updateTable('driver_documents').set({ expires_at: addDays(today, -1) }).where('type', '=', 'insurance').where('status', '=', 'pending').execute();
    const r = await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin)).send({ decision: 'approve' }).expect(400);
    expect(r.body.code).toBe('CHECKS_FAILED');
  });

  it('T-003 TC-03: approve is blocked for a car older than 10 years', async () => {
    const d = await submitted();
    await t.db.updateTable('vehicles').set({ year: year - 12 }).where('plate', '=', '12-34567').where('status', '=', 'pending').execute();
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin)).send({ decision: 'approve' }).expect(400);
  });

  it('T-003 TC-04/05: send back needs a note; the driver fixes it and resubmits', async () => {
    const d = await submitted();
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin)).send({ decision: 'send_back' }).expect(400);
    const detail = (await t.http().get(`/v1/staff/applications/${d.appId}`).set(S(admin))).body;
    const photo = detail.documents.find((x: any) => x.type === 'face_photo').id;
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin))
      .send({ decision: 'send_back', note: 'Face photo is blurry.', documentNotes: { [photo]: 'Take a new one in daylight.' } }).expect(200);
    const me = (await t.http().get('/v1/driver/me').set(S(d.tok))).body;
    expect(me.status).toBe('sent_back');
    expect(me.lastDecisionNote).toBe('Face photo is blurry.');
    await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(400);
    await upload(d.tok, 'face_photo').expect(201);
    await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(200);
    expect((await t.http().get('/v1/staff/applications').set(S(admin))).body.some((a: any) => a.driverId === me.id)).toBe(true);
  });

  it('T-003 TC-06: a rejected driver can apply again; history is kept', async () => {
    const d = await submitted();
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin)).send({ decision: 'reject', note: 'Documents do not match.' }).expect(200);
    const r = await t.http().post('/v1/driver/me/application/submit').set(S(d.tok)).expect(200);
    expect(r.body.applicationId).not.toBe(d.appId);
    const detail = (await t.http().get(`/v1/staff/applications/${r.body.applicationId}`).set(S(admin))).body;
    expect(detail.history.map((h: any) => h.status)).toContain('rejected');
  });

  it('T-003 TC-07: an application waiting more than 48 h shows as overdue', async () => {
    const d = await submitted();
    await t.db.updateTable('driver_applications').set({ submitted_at: new Date(Date.now() - 49 * 3600_000) } as any).where('id', '=', d.appId).execute();
    const q = (await t.http().get('/v1/staff/applications').set(S(admin))).body;
    expect(q[0]).toMatchObject({ id: d.appId, target: 'overdue' });
  });

  it('T-003 TC-09: Auditor can view applications but cannot decide', async () => {
    const d = await submitted();
    await t.http().get(`/v1/staff/applications/${d.appId}`).set(S(auditor)).expect(200);
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(auditor)).send({ decision: 'approve' }).expect(403);
  });

  it('T-003 TC-10: every document view is written to the audit history', async () => {
    const d = await submitted();
    const doc = (await t.http().get(`/v1/staff/applications/${d.appId}`).set(S(auditor))).body.documents[0];
    const f = await t.http().get(`/v1/staff/documents/${doc.id}/file`).set(S(auditor)).expect(200);
    expect(f.headers['content-type']).toContain('image/jpeg');
    const log = await t.db.selectFrom('audit_log').selectAll().where('action', '=', 'document.viewed').where('record_id', '=', doc.id).execute();
    expect(log).toHaveLength(1);
  });

  it('a decision cannot be made twice', async () => {
    const d = await submitted();
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin)).send({ decision: 'approve' }).expect(200);
    await t.http().post(`/v1/staff/applications/${d.appId}/decision`).set(S(admin)).send({ decision: 'reject', note: 'x' }).expect(409);
  });

  // ---------- T-004 ----------
  it('T-004 TC-01/02: the earliest expiry decides (insurance before licence)', async () => {
    const d = await approved({ licence: addDays(today, 60), insurance: addDays(today, 40) });
    expect((await t.http().get(`/v1/driver/me/eligibility?date=${addDays(today, 40)}`).set(S(d.tok))).body.canPublish).toBe(true);
    const r = (await t.http().get(`/v1/driver/me/eligibility?date=${addDays(today, 41)}`).set(S(d.tok))).body;
    expect(r).toMatchObject({ canPublish: false, code: 'DOCUMENT_EXPIRES', earliestExpiry: addDays(today, 40) });
    expect(r.message).toMatch(/insurance expires on/);
  });

  it('T-004 TC-03: after a document expires, every new trip is blocked', async () => {
    const d = await approved();
    await t.db.updateTable('driver_documents').set({ expires_at: addDays(today, -1) }).where('type', '=', 'licence').where('status', '=', 'approved')
      .where('driver_id', '=', (await t.http().get('/v1/driver/me').set(S(d.tok))).body.id).execute();
    expect((await t.http().get(`/v1/driver/me/eligibility?date=${today}`).set(S(d.tok))).body.canPublish).toBe(false);
  });

  it('T-004 TC-04/05: a renewal waiting for review does not count; once approved it does', async () => {
    const d = await approved({ insurance: addDays(today, 40) });
    const later = addDays(today, 100);
    const up = await upload(d.tok, 'insurance', addDays(today, 400)).expect(201);
    expect(up.body.forReview).toBe(true);
    expect((await t.http().get(`/v1/driver/me/eligibility?date=${later}`).set(S(d.tok))).body.canPublish).toBe(false);
    const item = (await t.http().get('/v1/staff/applications').set(S(admin))).body.find((a: any) => a.kind === 'renewal' && a.phone === d.phone);
    await t.http().post(`/v1/staff/applications/${item.id}/decision`).set(S(admin)).send({ decision: 'approve' }).expect(200);
    expect((await t.http().get(`/v1/driver/me/eligibility?date=${later}`).set(S(d.tok))).body.canPublish).toBe(true);
  });

  it('T-004 TC-06: a rejected renewal keeps the block and the driver gets the note', async () => {
    const d = await approved({ insurance: addDays(today, 40) });
    await upload(d.tok, 'insurance', addDays(today, 400)).expect(201);
    const item = (await t.http().get('/v1/staff/applications').set(S(admin))).body.find((a: any) => a.kind === 'renewal' && a.phone === d.phone);
    await t.http().post(`/v1/staff/applications/${item.id}/decision`).set(S(admin)).send({ decision: 'reject', note: 'Insurance photo is cut off.' }).expect(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ to: d.phone, body: expect.stringContaining('Insurance photo is cut off.') });
    expect((await t.http().get(`/v1/driver/me/eligibility?date=${addDays(today, 100)}`).set(S(d.tok))).body.canPublish).toBe(false);
  });

  it('T-004 TC-07/08: a car change waits for review; the old car stays until approved', async () => {
    const d = await approved();
    await t.http().put('/v1/driver/me/vehicle').set(S(d.tok)).send({ ...car, make: 'Kia', model: 'Cerato', plate: '55-55555' }).expect(200);
    expect((await t.http().get('/v1/driver/me').set(S(d.tok))).body.vehicle.plate).toBe('12-34567');
    const item = (await t.http().get('/v1/staff/applications').set(S(admin))).body.find((a: any) => a.kind === 'vehicle_change' && a.phone === d.phone);
    await t.http().post(`/v1/staff/applications/${item.id}/decision`).set(S(admin)).send({ decision: 'approve' }).expect(200);
    const me = (await t.http().get('/v1/driver/me').set(S(d.tok))).body;
    expect(me.vehicle).toMatchObject({ make: 'Kia', plate: '55-55555', status: 'active' });
    expect(me.pendingVehicleChange).toBeNull();
  });

  it('files: only JPG, PNG or PDF up to 5 MB', async () => {
    const d = await newDriver();
    const r = await t.http().post('/v1/driver/me/documents').set(S(d.tok)).field('type', 'face_photo')
      .attach('file', Buffer.from('MZ...'), { filename: 'x.exe', contentType: 'application/x-msdownload' }).expect(400);
    expect(r.body.code).toBe('BAD_FILE');
  });
});
