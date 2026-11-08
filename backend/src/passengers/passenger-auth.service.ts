import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Kysely } from 'kysely';
import { AuditService } from '../common/audit.service';
import { badInput, conflict } from '../common/errors';
import { OtpService } from '../common/otp.service';
import { normalizePhone } from '../common/phone';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_DAYS = 30;

/**
 * T-001: sign up and sign in with a phone code (WhatsApp, SMS backup).
 * New accounts must verify an email (used for recovery). No passwords, no Google/Apple sign-in.
 */
@Injectable()
export class PassengerAuthService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private otp: OtpService, private jwt: JwtService, private audit: AuditService) {}

  private phoneOrThrow(v: unknown) {
    const p = normalizePhone(v);
    if (!p) throw badInput('BAD_PHONE', 'Enter a valid phone number, e.g. +962 79 123 4567.');
    return p;
  }
  private emailOrThrow(v: unknown) {
    if (typeof v !== 'string' || !EMAIL_RE.test(v.trim())) throw badInput('BAD_EMAIL', 'Enter a valid email address.');
    return v.trim().toLowerCase();
  }
  private token(id: string) {
    return this.jwt.signAsync({ sub: id, aud: 'passenger' }, { expiresIn: `${SESSION_DAYS}d` });
  }

  async sendLoginCode(phoneIn: unknown, channel: unknown) {
    const phone = this.phoneOrThrow(phoneIn);
    const ch = channel === 'sms' ? 'sms' : 'whatsapp';
    const r = await this.otp.send({ audience: 'passenger', purpose: 'login', target: phone, channel: ch });
    return { ticket: r.ticket, channel: ch, expiresAt: r.expiresAt };
  }

  /** Existing account → signed in. New number → must finish sign-up with name + email. */
  async verifyLogin(ticket: string, code: string) {
    const { target } = await this.otp.verify(ticket, code, 'passenger', 'login');
    const p = await this.db.selectFrom('passengers').selectAll().where('phone', '=', target).executeTakeFirst();
    if (p) {
      await this.audit.record({ actorType: 'passenger', actorId: p.id, action: 'passenger.signed_in', recordType: 'passenger', recordId: p.id });
      return { status: 'signed_in', token: await this.token(p.id) };
    }
    const signup = await this.jwt.signAsync({ phone: target, aud: 'passenger_signup' }, { expiresIn: '30m' });
    return { status: 'needs_signup', signupToken: signup };
  }

  async startSignup(signupToken: string, fullName: unknown, emailIn: unknown) {
    let phone: string;
    try {
      const p = await this.jwt.verifyAsync(signupToken);
      if (p.aud !== 'passenger_signup') throw new Error();
      phone = p.phone;
    } catch { throw badInput('SIGNUP_EXPIRED', 'Please start again with your phone number.'); }
    if (typeof fullName !== 'string' || fullName.trim().length < 2) throw badInput('NAME_REQUIRED', 'Enter your full name.');
    const email = this.emailOrThrow(emailIn);
    const taken = await this.db.selectFrom('passengers').select('id').where((eb) => eb(eb.fn('lower', ['email']), '=', email)).executeTakeFirst();
    if (taken) throw conflict('EMAIL_TAKEN', 'This email is already used by another account.');
    const r = await this.otp.send({ audience: 'passenger', purpose: 'signup_email', target: email, channel: 'email', context: { phone, fullName: fullName.trim() } });
    return { emailTicket: r.ticket, expiresAt: r.expiresAt };
  }

  /** TC-07: the account is created only after the email is verified. */
  async finishSignup(emailTicket: string, code: string) {
    const { target: email, context } = await this.otp.verify(emailTicket, code, 'passenger', 'signup_email');
    const phone = context.phone as string;
    const exists = await this.db.selectFrom('passengers').select('id').where('phone', '=', phone).executeTakeFirst();
    if (exists) throw conflict('PHONE_TAKEN', 'This phone number already has an account. Please sign in.');
    const p = await this.db.insertInto('passengers').values({ phone, email, full_name: context.fullName as string }).returning('id').executeTakeFirstOrThrow();
    await this.audit.record({ actorType: 'passenger', actorId: p.id, action: 'passenger.signed_up', recordType: 'passenger', recordId: p.id });
    return { status: 'signed_in', token: await this.token(p.id) };
  }

  /** TC-08: lost phone → sign in with an email code. Same reply whether or not the email exists. */
  async sendRecoveryCode(emailIn: unknown) {
    const email = this.emailOrThrow(emailIn);
    const p = await this.db.selectFrom('passengers').select('id').where((eb) => eb(eb.fn('lower', ['email']), '=', email)).executeTakeFirst();
    if (!p) return { ticket: null, message: 'If this email has an account, a code has been sent.' };
    const r = await this.otp.send({ audience: 'passenger', purpose: 'recover', target: email, channel: 'email' });
    return { ticket: r.ticket, message: 'If this email has an account, a code has been sent.' };
  }

  async verifyRecovery(ticket: string, code: string) {
    const { target: email } = await this.otp.verify(ticket, code, 'passenger', 'recover');
    const p = await this.db.selectFrom('passengers').selectAll().where((eb) => eb(eb.fn('lower', ['email']), '=', email)).executeTakeFirstOrThrow();
    await this.audit.record({ actorType: 'passenger', actorId: p.id, action: 'passenger.recovered_by_email', recordType: 'passenger', recordId: p.id });
    return { status: 'signed_in', token: await this.token(p.id) };
  }

  async sendChangePhoneCode(passengerId: string, phoneIn: unknown) {
    const phone = this.phoneOrThrow(phoneIn);
    const used = await this.db.selectFrom('passengers').select('id').where('phone', '=', phone).executeTakeFirst();
    if (used) throw conflict('PHONE_TAKEN', 'This phone number already has an account.');
    const r = await this.otp.send({ audience: 'passenger', purpose: 'change_phone', target: phone, channel: 'whatsapp', context: { passengerId } });
    return { ticket: r.ticket };
  }

  async verifyChangePhone(passengerId: string, ticket: string, code: string) {
    const { target: phone, context } = await this.otp.verify(ticket, code, 'passenger', 'change_phone');
    if (context.passengerId !== passengerId) throw badInput('WRONG_CODE', 'The code is not correct or has expired.');
    const before = await this.db.selectFrom('passengers').select('phone').where('id', '=', passengerId).executeTakeFirstOrThrow();
    await this.db.updateTable('passengers').set({ phone, updated_at: new Date() }).where('id', '=', passengerId).execute();
    await this.audit.record({ actorType: 'passenger', actorId: passengerId, action: 'passenger.phone_changed', recordType: 'passenger', recordId: passengerId, before: { phone: before.phone }, after: { phone } });
    return { phone };
  }
}
