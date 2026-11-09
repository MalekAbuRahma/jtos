import { buildApp, resetDb } from './helpers';

/** Sam's test cases T-005, T-006, T-007 (now automated). */
describe('Staff accounts, roles and sign-in', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  let mainToken: string;

  beforeAll(async () => {
    await resetDb();
    t = await buildApp();
    await t.seedStaff({ email: 'malek@jtos.jo', name: 'Malek', role: 'admin', main: true });
    mainToken = await t.signIn('malek@jtos.jo');
  });
  afterAll(() => t.close());

  const auth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  it('T-005 TC-01: main admin creates staff; invitation email arrives', async () => {
    const r = await t.http().post('/v1/staff/staff').set(auth(mainToken)).send({ fullName: 'Lina Haddad', email: 'lina@jtos.jo' }).expect(201);
    expect(r.body).toMatchObject({ email: 'lina@jtos.jo', role: null, status: 'invited' });
    expect(t.email.sent.some((m) => m.to === 'lina@jtos.jo' && m.template === 'staff_invitation')).toBe(true);
  });

  it('T-005 TC-03: new staff sets password, signs in, and has no access until a role is given', async () => {
    const link = t.email.sent.find((m) => m.to === 'lina@jtos.jo')!.body;
    const token = link.match(/token=([\w-]+)/)![1];
    await t.http().post('/v1/staff/auth/set-password').send({ token, password: 'lina-strong-password' }).expect(200);
    const tok = await t.signIn('lina@jtos.jo', 'lina-strong-password');
    const me = await t.http().get('/v1/staff/me').set(auth(tok)).expect(200);
    expect(me.body.permissions).toEqual([]);
    await t.http().get('/v1/staff/settings').set(auth(tok)).expect(403);
  });

  it('T-005 TC-04: login without the email code gives no token', async () => {
    const r = await t.http().post('/v1/staff/auth/login').send({ email: 'malek@jtos.jo', password: 'correct-horse-battery' }).expect(200);
    expect(r.body.token).toBeUndefined();
    await t.http().post('/v1/staff/auth/verify').send({ loginTicket: r.body.loginTicket, code: '000000' }).expect(401);
  });

  it('T-005 TC-05: 5 wrong passwords lock the account', async () => {
    await t.seedStaff({ email: 'lock@jtos.jo', role: 'support' });
    for (let i = 0; i < 5; i++) await t.http().post('/v1/staff/auth/login').send({ email: 'lock@jtos.jo', password: 'wrong-password' }).expect(401);
    const r = await t.http().post('/v1/staff/auth/login').send({ email: 'lock@jtos.jo', password: 'correct-horse-battery' }).expect(429);
    expect(r.body.code).toBe('LOCKED');
  });

  it('T-005 TC-06: invitation link older than 24 h is refused', async () => {
    await t.http().post('/v1/staff/staff').set(auth(mainToken)).send({ fullName: 'Old Invite', email: 'old@jtos.jo' }).expect(201);
    await t.db.updateTable('staff_invitations').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    const token = t.email.sent.find((m) => m.to === 'old@jtos.jo')!.body.match(/token=([\w-]+)/)![1];
    const r = await t.http().post('/v1/staff/auth/set-password').send({ token, password: 'some-strong-password' }).expect(400);
    expect(r.body.code).toBe('BAD_INVITATION');
  });

  it('T-005 TC-07: same email cannot be used twice', async () => {
    const r = await t.http().post('/v1/staff/staff').set(auth(mainToken)).send({ fullName: 'Copy', email: 'LINA@jtos.jo' }).expect(409);
    expect(r.body.code).toBe('EMAIL_TAKEN');
  });

  it('T-005 TC-02 / T-007 TC-04: a normal admin, support or auditor cannot add staff or change roles', async () => {
    await t.seedStaff({ email: 'admin2@jtos.jo', role: 'admin' });
    await t.seedStaff({ email: 'aud@jtos.jo', role: 'auditor' });
    for (const who of ['admin2@jtos.jo', 'aud@jtos.jo']) {
      const tok = await t.signIn(who);
      await t.http().post('/v1/staff/staff').set(auth(tok)).send({ fullName: 'X', email: `x-${who}` }).expect(403);
    }
  });

  it('T-007 TC-01/02: role given → access; role removed → next request refused', async () => {
    const lina = (await t.db.selectFrom('staff').select('id').where('email', '=', 'lina@jtos.jo').executeTakeFirstOrThrow()).id;
    await t.http().post(`/v1/staff/staff/${lina}/role`).set(auth(mainToken)).send({ role: 'support' }).expect(200);
    const tok = await t.signIn('lina@jtos.jo', 'lina-strong-password');
    await t.http().get('/v1/staff/settings').set(auth(tok)).expect(200);
    await t.http().post(`/v1/staff/staff/${lina}/role`).set(auth(mainToken)).send({ role: null }).expect(200);
    await t.http().get('/v1/staff/settings').set(auth(tok)).expect(403);
  });

  it('T-007 TC-03: the main admin role cannot be removed', async () => {
    const me = (await t.http().get('/v1/staff/me').set(auth(mainToken))).body;
    const r = await t.http().post(`/v1/staff/staff/${me.id}/role`).set(auth(mainToken)).send({ role: null }).expect(400);
    expect(r.body.code).toBe('MAIN_ADMIN_ROLE');
  });

  it('T-005 TC-08: deactivated staff cannot sign in or use an old token; history stays', async () => {
    const s = await t.seedStaff({ email: 'leaver@jtos.jo', role: 'support' });
    const tok = await t.signIn('leaver@jtos.jo');
    await t.http().post(`/v1/staff/staff/${s.id}/deactivate`).set(auth(mainToken)).expect(200);
    await t.http().get('/v1/staff/me').set(auth(tok)).expect(401);
    await t.http().post('/v1/staff/auth/login').send({ email: 'leaver@jtos.jo', password: 'correct-horse-battery' }).expect(401);
    const log = await t.db.selectFrom('audit_log').select('action').where('actor_id', '=', s.id).execute();
    expect(log.map((l) => l.action)).toContain('staff.logged_in');
  });

  it('T-006 TC-02/04: auditor can view but every change is refused by the API', async () => {
    const tok = await t.signIn('aud@jtos.jo');
    await t.http().get('/v1/staff/settings').set(auth(tok)).expect(200);
    await t.http().get('/v1/staff/audit').set(auth(tok)).expect(200);
    await t.http().put('/v1/staff/settings').set(auth(tok)).send({ changes: { waitingRequestsMax: 4 } }).expect(403);
  });

  it('T-006 TC-03: support cannot change settings or open the audit history', async () => {
    await t.seedStaff({ email: 'sup@jtos.jo', role: 'support' });
    const tok = await t.signIn('sup@jtos.jo');
    await t.http().put('/v1/staff/settings').set(auth(tok)).send({ changes: { waitingRequestsMax: 4 } }).expect(403);
    await t.http().get('/v1/staff/audit').set(auth(tok)).expect(403);
  });

  it('rejects requests without a token, or with a forged one', async () => {
    await t.http().get('/v1/staff/me').expect(401);
    await t.http().get('/v1/staff/me').set({ Authorization: 'Bearer abc.def.ghi' }).expect(401);
  });
});

describe('Set-password page (T-005, until the admin web exists)', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { await resetDb(); t = await buildApp(); });
  afterAll(() => t.close());

  it('serves the page with no caching and a strict content policy', async () => {
    const r = await t.http().get('/set-password').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.text).toContain('/v1/staff/auth/set-password');
  });
});
