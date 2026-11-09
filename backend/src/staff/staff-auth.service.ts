import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Kysely } from 'kysely';
import { AuditService } from '../common/audit.service';
import { hashPassword, randomToken, sha256, sixDigitCode, verifyPassword } from '../common/crypto';
import { EmailService } from '../common/email.service';
import { AppError, badInput } from '../common/errors';
import { CONFIG_TOKEN, DB_TOKEN } from '../common/tokens';
import { AppConfig } from '../config';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';

const MAX_WRONG_PASSWORDS = 5;
const MAX_CODE_ATTEMPTS = 5;
const INVITE_HOURS = 24;
const wrongLogin = () => new AppError(HttpStatus.UNAUTHORIZED, 'WRONG_LOGIN', 'Email or password is not correct.');

/** T-005: staff sign in with email + password + a code sent to their email each time. */
@Injectable()
export class StaffAuthService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    @Inject(CONFIG_TOKEN) private cfg: AppConfig,
    private jwt: JwtService,
    private email: EmailService,
    private audit: AuditService,
    private settings: SettingsService,
  ) {}

  async login(email: string, password: string, ip?: string): Promise<{ loginTicket: string }> {
    if (!email || !password) throw wrongLogin();
    const s = await this.db.selectFrom('staff').selectAll().where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase())).executeTakeFirst();
    if (!s || s.status !== 'active' || !s.password_hash) throw wrongLogin();
    const { values } = await this.settings.versionAt();
    if (s.locked_until && s.locked_until > new Date()) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'LOCKED', `Too many wrong tries. Try again after ${s.locked_until.toISOString()}.`);
    }
    if (!(await verifyPassword(s.password_hash, password))) {
      const failed = s.failed_logins + 1;
      const lock = failed >= MAX_WRONG_PASSWORDS ? new Date(Date.now() + (values.loginLockMinutes as number) * 60_000) : null;
      await this.db.updateTable('staff').set({ failed_logins: lock ? 0 : failed, locked_until: lock }).where('id', '=', s.id).execute();
      await this.audit.record({ actorType: 'staff', actorId: s.id, action: lock ? 'staff.locked' : 'staff.login_failed', recordType: 'staff', recordId: s.id, ip });
      throw wrongLogin();
    }
    await this.db.updateTable('staff').set({ failed_logins: 0, locked_until: null }).where('id', '=', s.id).execute();
    const code = sixDigitCode();
    const row = await this.db.insertInto('staff_login_codes')
      .values({ staff_id: s.id, code_hash: sha256(code), expires_at: new Date(Date.now() + (values.loginCodeMinutes as number) * 60_000) })
      .returning('id').executeTakeFirstOrThrow();
    await this.email.send(s.email, 'staff_login_code', `Your JTOS sign-in code is ${code}`);
    return { loginTicket: row.id };
  }

  async verify(loginTicket: string, code: string, ip?: string): Promise<{ token: string; expiresInHours: number }> {
    const bad = () => new AppError(HttpStatus.UNAUTHORIZED, 'WRONG_CODE', 'The code is not correct or has expired.');
    if (!loginTicket || !code) throw bad();
    const row = await this.db.selectFrom('staff_login_codes').selectAll().where('id', '=', loginTicket).executeTakeFirst().catch(() => undefined);
    if (!row || row.used_at || row.expires_at < new Date() || row.attempts >= MAX_CODE_ATTEMPTS) throw bad();
    if (row.code_hash !== sha256(code)) {
      await this.db.updateTable('staff_login_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
      throw bad();
    }
    const used = await this.db.updateTable('staff_login_codes').set({ used_at: new Date() })
      .where('id', '=', row.id).where('used_at', 'is', null).executeTakeFirst();
    if (!used.numUpdatedRows) throw bad();
    const s = await this.db.selectFrom('staff').selectAll().where('id', '=', row.staff_id).executeTakeFirstOrThrow();
    if (s.status !== 'active') throw bad();
    await this.audit.record({ actorType: 'staff', actorId: s.id, action: 'staff.logged_in', recordType: 'staff', recordId: s.id, ip });
    const token = await this.jwt.signAsync({ sub: s.id, aud: 'staff' }, { expiresIn: `${this.cfg.staffSessionHours}h` });
    return { token, expiresInHours: this.cfg.staffSessionHours };
  }

  async createInvitation(staffId: string, email: string): Promise<void> {
    const token = randomToken();
    await this.db.insertInto('staff_invitations')
      .values({ staff_id: staffId, token_hash: sha256(token), expires_at: new Date(Date.now() + INVITE_HOURS * 3600_000) }).execute();
    await this.email.send(email, 'staff_invitation', `You're invited to JTOS. Set your password with this link (valid 24 hours): ${process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? ''}/set-password#token=${token}`);
  }

  async setPassword(token: string, password: string): Promise<void> {
    if (!password || password.length < 12) throw badInput('WEAK_PASSWORD', 'Use at least 12 characters.');
    const bad = () => badInput('BAD_INVITATION', 'This link is not valid or has expired. Ask the admin to send a new one.');
    if (!token) throw bad();
    const inv = await this.db.selectFrom('staff_invitations').selectAll().where('token_hash', '=', sha256(token)).executeTakeFirst();
    if (!inv || inv.used_at || inv.expires_at < new Date()) throw bad();
    const s = await this.db.selectFrom('staff').selectAll().where('id', '=', inv.staff_id).executeTakeFirstOrThrow();
    if (s.status === 'deactivated') throw bad();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('staff_invitations').set({ used_at: new Date() }).where('id', '=', inv.id).execute();
      await trx.updateTable('staff').set({ password_hash: await hashPassword(password), status: 'active', updated_at: new Date() }).where('id', '=', s.id).execute();
      await this.audit.record({ actorType: 'staff', actorId: s.id, action: 'staff.password_set', recordType: 'staff', recordId: s.id }, trx);
    });
  }
}
