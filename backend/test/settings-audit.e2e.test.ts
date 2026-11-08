import { DEFAULTS } from '../src/settings/definitions';
import { SettingsService } from '../src/settings/settings.service';
import { buildApp, resetDb } from './helpers';

/** Sam's test cases T-008 and T-009 (now automated). */
describe('Settings and audit history', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  let tok: string;
  const auth = () => ({ Authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    await resetDb();
    t = await buildApp();
    await t.seedStaff({ email: 'malek@jtos.jo', name: 'Malek', role: 'admin', main: true });
    tok = await t.signIn('malek@jtos.jo');
  });
  afterAll(() => t.close());

  it('T-009 TC-06: fresh install shows the 8 Nov defaults', async () => {
    const r = await t.http().get('/v1/staff/settings').set(auth()).expect(200);
    expect(r.body.version).toBe(1);
    expect(r.body.values).toEqual(DEFAULTS);
    expect(r.body.values).toMatchObject({ waitingRequestsMax: 3, ratingWindowHours: 48, arrivalRadiusMeters: 300, commissionPercent: 0, goodConductRequired: false });
  });

  it('T-009 TC-02: a value outside its range is refused', async () => {
    const r = await t.http().put('/v1/staff/settings').set(auth()).send({ changes: { driverResponseMinMinutes: 2 } }).expect(400);
    expect(r.body.code).toBe('INVALID_SETTINGS');
    await t.http().put('/v1/staff/settings').set(auth()).send({ changes: { commissionPercent: 60 } }).expect(400);
    await t.http().put('/v1/staff/settings').set(auth()).send({ changes: { nonsense: 1 } }).expect(400);
    await t.http().put('/v1/staff/settings').set(auth()).send({ changes: { ratingReviewBelow: 4.0, ratingWarnBelow: 3.5 } }).expect(400);
  });

  it('T-009 TC-01/03: a change creates a new version; the old version is unchanged', async () => {
    const svc = t.app.get(SettingsService);
    const before = await svc.versionAt();
    await t.http().put('/v1/staff/settings').set(auth()).send({ changes: { ratingWindowHours: 72 } }).expect(200);
    const after = await svc.versionAt();
    expect(after.version).toBe(before.version + 1);
    expect(after.values.ratingWindowHours).toBe(72);
    expect((await svc.byId(before.id)).values.ratingWindowHours).toBe(48);
  });

  it('T-024 TC-02: a scheduled commission change does not apply before its date', async () => {
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    await t.http().put('/v1/staff/settings').set(auth()).send({ changes: { commissionPercent: 10 }, effectiveFrom: future }).expect(200);
    const svc = t.app.get(SettingsService);
    expect((await svc.versionAt()).values.commissionPercent).toBe(0);
    expect((await svc.versionAt(new Date(Date.now() + 8 * 86400_000))).values.commissionPercent).toBe(10);
  });

  it('T-008 TC-01/T-009 TC-05: each change is in the audit history with old and new values', async () => {
    const r = await t.http().get('/v1/staff/audit?action=settings.changed').set(auth()).expect(200);
    const e = r.body.find((x: any) => x.after?.ratingWindowHours === 72);
    expect(e).toBeDefined();
    expect(e.before).toEqual({ ratingWindowHours: 48 });
    expect(e.actorName).toBe('Malek');
  });

  it('T-008 TC-02: filter by staff and date', async () => {
    const me = (await t.http().get('/v1/staff/me').set(auth())).body;
    const r = await t.http().get(`/v1/staff/audit?actorId=${me.id}&from=${new Date(Date.now() - 3600_000).toISOString()}`).set(auth()).expect(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((x: any) => x.actorId === me.id)).toBe(true);
  });

  it('T-008 TC-03: audit entries cannot be edited or deleted, even directly in the database', async () => {
    await expect(t.db.updateTable('audit_log').set({ action: 'tampered' }).execute()).rejects.toThrow(/append-only/);
    await expect(t.db.deleteFrom('audit_log').execute()).rejects.toThrow(/append-only/);
  });

  it('T-008 TC-06: CSV export has the same rows as the screen', async () => {
    const list = await t.http().get('/v1/staff/audit?action=settings.changed&limit=500').set(auth()).expect(200);
    const csv = await t.http().get('/v1/staff/audit/export?action=settings.changed').set(auth()).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.trim().split('\n').length - 1).toBe(list.body.length);
  });
});
