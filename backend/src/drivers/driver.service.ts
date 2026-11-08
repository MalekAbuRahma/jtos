import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Kysely } from 'kysely';
import { AuditService } from '../common/audit.service';
import { sha256 } from '../common/crypto';
import { isDate, jordanDate } from '../common/dates';
import { badInput, conflict } from '../common/errors';
import { OtpService } from '../common/otp.service';
import { normalizePhone } from '../common/phone';
import { DB_TOKEN } from '../common/tokens';
import { DB, DocType } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { currentDocs } from './driver-documents.repo';
import { EligibilityService } from './eligibility.service';
import { ALL_TYPES, applicationChecks, DOC_LABELS, EXPIRING, expiryWarnings, VehicleIn, vehicleProblems } from './rules';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FILE = 5 * 1024 * 1024;
const MIMES = ['image/jpeg', 'image/png', 'application/pdf'];
const EDITABLE = ['draft', 'sent_back', 'rejected'];

type Driver = { id: string; status: string; phone: string; full_name: string | null; email: string | null };

/** T-002 submit driver and vehicle; T-004 renewals and car changes. */
@Injectable()
export class DriverService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    private otp: OtpService,
    private jwt: JwtService,
    private audit: AuditService,
    private settings: SettingsService,
    private eligibility: EligibilityService,
  ) {}

  // ---------- sign-in (same code rules as passengers) ----------
  async sendCode(phoneIn: unknown, channel: unknown) {
    const phone = normalizePhone(phoneIn);
    if (!phone) throw badInput('BAD_PHONE', 'Enter a valid phone number, e.g. +962 79 123 4567.');
    const ch = channel === 'sms' ? 'sms' : 'whatsapp';
    const r = await this.otp.send({ audience: 'driver', purpose: 'login', target: phone, channel: ch });
    return { ticket: r.ticket, channel: ch, expiresAt: r.expiresAt };
  }

  async verifyCode(ticket: string, code: string) {
    const { target: phone } = await this.otp.verify(ticket, code, 'driver', 'login');
    let d = await this.db.selectFrom('drivers').select('id').where('phone', '=', phone).executeTakeFirst();
    if (!d) {
      d = await this.db.insertInto('drivers').values({ phone, email: null, full_name: null, rating_avg: null }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record({ actorType: 'driver', actorId: d.id, action: 'driver.registered', recordType: 'driver', recordId: d.id });
    }
    return { token: await this.jwt.signAsync({ sub: d.id, aud: 'driver' }, { expiresIn: '30d' }) };
  }

  // ---------- my application ----------
  async me(driver: Driver) {
    const { values } = await this.settings.versionAt();
    const today = jordanDate();
    const vehicles = await this.db.selectFrom('vehicles').selectAll().where('driver_id', '=', driver.id).where('status', 'in', ['active', 'pending']).execute();
    const docs = await this.db.selectFrom('driver_documents').select(['id', 'type', 'expires_at', 'status', 'review_note', 'created_at'])
      .where('driver_id', '=', driver.id).where('status', '!=', 'superseded').orderBy('created_at', 'desc').execute();
    const latestApp = await this.db.selectFrom('driver_applications').selectAll().where('driver_id', '=', driver.id).orderBy('submitted_at', 'desc').limit(1).executeTakeFirst();
    const usable = await currentDocs(this.db, driver.id, driver.status === 'approved' ? ['approved'] : ['approved', 'pending']);
    const vehicle = vehicles.find((v) => v.status === (driver.status === 'approved' ? 'active' : 'pending')) ?? vehicles[0] ?? null;
    const checks = driver.status === 'approved' ? [] : applicationChecks({ fullName: driver.full_name, vehicle, docs: usable, settings: values, today });
    const elig = await this.eligibility.check(driver.id, today);
    return {
      id: driver.id, phone: driver.phone, fullName: driver.full_name, email: driver.email, status: driver.status,
      lastDecisionNote: latestApp?.status === 'sent_back' || latestApp?.status === 'rejected' ? latestApp.note : null,
      vehicle, pendingVehicleChange: driver.status === 'approved' ? vehicles.find((v) => v.status === 'pending') ?? null : null,
      documents: docs.map((d) => ({ id: d.id, type: d.type, label: DOC_LABELS[d.type], expiresAt: d.expires_at, status: d.status, note: d.review_note })),
      checklist: checks, readyToSubmit: checks.length > 0 && checks.every((c) => c.ok),
      earliestExpiry: elig.earliestExpiry,
      warnings: expiryWarnings(Object.values(usable).filter(Boolean) as any, today, values.documentWarningDays as number),
    };
  }

  async updateProfile(driver: Driver, fullName: unknown, email: unknown) {
    if (typeof fullName !== 'string' || fullName.trim().length < 2) throw badInput('NAME_REQUIRED', 'Enter your full name as on your ID.');
    if (email != null && email !== '' && (typeof email !== 'string' || !EMAIL_RE.test(email))) throw badInput('BAD_EMAIL', 'Enter a valid email address.');
    if (driver.status === 'approved' && driver.full_name && driver.full_name !== fullName.trim())
      throw badInput('NAME_LOCKED', 'Your name is checked against your ID. Contact Support to change it.');
    await this.db.updateTable('drivers').set({ full_name: fullName.trim(), email: (email as string) || null, updated_at: new Date() }).where('id', '=', driver.id).execute();
    return { ok: true };
  }

  /** Before approval: edit the car. After approval: a car change goes to review; the old car stays active (T-004). */
  async saveVehicle(driver: Driver, body: Partial<VehicleIn>) {
    const { values } = await this.settings.versionAt();
    const v: Partial<VehicleIn> = { ...body, year: Number(body.year), seats: Number(body.seats), make: body.make?.trim(), model: body.model?.trim(), colour: body.colour?.trim(), plate: body.plate?.trim().toUpperCase() };
    const problems = vehicleProblems(v, values, jordanDate());
    if (problems.length) throw badInput('VEHICLE_RULES', problems.join(' '));
    const fields = { type: v.type!, make: v.make!, model: v.model!, year: v.year!, colour: v.colour!, plate: v.plate!, seats: v.seats! };
    if (driver.status === 'submitted') throw conflict('UNDER_REVIEW', 'Your application is being reviewed. You can change it after the decision.');
    if (driver.status === 'suspended') throw conflict('SUSPENDED', 'Your account is suspended. Contact Support.');
    return this.db.transaction().execute(async (trx) => {
      const pending = await trx.selectFrom('vehicles').select('id').where('driver_id', '=', driver.id).where('status', '=', 'pending').executeTakeFirst();
      if (driver.status !== 'approved') {
        if (pending) await trx.updateTable('vehicles').set({ ...fields, updated_at: new Date() }).where('id', '=', pending.id).execute();
        else await trx.insertInto('vehicles').values({ driver_id: driver.id, ...fields }).execute();
        return { status: 'saved' };
      }
      if (pending) throw conflict('CHANGE_PENDING', 'A car change is already waiting for review.');
      const nv = await trx.insertInto('vehicles').values({ driver_id: driver.id, ...fields }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('driver_applications').values({ driver_id: driver.id, kind: 'vehicle_change', vehicle_id: nv.id, decided_at: null, decided_by: null, note: null, document_notes: null }).execute();
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'driver.vehicle_change_requested', recordType: 'vehicle', recordId: nv.id, after: fields }, trx);
      return { status: 'sent_for_review', message: 'Your new car will be checked. Keep using your current car until it is approved.' };
    });
  }

  async uploadDocument(driver: Driver, type: unknown, expiresAt: unknown, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (!ALL_TYPES.includes(type as DocType)) throw badInput('BAD_TYPE', 'Unknown document type.');
    const t = type as DocType;
    if (!file?.buffer?.length) throw badInput('NO_FILE', 'Attach a photo or PDF of the document.');
    if (!MIMES.includes(file.mimetype)) throw badInput('BAD_FILE', 'Use a JPG, PNG or PDF file.');
    if (file.size > MAX_FILE) throw badInput('FILE_TOO_BIG', 'The file must be 5 MB or smaller.');
    const today = jordanDate();
    let exp: string | null = null;
    if (EXPIRING.includes(t)) {
      if (!isDate(expiresAt)) throw badInput('EXPIRY_REQUIRED', `Enter the expiry date of your ${DOC_LABELS[t].toLowerCase()}.`);
      if (expiresAt < today) throw badInput('ALREADY_EXPIRED', `This ${DOC_LABELS[t].toLowerCase()} has already expired.`);
      exp = expiresAt;
    } else if (isDate(expiresAt)) exp = expiresAt;
    if (driver.status === 'submitted') throw conflict('UNDER_REVIEW', 'Your application is being reviewed. You can change it after the decision.');
    return this.db.transaction().execute(async (trx) => {
      const blob = await trx.insertInto('file_blobs').values({ owner_type: 'driver', owner_id: driver.id, mime: file.mimetype, size_bytes: file.size, sha256: sha256(file.buffer.toString('base64')), data: file.buffer }).returning('id').executeTakeFirstOrThrow();
      // An older document of the same type that is still waiting is replaced.
      await trx.updateTable('driver_documents').set({ status: 'superseded' }).where('driver_id', '=', driver.id).where('type', '=', t).where('status', 'in', ['pending', 'rejected']).execute();
      const doc = await trx.insertInto('driver_documents').values({ driver_id: driver.id, type: t, file_id: blob.id, expires_at: exp, review_note: null, expiry_warned_at: null }).returning('id').executeTakeFirstOrThrow();
      if (driver.status === 'approved') {
        // Renewal: goes to the same review queue; the old document stays in force until approved (T-004 TC-04).
        await trx.insertInto('driver_applications').values({ driver_id: driver.id, kind: 'renewal', document_ids: [doc.id], vehicle_id: null, decided_at: null, decided_by: null, note: null, document_notes: null }).execute();
      }
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'driver.document_uploaded', recordType: 'driver_document', recordId: doc.id, after: { type: t, expiresAt: exp } }, trx);
      return { id: doc.id, type: t, expiresAt: exp, status: 'pending', forReview: driver.status === 'approved' };
    });
  }

  async submit(driver: Driver) {
    if (!EDITABLE.includes(driver.status)) throw conflict('CANNOT_SUBMIT', driver.status === 'submitted' ? 'Your application is already waiting for review.' : 'Your account is already approved.');
    const { values } = await this.settings.versionAt();
    const vehicle = await this.db.selectFrom('vehicles').selectAll().where('driver_id', '=', driver.id).where('status', '=', 'pending').executeTakeFirst();
    const docs = await currentDocs(this.db, driver.id, ['pending', 'approved']);
    const checks = applicationChecks({ fullName: driver.full_name, vehicle: vehicle ?? null, docs, settings: values, today: jordanDate() });
    const missing = checks.filter((c) => !c.ok);
    if (missing.length) throw badInput('NOT_READY', `Before you submit: ${missing.map((c) => c.detail ?? c.label).join('; ')}.`);
    return this.db.transaction().execute(async (trx) => {
      const app = await trx.insertInto('driver_applications').values({
        driver_id: driver.id, kind: 'initial', vehicle_id: vehicle!.id, document_ids: Object.values(docs).map((d) => d!.id),
        decided_at: null, decided_by: null, note: null, document_notes: null,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('drivers').set({ status: 'submitted', updated_at: new Date() }).where('id', '=', driver.id).execute();
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'driver.application_submitted', recordType: 'driver_application', recordId: app.id }, trx);
      return { applicationId: app.id, status: 'submitted', message: "Thanks! We'll review your application within 48 hours." };
    });
  }
}
