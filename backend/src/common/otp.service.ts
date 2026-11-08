import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { sha256, sixDigitCode } from './crypto';
import { EmailService } from './email.service';
import { AppError } from './errors';
import { Channel, MessagingService } from './messaging.service';
import { DB_TOKEN } from './tokens';

export type Audience = 'passenger' | 'driver';
export type Purpose = 'login' | 'signup_email' | 'recover' | 'change_phone';
const MAX_ATTEMPTS = 5;

/**
 * T-001 one-time codes: WhatsApp first, SMS backup, email for recovery.
 * Valid 5 minutes; first code + 3 resends, then a 30-minute wait (all admin settings).
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    private settings: SettingsService,
    private messaging: MessagingService,
    private email: EmailService,
  ) {}

  async send(o: { audience: Audience; purpose: Purpose; target: string; channel: Channel; context?: Record<string, unknown> }): Promise<{ ticket: string; expiresAt: Date }> {
    const { values } = await this.settings.versionAt();
    const windowMs = (values.loginLockMinutes as number) * 60_000;
    const maxCodes = 1 + (values.loginCodeMaxResends as number);
    const recent = await this.db.selectFrom('otp_codes').select('created_at')
      .where('audience', '=', o.audience).where('target', '=', o.target)
      .where('created_at', '>', new Date(Date.now() - windowMs)).orderBy('created_at').execute();
    if (recent.length >= maxCodes) {
      const retryAt = new Date(recent[recent.length - maxCodes].created_at.getTime() + windowMs);
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RESEND_LIMIT', `Too many codes. You can ask for a new code at ${retryAt.toISOString()}.`);
    }
    const code = sixDigitCode();
    const expiresAt = new Date(Date.now() + (values.loginCodeMinutes as number) * 60_000);
    const row = await this.db.insertInto('otp_codes').values({
      audience: o.audience, purpose: o.purpose, target: o.target, channel: o.channel,
      code_hash: sha256(code), context: o.context ? JSON.stringify(o.context) : null, expires_at: expiresAt,
    }).returning('id').executeTakeFirstOrThrow();
    const body = `Your JTOS code is ${code}. It expires in ${values.loginCodeMinutes} minutes.`;
    if (o.channel === 'email') await this.email.send(o.target, `${o.audience}_${o.purpose}_code`, body);
    else await this.messaging.send({ channel: o.channel, to: o.target, template: `${o.audience}_${o.purpose}_code`, body, recipientType: o.audience });
    return { ticket: row.id, expiresAt };
  }

  /** Checks and uses a code once. Returns what the code was for. */
  async verify(ticket: string, code: string, audience: Audience, purpose: Purpose) {
    const bad = () => new AppError(HttpStatus.UNAUTHORIZED, 'WRONG_CODE', 'The code is not correct or has expired.');
    if (typeof ticket !== 'string' || typeof code !== 'string' || !/^[0-9a-f-]{36}$/i.test(ticket)) throw bad();
    const row = await this.db.selectFrom('otp_codes').selectAll().where('id', '=', ticket).executeTakeFirst();
    if (!row || row.audience !== audience || row.purpose !== purpose || row.used_at || row.expires_at < new Date() || row.attempts >= MAX_ATTEMPTS) throw bad();
    if (row.code_hash !== sha256(code)) {
      await this.db.updateTable('otp_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
      throw bad();
    }
    const used = await this.db.updateTable('otp_codes').set({ used_at: new Date() }).where('id', '=', row.id).where('used_at', 'is', null).executeTakeFirst();
    if (!used.numUpdatedRows) throw bad();
    return { target: row.target, context: row.context ?? {} };
  }
}
