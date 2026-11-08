import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { AuditService } from '../common/audit.service';
import { badInput, conflict, notFound } from '../common/errors';
import { MessagingService } from '../common/messaging.service';
import { StaffUser } from '../common/staff-auth.guard';
import { maskContacts } from '../common/text';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';

export type CaseType = 'cash' | 'no_show_dispute' | 'correction_request' | 'other';
const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const NON_PAYMENT_REVIEW = 3;

/** Support cases (T-019 dispute, T-021 correction request, T-027 cash). No case creates a charge or debt. */
@Injectable()
export class CasesService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private audit: AuditService, private messaging: MessagingService, private settings: SettingsService) {}

  async open(o: { type: CaseType; bookingId?: string | null; travellerId?: string | null; reason?: string; byType: string; byId?: string | null; statement?: string; status?: 'open' | 'for_admin' }, trx?: Transaction<DB>) {
    const db = trx ?? this.db;
    const n = await sql<{ n: string }>`select nextval('case_number') as n`.execute(db);
    const c = await db.insertInto('cases').values({
      code: `C-${n.rows[0].n}`, type: o.type, booking_id: o.bookingId ?? null, traveller_id: o.travellerId ?? null, status: o.status ?? 'open',
      reason: o.reason ?? null, opened_by_type: o.byType, opened_by_id: o.byId ?? null, resolution_note: null, resolved_by: null, resolved_at: null,
    }).returning(['id', 'code']).executeTakeFirstOrThrow();
    if (o.statement?.trim()) await db.insertInto('case_statements').values({ case_id: c.id, author_type: o.byType, author_id: o.byId ?? null, text: maskContacts(o.statement.trim()).slice(0, 2000) }).execute();
    await this.audit.record({ actorType: (['staff', 'driver', 'passenger'].includes(o.byType) ? o.byType : 'system') as any, actorId: o.byId ?? null, action: 'case.opened', recordType: 'case', recordId: c.id, after: { code: c.code, type: o.type, reason: o.reason } }, trx);
    return c;
  }

  /** Booker or driver adds their own statement (kept separately). */
  async addStatement(caseId: string, who: { type: 'passenger' | 'driver'; id: string }, text: unknown) {
    if (!isUuid(caseId)) throw notFound('Case');
    if (typeof text !== 'string' || !text.trim()) throw badInput('TEXT_REQUIRED', 'Write what happened.');
    const c = await this.caseFor(caseId, who);
    if (c.status === 'resolved') throw conflict('CASE_CLOSED', 'This case is closed.');
    await this.db.insertInto('case_statements').values({ case_id: caseId, author_type: who.type, author_id: who.id, text: maskContacts(text.trim()).slice(0, 2000) }).execute();
    if (c.status === 'waiting_reply') await this.db.updateTable('cases').set({ status: 'open' }).where('id', '=', caseId).execute();
    return { ok: true };
  }

  /** A passenger/driver may only see cases on their own bookings. */
  private async caseFor(caseId: string, who: { type: 'passenger' | 'driver'; id: string }) {
    const c = await this.db.selectFrom('cases as c').leftJoin('bookings as b', 'b.id', 'c.booking_id').leftJoin('trips as t', 't.id', 'b.trip_id')
      .select(['c.id', 'c.code', 'c.type', 'c.status', 'c.reason', 'c.created_at', 'c.resolution_note', 'b.passenger_id', 't.driver_id']).where('c.id', '=', caseId).executeTakeFirst();
    if (!c || (who.type === 'passenger' ? c.passenger_id : c.driver_id) !== who.id) throw notFound('Case');
    return c;
  }

  async mine(who: { type: 'passenger' | 'driver'; id: string }) {
    let q = this.db.selectFrom('cases as c').innerJoin('bookings as b', 'b.id', 'c.booking_id').innerJoin('trips as t', 't.id', 'b.trip_id')
      .select(['c.id', 'c.code', 'c.type', 'c.status', 'c.reason', 'c.created_at as createdAt', 'c.resolution_note as resolution', 'b.code as bookingCode']);
    q = who.type === 'passenger' ? q.where('b.passenger_id', '=', who.id) : q.where('t.driver_id', '=', who.id);
    return q.orderBy('c.created_at', 'desc').limit(100).execute();
  }

  // ---------- staff (A5) ----------
  list(status?: string) {
    let q = this.db.selectFrom('cases as c').leftJoin('bookings as b', 'b.id', 'c.booking_id')
      .select(['c.id', 'c.code', 'c.type', 'c.status', 'c.reason', 'c.created_at as createdAt', 'b.code as bookingCode']).orderBy('c.created_at', 'desc').limit(200);
    if (status === 'open') q = q.where('c.status', '!=', 'resolved');
    else if (status) q = q.where('c.status', '=', status as any);
    return q.execute();
  }

  async detail(id: string) {
    if (!isUuid(id)) throw notFound('Case');
    const c = await this.db.selectFrom('cases').selectAll().where('id', '=', id).executeTakeFirst();
    if (!c) throw notFound('Case');
    const statements = await this.db.selectFrom('case_statements').select(['author_type as authorType', 'text', 'created_at as at']).where('case_id', '=', id).orderBy('created_at').execute();
    let booking = null, cash = null, travellers: any[] = [], contactAttempts: any[] = [], stopEvents: any[] = [];
    if (c.booking_id) {
      booking = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').innerJoin('drivers as d', 'd.id', 't.driver_id').innerJoin('passengers as p', 'p.id', 'b.passenger_id')
        .select(['b.id', 'b.code', 'b.status', 'b.total_fils as total', 't.travel_date as date', 't.id as tripId', 'd.full_name as driverName', 'p.full_name as bookerName']).where('b.id', '=', c.booking_id).executeTakeFirst();
      cash = await this.db.selectFrom('cash_records').selectAll().where('booking_id', '=', c.booking_id).executeTakeFirst() ?? null;
      const req = await this.db.selectFrom('bookings').select('request_id').where('id', '=', c.booking_id).executeTakeFirstOrThrow();
      travellers = await this.db.selectFrom('travellers').select(['id', 'full_name as fullName', 'type', 'boarding_status as boarding', 'boarded_at as boardedAt', 'no_show_at as noShowAt', 'board_seq as boardSeq']).where('request_id', '=', req.request_id).execute();
      contactAttempts = await this.db.selectFrom('contact_attempts').select(['kind', 'at']).where('booking_id', '=', c.booking_id).orderBy('at').execute();
      if (booking) stopEvents = await this.db.selectFrom('trip_stops').select(['seq', 'pickup_at as pickupAt', 'arrived_at as arrivedAt', 'left_at as leftAt']).where('trip_id', '=', booking.tripId).orderBy('seq').execute();
    }
    return { ...c, statements, booking, cash, travellers, contactAttempts, stops: stopEvents };
  }

  async askReply(staff: StaffUser, id: string) {
    const c = await this.detail(id);
    if (c.status === 'resolved') throw conflict('CASE_CLOSED', 'This case is closed.');
    await this.db.updateTable('cases').set({ status: 'waiting_reply' }).where('id', '=', id).execute();
    await this.audit.record({ actorType: 'staff', actorId: staff.id, action: 'case.asked_reply', recordType: 'case', recordId: id });
    return { id, status: 'waiting_reply' };
  }

  /** Resolve with a note; optionally warn one side. 3 confirmed non-payments → passenger goes to admin review. */
  async resolve(staff: StaffUser, id: string, note: unknown, warn?: unknown) {
    if (typeof note !== 'string' || !note.trim()) throw badInput('NOTE_REQUIRED', 'Write how the case was resolved.');
    if (warn != null && warn !== 'passenger' && warn !== 'driver') throw badInput('BAD_WARN', 'Warn the passenger or the driver.');
    const c = await this.detail(id);
    if (c.status === 'resolved') throw conflict('CASE_CLOSED', 'This case is already resolved.');
    await this.db.updateTable('cases').set({ status: 'resolved', resolution_note: note.trim(), resolved_by: staff.id, resolved_at: new Date() }).where('id', '=', id).execute();
    if (c.type === 'no_show_dispute' && c.traveller_id) {
      await this.db.updateTable('warnings').set({ under_review: false }).where('ref_type', '=', 'traveller').where('ref_id', '=', c.traveller_id).execute();
    }
    if (warn && c.booking) {
      const b = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').select(['b.passenger_id', 't.driver_id']).where('b.id', '=', c.booking.id).executeTakeFirstOrThrow();
      const subjectId = warn === 'passenger' ? b.passenger_id : b.driver_id;
      const kind = c.type === 'cash' ? 'non_payment' : 'case_warning';
      await this.db.insertInto('warnings').values({ subject_type: warn, subject_id: subjectId, kind, ref_type: 'case', ref_id: id }).execute();
      const phone = warn === 'passenger' ? (await this.db.selectFrom('passengers').select('phone').where('id', '=', subjectId).executeTakeFirstOrThrow()).phone : (await this.db.selectFrom('drivers').select('phone').where('id', '=', subjectId).executeTakeFirstOrThrow()).phone;
      await this.messaging.send({ channel: 'push', to: phone, recipientType: warn, recipientId: subjectId, template: 'case_warning', body: `After reviewing case ${c.code}, we've added a warning to your account: ${note.trim()}` });
      if (warn === 'passenger' && kind === 'non_payment') {
        const n = Number((await this.db.selectFrom('warnings').select((eb) => eb.fn.countAll<number>().as('n')).where('subject_type', '=', 'passenger').where('subject_id', '=', subjectId).where('kind', '=', 'non_payment').where('void', '=', false).executeTakeFirstOrThrow()).n);
        if (n >= NON_PAYMENT_REVIEW) await this.db.updateTable('passengers').set({ status: 'under_review' }).where('id', '=', subjectId).execute();
      }
    }
    await this.audit.record({ actorType: 'staff', actorId: staff.id, action: 'case.resolved', recordType: 'case', recordId: id, after: { note: note.trim(), warn: warn ?? null } });
    return { id, status: 'resolved' };
  }
}
