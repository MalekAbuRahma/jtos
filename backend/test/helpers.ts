import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/crypto';
import { EmailService } from '../src/common/email.service';
import { MessagingService } from '../src/common/messaging.service';
import { AppConfig } from '../src/config';
import { createDb } from '../src/db/database';
import { migrate } from '../src/db/migrate';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://jtos:jtos@localhost:5432/jtos_test';
export const PASSWORD = 'correct-horse-battery';

export async function resetDb() {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_DB, false);
}

export async function buildApp() {
  const cfg: AppConfig = { databaseUrl: TEST_DB, jwtSecret: 'test-secret-at-least-16', emailDriver: 'memory', staffSessionHours: 8 };
  const db = createDb(TEST_DB);
  const mod = await Test.createTestingModule({ imports: [AppModule.create(cfg, db)] }).compile();
  const app: INestApplication = mod.createNestApplication();
  await app.init();
  const email = app.get(EmailService);
  const messaging = app.get(MessagingService);
  const http = () => request(app.getHttpServer());

  /** Creates an active staff member directly (test setup only). */
  async function seedStaff(o: { email: string; name?: string; role: 'admin' | 'support' | 'auditor' | null; main?: boolean }) {
    return db.insertInto('staff').values({
      email: o.email, full_name: o.name ?? o.email.split('@')[0], role: o.role, is_main_admin: !!o.main,
      status: 'active', password_hash: await hashPassword(PASSWORD), locked_until: null,
    }).returning('id').executeTakeFirstOrThrow();
  }

  /** Full sign-in: password → emailed code → token. */
  async function signIn(addr: string, password = PASSWORD) {
    const r1 = await http().post('/v1/staff/auth/login').send({ email: addr, password }).expect(200);
    const mail = [...email.sent].reverse().find((m) => m.to === addr && m.template === 'staff_login_code')!;
    const code = mail.body.match(/(\d{6})/)![1];
    const r2 = await http().post('/v1/staff/auth/verify').send({ loginTicket: r1.body.loginTicket, code }).expect(200);
    return r2.body.token as string;
  }

  /** Latest code sent to a phone (WhatsApp/SMS) or email. */
  function lastCode(to: string): string {
    const all = [...messaging.sent.map((m) => ({ to: m.to, body: m.body })), ...email.sent.map((m) => ({ to: m.to, body: m.body }))];
    const m = all.reverse().find((x) => x.to === to && /code is \d{6}/.test(x.body));
    if (!m) throw new Error(`no code sent to ${to}`);
    return m.body.match(/code is (\d{6})/)![1];
  }

  return { app, db, email, messaging, http, seedStaff, signIn, lastCode, close: async () => { await app.close(); await db.destroy(); } };
}
