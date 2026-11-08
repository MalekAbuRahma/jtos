import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { CasesService } from '../cases/cases.service';
import { AuditService } from '../common/audit.service';
import { addDays, jordanDate } from '../common/dates';
import { badInput, conflict, notFound } from '../common/errors';
import { MessagingService } from '../common/messaging.service';
import { jordanHHMM } from '../common/time';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';

const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const REPORT_HOURS = 48;
const CASH_REASONS = ['passenger_did_not_pay', 'paid_but_shows_unpaid', 'wrong_amount'] as const;

/** Passenger and driver reports + T-035 cancel + T-023 late driver + data retention. */
@Injectable()
export class PassengerTripDayService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    private settings: SettingsService,
    private audit: AuditService,
    private messaging: MessagingService,
    private cases: CasesService,
  ) {}

  private async own(passengerId: string, bookingId: string) {
    if (!isUuid(bookingId)) throw notFound('Booking');
    const b = await this.db.selectFrom('bookings as b').innerJoin('booking_requests as r', 'r.id', 'b.request_id').innerJoin('trips as t', 't.id', 'b.trip_id')
      .select(['b.id', 'b.code', 'b.status', 'b.passenger_id', 'b.trip_id', 'b.request_id', 'r.seats', 'r.kind', 'r.board_seq', 't.driver_id', 't.completed_at', 't.status as tripStatus'])
      .where('b.id', '=', bookingId).executeTakeFirst();
    if (!b || b.passenger_id !== passengerId) throw notFound('Booking');
    return b;
  }

  // ---------- T-019 dispute ----------
  async disputeNoShow(passengerId: string, bookingId: string, statement: unknown) {
    const b = await this.own(passengerId, bookingId);
    if (typeof statement !== 'string' || statement.trim().length < 5) throw badInput('STATEMENT_REQUIRED', 'Tell us what happened, e.g. "I was at gate 3 at 07:05".');
    const marked = await this.db.selectFrom('travellers').select(['id', 'no_show_at']).where('request_id', '=', b.request_id).where('boarding_status', '=', 'no_show').where('type', '!=', 'baby').execute();
    if (!marked.length) throw conflict('NO_NO_SHOW', 'No one on this booking was marked as a no-show.');
    const latest = Math.max(...marked.map((x) => x.no_show_at!.getTime()));
    if (Date.now() - latest > REPORT_HOURS * 3600_000) throw conflict('TOO_LATE', 'Reports must be made within 48 hours.');
    const open = await this.db.selectFrom('cases').select('code').where('booking_id', '=', bookingId).where('type', '=', 'no_show_dispute').where('status', '!=', 'resolved').executeTakeFirst();
    if (open) return { caseCode: open.code, already: true };
    const c = await this.cases.open({ type: 'no_show_dispute', bookingId, travellerId: marked[0].id, reason: 'Passenger says: I was there', byType: 'passenger', byId: passengerId, statement });
    // The no-show doesn't count against the passenger while it's under review.
    await this.db.updateTable('warnings').set({ under_review: true }).where('ref_type', '=', 'traveller').where('ref_id', 'in', marked.map((x) => x.id)).execute();
    return { caseCode: c.code };
  }

  // ---------- T-027 cash case ----------
  async cashCase(who: { type: 'passenger' | 'driver'; id: string }, bookingId: string, reason: unknown, statement: unknown) {
    if (!isUuid(bookingId)) throw notFound('Booking');
    const b = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').select(['b.id', 'b.code', 'b.passenger_id', 't.driver_id', 't.completed_at'])
      .where('b.id', '=', bookingId).executeTakeFirst();
    if (!b || (who.type === 'passenger' ? b.passenger_id : b.driver_id) !== who.id) throw notFound('Booking');
    if (!CASH_REASONS.includes(reason as any)) throw badInput('BAD_REASON', 'Choose: passenger didn\'t pay, I paid but it shows unpaid, or wrong amount.');
    const since = b.completed_at ?? (await this.db.selectFrom('cash_records').select('at').where('booking_id', '=', bookingId).executeTakeFirst())?.at;
    if (!since) throw conflict('TOO_EARLY', 'You can report a payment problem after the trip.');
    if (Date.now() - since.getTime() > REPORT_HOURS * 3600_000) throw conflict('TOO_LATE', 'Reports must be made within 48 hours of the trip.');
    const existing = await this.db.selectFrom('cases').select(['id', 'code']).where('booking_id', '=', bookingId).where('type', '=', 'cash').where('status', '!=', 'resolved').executeTakeFirst();
    if (existing) {
      if (typeof statement === 'string' && statement.trim()) await this.cases.addStatement(existing.id, who, statement);
      return { caseCode: existing.code, already: true };
    }
    const c = await this.cases.open({ type: 'cash', bookingId, reason: String(reason), byType: who.type, byId: who.id, statement: typeof statement === 'string' ? statement : undefined });
    const other = who.type === 'passenger' ? await this.db.selectFrom('drivers').select(['id', 'phone']).where('id', '=', b.driver_id).executeTakeFirstOrThrow() : await this.db.selectFrom('passengers').select(['id', 'phone']).where('id', '=', b.passenger_id).executeTakeFirstOrThrow();
    await this.messaging.send({ channel: 'push', to: other.phone, recipientType: who.type === 'passenger' ? 'driver' : 'passenger', recipientId: other.id, template: 'cash_case_statement_request',
      body: `A payment question was opened for booking ${b.code} (case ${c.code}). Please add your side in the app.` });
    return { caseCode: c.code };
  }

  // ---------- T-035 cancel ----------
  private async cancelState(passengerId: string, bookingId: string) {
    const b = await this.own(passengerId, bookingId);
    const { values } = await this.settings.versionAt();
    const stop = await this.db.selectFrom('trip_stops').select(['arrived_at', 'late_notified_at', 'pickup_at']).where('trip_id', '=', b.trip_id).where('seq', '=', b.board_seq).executeTakeFirstOrThrow();
    const recent = Number((await this.db.selectFrom('warnings').select((eb) => eb.fn.countAll<number>().as('n')).where('subject_type', '=', 'passenger').where('subject_id', '=', passengerId)
      .where('kind', '=', 'booking_cancelled').where('void', '=', false).where('at', '>', new Date(Date.now() - 30 * 86400_000)).executeTakeFirstOrThrow()).n);
    const lateFree = !!stop.late_notified_at && !stop.arrived_at;
    return { b, stop, recent, lateFree, after: values.cancellationWarningAfter as number };
  }

  async cancelPreview(passengerId: string, bookingId: string) {
    const s = await this.cancelState(passengerId, bookingId);
    const can = ['awaiting_completion', 'confirmed'].includes(s.b.status) && !s.stop.arrived_at;
    return {
      canCancel: can, fee: 0, refund: 0, countsTowardWarning: !s.lateFree,
      message: !can ? (s.stop.arrived_at ? 'The driver has arrived at your stop, so the booking can no longer be cancelled.' : 'This booking can no longer be cancelled.')
        : s.lateFree ? 'Your driver is late, so cancelling is free and does not count toward your cancellation warning.'
        : `Cancelling is free. You've cancelled ${s.recent} booking${s.recent === 1 ? '' : 's'} in the last 30 days. After ${s.after} you'll get a warning.`,
    };
  }

  async cancel(passengerId: string, bookingId: string, reason?: unknown) {
    const s = await this.cancelState(passengerId, bookingId);
    if (!['awaiting_completion', 'confirmed'].includes(s.b.status)) throw conflict('BOOKING_CLOSED', 'This booking can no longer be cancelled.');
    if (s.stop.arrived_at) throw conflict('DRIVER_ARRIVED', 'The driver has arrived at your stop, so the booking can no longer be cancelled.');
    const forLateness = reason === 'driver_late';
    if (forLateness && !s.lateFree) throw badInput('NOT_LATE', 'Your driver is not marked late.');
    const counts = !s.lateFree;
    await this.db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('trips').select(['id']).where('id', '=', s.b.trip_id).forUpdate().executeTakeFirstOrThrow();
      const cur = await trx.selectFrom('bookings').select('status').where('id', '=', bookingId).forUpdate().executeTakeFirstOrThrow();
      if (!['awaiting_completion', 'confirmed'].includes(cur.status)) throw conflict('BOOKING_CLOSED', 'This booking can no longer be cancelled.');
      await trx.updateTable('bookings').set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: s.lateFree ? 'driver_late' : 'passenger', counts_toward_warning: counts, updated_at: new Date() }).where('id', '=', bookingId).execute();
      // Seats go back on sale (search only shows stops still open for booking).
      await trx.updateTable('trips').set((eb) => ({ seats_booked: eb('seats_booked', '-', s.b.seats), ...(s.b.kind === 'whole' ? { whole_taken: false } : {}) })).where('id', '=', t.id).execute();
      if (counts) await trx.insertInto('warnings').values({ subject_type: 'passenger', subject_id: passengerId, kind: 'booking_cancelled', ref_type: 'booking', ref_id: bookingId }).execute();
      await this.audit.record({ actorType: 'passenger', actorId: passengerId, action: 'booking.cancelled', recordType: 'booking', recordId: bookingId, after: { countsTowardWarning: counts, reason: s.lateFree ? 'driver_late' : 'passenger' } }, trx);
    });
    const d = await this.db.selectFrom('drivers').select(['id', 'phone']).where('id', '=', s.b.driver_id).executeTakeFirstOrThrow();
    await this.messaging.send({ channel: 'push', to: d.phone, recipientType: 'driver', recipientId: d.id, template: 'booking_cancelled', body: `Booking ${s.b.code} was cancelled by the passenger. The seats are free again.` });
    if (counts && s.recent + 1 > s.after) {
      const p = await this.db.selectFrom('passengers').select('phone').where('id', '=', passengerId).executeTakeFirstOrThrow();
      await this.messaging.send({ channel: 'push', to: p.phone, recipientType: 'passenger', recipientId: passengerId, template: 'cancellation_warning', body: `You have cancelled ${s.recent + 1} bookings in the last 30 days. Frequent cancellations may limit your account.` });
    }
    return { bookingId, status: 'cancelled', fee: 0, refund: 0, countsTowardWarning: counts };
  }

  // ---------- T-023 late driver (background) ----------
  async lateDrivers(now = new Date()): Promise<number> {
    const { values } = await this.settings.versionAt(now);
    const lateMs = (values.driverLateMinutes as number) * 60_000;
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('trips as t', 't.id', 's.trip_id').innerJoin('drivers as d', 'd.id', 't.driver_id')
      .select(['s.id', 's.trip_id', 's.seq', 's.pickup_at', 't.driver_id', 'd.phone', 'd.full_name'])
      .where('t.status', 'in', ['published', 'running']).where('s.arrived_at', 'is', null).where('s.late_notified_at', 'is', null)
      .where('s.section_price_fils', 'is not', null).where('s.pickup_at', '<=', new Date(now.getTime() - lateMs)).execute();
    let n = 0;
    for (const s of stops) {
      const bookers = await this.db.selectFrom('travellers as x').innerJoin('booking_requests as r', 'r.id', 'x.request_id').innerJoin('bookings as b', 'b.request_id', 'r.id')
        .select('b.passenger_id').distinct().where('r.trip_id', '=', s.trip_id).where('x.board_seq', '=', s.seq).where('b.status', '=', 'confirmed').execute();
      await this.db.updateTable('trip_stops').set({ late_notified_at: now }).where('id', '=', s.id).execute();
      if (!bookers.length) continue;
      n++;
      const name = (s.full_name ?? 'Your driver').split(/\s+/)[0];
      for (const b of bookers) {
        const p = await this.db.selectFrom('passengers').select('phone').where('id', '=', b.passenger_id).executeTakeFirstOrThrow();
        await this.messaging.send({ channel: 'push', to: p.phone, recipientType: 'passenger', recipientId: b.passenger_id, template: 'driver_late',
          body: `${name} is ${values.driverLateMinutes} minutes late (pickup was ${jordanHHMM(s.pickup_at)}). Keep waiting, or cancel for free — it won't count against you.` });
      }
      const already = await this.db.selectFrom('warnings').select('id').where('subject_type', '=', 'driver').where('subject_id', '=', s.driver_id).where('kind', '=', 'late').where('ref_id', '=', s.trip_id).executeTakeFirst();
      if (!already) {
        await this.db.insertInto('warnings').values({ subject_type: 'driver', subject_id: s.driver_id, kind: 'late', ref_type: 'trip', ref_id: s.trip_id }).execute();
        const windowDays = values.lateWarningWindowDays as number;
        const count = Number((await this.db.selectFrom('warnings').select((eb) => eb.fn.countAll<number>().as('n')).where('subject_type', '=', 'driver').where('subject_id', '=', s.driver_id)
          .where('kind', '=', 'late').where('void', '=', false).where('at', '>', new Date(now.getTime() - windowDays * 86400_000)).executeTakeFirstOrThrow()).n);
        if (count >= (values.lateWarningCount as number))
          await this.messaging.send({ channel: 'push', to: s.phone, recipientType: 'driver', recipientId: s.driver_id, template: 'late_warning', body: `You were late ${count} times in the last ${windowDays} days. Passengers rely on your times.` });
      }
    }
    return n;
  }

  async lateReport(days = 30) {
    return this.db.selectFrom('warnings as w').innerJoin('drivers as d', 'd.id', 'w.subject_id').select(['d.id', 'd.full_name as name', 'd.phone'])
      .select((eb) => eb.fn.countAll<number>().as('lateCount')).where('w.subject_type', '=', 'driver').where('w.kind', '=', 'late').where('w.void', '=', false)
      .where('w.at', '>', new Date(Date.now() - days * 86400_000)).groupBy(['d.id', 'd.full_name', 'd.phone']).orderBy('lateCount', 'desc').execute();
  }

  // ---------- Q04 retention (background) ----------
  async deleteOldTravellerData(now = new Date()): Promise<number> {
    const { values } = await this.settings.versionAt(now);
    const before = addDays(jordanDate(now), -(values.travellerDataDeleteDays as number));
    const r = await this.db.updateTable('travellers').set({ doc_number_enc: null, doc_hash: null, date_of_birth: null, doc_expiry: null, contact: null, personal_deleted_at: now })
      .where('personal_deleted_at', 'is', null)
      .where('request_id', 'in', (eb) => eb.selectFrom('booking_requests as r').innerJoin('trips as t', 't.id', 'r.trip_id').select('r.id').where('t.travel_date', '<', before))
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}
