import { buildApp, resetDb } from './helpers';

/** Sam's test cases T-001 (passenger account), automated. */
describe('T-001 Passenger sign-up, sign-in and recovery', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { await resetDb(); t = await buildApp(); });
  afterAll(() => t.close());

  async function signUp(phone: string, email: string, name = 'Sara M.') {
    const c = await t.http().post('/v1/passenger/auth/code').send({ phone }).expect(200);
    const v = await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode(phone) }).expect(200);
    const s = await t.http().post('/v1/passenger/auth/signup').send({ signupToken: v.body.signupToken, fullName: name, email }).expect(200);
    const f = await t.http().post('/v1/passenger/auth/signup/verify-email').send({ emailTicket: s.body.emailTicket, code: t.lastCode(email) }).expect(200);
    return f.body.token as string;
  }

  it('TC-06/07: a new number signs up; the account exists only after the email is verified', async () => {
    const phone = '+962791111111';
    const c = await t.http().post('/v1/passenger/auth/code').send({ phone }).expect(200);
    expect(c.body.channel).toBe('whatsapp');
    const v = await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode(phone) }).expect(200);
    expect(v.body.status).toBe('needs_signup');
    await t.http().post('/v1/passenger/auth/signup').send({ signupToken: v.body.signupToken, fullName: 'Sara M.', email: 'sara@example.com' }).expect(200);
    expect(await t.db.selectFrom('passengers').select('id').where('phone', '=', phone).executeTakeFirst()).toBeUndefined();
    const s2 = (await t.db.selectFrom('otp_codes').select('id').where('target', '=', 'sara@example.com').orderBy('created_at', 'desc').executeTakeFirstOrThrow()).id;
    const f = await t.http().post('/v1/passenger/auth/signup/verify-email').send({ emailTicket: s2, code: t.lastCode('sara@example.com') }).expect(200);
    const me = await t.http().get('/v1/passenger/me').set({ Authorization: `Bearer ${f.body.token}` }).expect(200);
    expect(me.body).toMatchObject({ phone, email: 'sara@example.com', fullName: 'Sara M.' });
  });

  it('TC-01: correct WhatsApp code signs in an existing passenger (local 07… format accepted)', async () => {
    const c = await t.http().post('/v1/passenger/auth/code').send({ phone: '0791111111' }).expect(200);
    const v = await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode('+962791111111') }).expect(200);
    expect(v.body.status).toBe('signed_in');
    expect(v.body.token).toBeDefined();
  });

  it('TC-02: wrong code is refused', async () => {
    const c = await t.http().post('/v1/passenger/auth/code').send({ phone: '+962791111112' }).expect(200);
    const r = await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: '000000' === t.lastCode('+962791111112') ? '111111' : '000000' }).expect(401);
    expect(r.body.code).toBe('WRONG_CODE');
  });

  it('TC-03: a code older than 5 minutes is refused', async () => {
    const c = await t.http().post('/v1/passenger/auth/code').send({ phone: '+962791111113' }).expect(200);
    await t.db.updateTable('otp_codes').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', c.body.ticket).execute();
    await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode('+962791111113') }).expect(401);
  });

  it('TC-04: "Send by SMS" delivers a working code', async () => {
    const c = await t.http().post('/v1/passenger/auth/code').send({ phone: '+962791111114', channel: 'sms' }).expect(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ channel: 'sms', to: '+962791111114' });
    await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode('+962791111114') }).expect(200);
  });

  it('TC-05: first code + 3 resends allowed; the next is blocked for 30 minutes', async () => {
    const phone = '+962791111115';
    for (let i = 0; i < 4; i++) await t.http().post('/v1/passenger/auth/code').send({ phone }).expect(200);
    const r = await t.http().post('/v1/passenger/auth/code').send({ phone }).expect(429);
    expect(r.body.code).toBe('RESEND_LIMIT');
    await t.db.updateTable('otp_codes').set({ created_at: new Date(Date.now() - 31 * 60_000) }).where('target', '=', phone).execute();
    await t.http().post('/v1/passenger/auth/code').send({ phone }).expect(200);
  });

  it('TC-08: lost phone → sign in by email code, then change to a new number', async () => {
    const r = await t.http().post('/v1/passenger/auth/recover').send({ email: 'SARA@example.com' }).expect(200);
    const v = await t.http().post('/v1/passenger/auth/recover/verify').send({ ticket: r.body.ticket, code: t.lastCode('sara@example.com') }).expect(200);
    const auth = { Authorization: `Bearer ${v.body.token}` };
    const c = await t.http().post('/v1/passenger/me/phone').set(auth).send({ phone: '+962797777777' }).expect(200);
    await t.http().post('/v1/passenger/me/phone/verify').set(auth).send({ ticket: c.body.ticket, code: t.lastCode('+962797777777') }).expect(200);
    expect((await t.http().get('/v1/passenger/me').set(auth)).body.phone).toBe('+962797777777');
  });

  it('TC-08b: recovery gives the same answer for unknown emails (no account guessing)', async () => {
    const r = await t.http().post('/v1/passenger/auth/recover').send({ email: 'nobody@example.com' }).expect(200);
    expect(r.body.message).toMatch(/If this email has an account/);
  });

  it('TC-09: a passenger only sees their own account; other tokens are refused', async () => {
    const a = await signUp('+962792222221', 'omar@example.com', 'Omar');
    const me = await t.http().get('/v1/passenger/me').set({ Authorization: `Bearer ${a}` }).expect(200);
    expect(me.body.email).toBe('omar@example.com');
    const c = await t.http().post('/v1/driver/auth/code').send({ phone: '+962793333331' }).expect(200);
    const d = await t.http().post('/v1/driver/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode('+962793333331') }).expect(200);
    await t.http().get('/v1/passenger/me').set({ Authorization: `Bearer ${d.body.token}` }).expect(401);
  });

  it('cannot take a number or email that already has an account', async () => {
    const a = await signUp('+962792222222', 'hiba@example.com', 'Hiba');
    await t.http().post('/v1/passenger/me/phone').set({ Authorization: `Bearer ${a}` }).send({ phone: '+962792222221' }).expect(409);
    const c = await t.http().post('/v1/passenger/auth/code').send({ phone: '+962792222299' }).expect(200);
    const v = await t.http().post('/v1/passenger/auth/verify').send({ ticket: c.body.ticket, code: t.lastCode('+962792222299') }).expect(200);
    await t.http().post('/v1/passenger/auth/signup').send({ signupToken: v.body.signupToken, fullName: 'X Y', email: 'hiba@example.com' }).expect(409);
  });

  it('TC-11: there is no password sign-in for passengers', async () => {
    await t.http().post('/v1/passenger/auth/login').send({ email: 'sara@example.com', password: 'x' }).expect(404);
  });
});
