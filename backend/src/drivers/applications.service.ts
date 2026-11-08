import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AuditService } from '../common/audit.service';
import { jordanDate } from '../common/dates';
import { badInput, conflict, notFound } from '../common/errors';
import { MessagingService } from '../common/messaging.service';
import { StaffUser } from '../common/staff-auth.guard';
import { DB_TOKEN } from '../common/tokens';
import { DB, DocType } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { applicationChecks, DOC_LABELS, expiryWarnings, vehicleProblems } from './rules';

export type Decision = 'approve' | 'send_back' | 'reject';
const KIND_LABEL = { initial: 'New driver', renewal: 'Document renewal', vehicle_change: 'Car change' } as const;

/** T-003 review queue and decisions; T-004 renewals and car changes in the same queue. */
@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    private audit: AuditService,
    private settings: SettingsService,
    private messaging: MessagingService,
  ) {}

  /** Oldest first, with waiting time and the 48 h target (A2 screen). */
  async queue(status = 'submitted') {
    const { values } = await this.settings.versionAt();
    const target = values.driverReviewTargetHours as number;
    const today = jordanDate();
    const rows = await this.db.selectFrom('driver_applications as a').innerJoin('drivers as d', 'd.id', 'a.driver_id')
      .leftJoin('vehicles as v', 'v.id', 'a.vehicle_id')
      .select(['a.id', 'a.kind', 'a.status', 'a.submitted_at', 'a.decided_at', 'a.document_ids', 'd.id as driverId', 'd.full_name', 'd.phone',
        'v.type as vType', 'v.make', 'v.model', 'v.year'])
      .where('a.status', '=', status as any).orderBy('a.submitted_at', 'asc').execute();
    const out = [];
    for (const r of rows) {
      const hours = (Date.now() - r.submitted_at.getTime()) / 3600_000;
      const docs = r.document_ids.length ? await this.db.selectFrom('driver_documents').select(['type', 'expires_at']).where('id', 'in', r.document_ids).execute() : [];
      const notes = expiryWarnings(docs as any, today, values.documentWarningDays as number);
      if (r.year && vehicleProblems({ type: r.vType!, make: 'x', model: 'x', colour: 'x', plate: 'x', year: r.year, seats: 1 }, values, today).length) notes.push(`Car older than ${values.carMaxAgeYears} years`);
      out.push({
        id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind], status: r.status, driverId: r.driverId, driverName: r.full_name, phone: r.phone,
        vehicle: r.make ? `${r.vType === 'van' ? 'Van' : 'Car'} · ${r.make} ${r.model} ${r.year}` : null,
        submittedAt: r.submitted_at, waitingHours: Math.floor(hours),
        target: status !== 'submitted' ? null : hours > target ? 'overdue' : hours > target - 4 ? 'due_soon' : 'on_time',
        warnings: notes,
      });
    }
    return out;
  }

  async detail(id: string) {
    const a = await this.find(id);
    const { values } = await this.settings.versionAt();
    const d = await this.db.selectFrom('drivers').selectAll().where('id', '=', a.driver_id).executeTakeFirstOrThrow();
    const vehicle = a.vehicle_id ? await this.db.selectFrom('vehicles').selectAll().where('id', '=', a.vehicle_id).executeTakeFirst() : null;
    const activeVehicle = await this.db.selectFrom('vehicles').selectAll().where('driver_id', '=', a.driver_id).where('status', '=', 'active').executeTakeFirst();
    const docs = a.document_ids.length ? await this.db.selectFrom('driver_documents').select(['id', 'type', 'expires_at', 'status', 'review_note', 'created_at']).where('id', 'in', a.document_ids).execute() : [];
    const history = await this.db.selectFrom('driver_applications').select(['id', 'kind', 'status', 'submitted_at', 'decided_at', 'note'])
      .where('driver_id', '=', a.driver_id).where('id', '!=', a.id).orderBy('submitted_at', 'desc').execute();
    return {
      id: a.id, kind: a.kind, kindLabel: KIND_LABEL[a.kind], status: a.status, submittedAt: a.submitted_at, decidedAt: a.decided_at, note: a.note,
      driver: { id: d.id, fullName: d.full_name, phone: d.phone, email: d.email, status: d.status },
      vehicle, currentVehicle: a.kind === 'vehicle_change' ? activeVehicle : null,
      documents: docs.map((x) => ({ id: x.id, type: x.type, label: DOC_LABELS[x.type], expiresAt: x.expires_at, status: x.status, note: x.review_note })),
      checks: await this.checks(a, values),
      history,
    };
  }

  /** Document file for the viewer. Every view is written to the audit history (T-003 TC-10). */
  async documentFile(staff: StaffUser, docId: string, ip?: string) {
    const row = await this.db.selectFrom('driver_documents as d').innerJoin('file_blobs as f', 'f.id', 'd.file_id')
      .select(['d.id', 'd.driver_id', 'd.type', 'f.mime', 'f.data']).where('d.id', '=', docId).executeTakeFirst().catch(() => undefined);
    if (!row) throw notFound('Document');
    await this.audit.record({ actorType: 'staff', actorId: staff.id, action: 'document.viewed', recordType: 'driver_document', recordId: docId, after: { driverId: row.driver_id, type: row.type }, ip });
    return row;
  }

  async decide(staff: StaffUser, id: string, decision: Decision, note?: string, documentNotes?: Record<string, string>, ip?: string) {
    if (!['approve', 'send_back', 'reject'].includes(decision)) throw badInput('BAD_DECISION', 'Choose approve, send back or reject.');
    const cleanNote = typeof note === 'string' ? note.trim() : '';
    if (decision !== 'approve' && !cleanNote) throw badInput('NOTE_REQUIRED', 'Write a note to the driver explaining what to fix.');
    const result = await this.db.transaction().execute(async (trx) => {
      const a = await trx.selectFrom('driver_applications').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!a) throw notFound('Application');
      if (a.status !== 'submitted') throw conflict('ALREADY_DECIDED', 'This application already has a decision.');
      if (decision === 'send_back' && a.kind !== 'initial') throw badInput('USE_REJECT', 'For renewals and car changes, use Reject with a note.');
      const { values } = await this.settings.versionAt();
      if (decision === 'approve') {
        const failed = (await this.checks(a, values)).filter((c) => !c.ok);
        if (failed.length) throw badInput('CHECKS_FAILED', `Can't approve: ${failed.map((c) => c.detail ?? c.label).join('; ')}.`);
      }
      const status = decision === 'approve' ? 'approved' : decision === 'send_back' ? 'sent_back' : 'rejected';
      await trx.updateTable('driver_applications').set({ status, decided_at: new Date(), decided_by: staff.id, note: cleanNote || null, document_notes: documentNotes ? JSON.stringify(documentNotes) : null }).where('id', '=', id).execute();

      const docIds = a.document_ids;
      if (decision === 'approve') {
        if (docIds.length) {
          const docs = await trx.selectFrom('driver_documents').select(['id', 'type']).where('id', 'in', docIds).execute();
          await trx.updateTable('driver_documents').set({ status: 'superseded' }).where('driver_id', '=', a.driver_id).where('status', '=', 'approved').where('type', 'in', docs.map((d) => d.type)).execute();
          await trx.updateTable('driver_documents').set({ status: 'approved' }).where('id', 'in', docIds).execute();
        }
        if (a.vehicle_id) {
          await trx.updateTable('vehicles').set({ status: 'retired', updated_at: new Date() }).where('driver_id', '=', a.driver_id).where('status', '=', 'active').execute();
          await trx.updateTable('vehicles').set({ status: 'active', updated_at: new Date() }).where('id', '=', a.vehicle_id).execute();
        }
        if (a.kind === 'initial') await trx.updateTable('drivers').set({ status: 'approved', updated_at: new Date() }).where('id', '=', a.driver_id).execute();
      } else {
        if (a.kind === 'initial') {
          await trx.updateTable('drivers').set({ status: status as 'sent_back' | 'rejected', updated_at: new Date() }).where('id', '=', a.driver_id).execute();
          for (const [docId, n] of Object.entries(documentNotes ?? {}))
            if (docIds.includes(docId)) await trx.updateTable('driver_documents').set({ status: 'rejected', review_note: String(n) }).where('id', '=', docId).execute();
        } else {
          if (docIds.length) await trx.updateTable('driver_documents').set({ status: 'rejected', review_note: cleanNote }).where('id', 'in', docIds).execute();
          if (a.vehicle_id) await trx.updateTable('vehicles').set({ status: 'rejected', updated_at: new Date() }).where('id', '=', a.vehicle_id).execute();
        }
      }
      await this.audit.record({ actorType: 'staff', actorId: staff.id, action: `driver_application.${status}`, recordType: 'driver_application', recordId: id, after: { kind: a.kind, note: cleanNote || null, documentNotes: documentNotes ?? null }, ip }, trx);
      return { a, status };
    });
    const d = await this.db.selectFrom('drivers').select(['id', 'phone']).where('id', '=', result.a.driver_id).executeTakeFirstOrThrow();
    const what = KIND_LABEL[result.a.kind].toLowerCase();
    const body = result.status === 'approved'
      ? (result.a.kind === 'initial' ? 'You are approved! You can now publish trips.' : `Your ${what} is approved.`)
      : `Your ${what} was ${result.status === 'sent_back' ? 'sent back' : 'not approved'}: ${cleanNote}`;
    await this.messaging.send({ channel: 'push', to: d.phone, recipientType: 'driver', recipientId: d.id, template: `driver_application_${result.status}`, body });
    return { id, status: result.status };
  }

  private async find(id: string) {
    const a = await this.db.selectFrom('driver_applications').selectAll().where('id', '=', id).executeTakeFirst().catch(() => undefined);
    if (!a) throw notFound('Application');
    return a;
  }

  /** Automatic checks shown on A3 and enforced on Approve. */
  private async checks(a: { kind: string; driver_id: string; document_ids: string[]; vehicle_id: string | null }, values: Record<string, number | boolean>) {
    const today = jordanDate();
    const d = await this.db.selectFrom('drivers').select('full_name').where('id', '=', a.driver_id).executeTakeFirstOrThrow();
    const appDocs = a.document_ids.length ? await this.db.selectFrom('driver_documents').selectAll().where('id', 'in', a.document_ids).execute() : [];
    const vehicle = a.vehicle_id ? await this.db.selectFrom('vehicles').selectAll().where('id', '=', a.vehicle_id).executeTakeFirst() : null;
    if (a.kind === 'initial') {
      const docs: Partial<Record<DocType, { expires_at: string | null }>> = {};
      for (const x of appDocs) if (x.status !== 'superseded' && x.status !== 'rejected') docs[x.type] = x;
      return applicationChecks({ fullName: d.full_name, vehicle: vehicle ?? null, docs, settings: values, today });
    }
    if (a.kind === 'renewal') return appDocs.map((x) => ({ key: `exp_${x.type}`, label: `${DOC_LABELS[x.type]} not expired`, ok: !x.expires_at || x.expires_at >= today, detail: x.expires_at ? `Expires ${x.expires_at}` : undefined }));
    const vp = vehicle ? vehicleProblems(vehicle, values, today) : ['Vehicle missing.'];
    return [{ key: 'vehicle', label: 'Vehicle meets the rules', ok: vp.length === 0, detail: vp.join(' ') || undefined }];
  }
}
