import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Kysely } from 'kysely';
import { CasesService } from '../cases/cases.service';
import { AuditService } from '../common/audit.service';
import { badInput, conflict, notFound } from '../common/errors';
import { MessagingService } from '../common/messaging.service';
import { formatJod, isFils } from '../common/money';
import { StaffUser } from '../common/staff-auth.guard';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';

const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const STATUSES = ['pending', 'boarded', 'no_show'] as const;

/** T-021 service corrections and T-028 cash corrections: Admin only, reason required, history kept. */
@Injectable()
export class CorrectionsService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private audit: AuditService, private messaging: MessagingService, private cases: CasesService) {}

  private async tellBoth(bookingId: string, body: string) {
    const r = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').innerJoin('passengers as p', 'p.id', 'b.passenger_id').innerJoin('drivers as d', 'd.id', 't.driver_id')
      .select(['p.id as pid', 'p.phone as pphone', 'd.id as did', 'd.phone as dphone']).where('b.id', '=', bookingId).executeTakeFirstOrThrow();
    await this.messaging.send({ channel: 'push', to: r.pphone, recipientType: 'passenger', recipientId: r.pid, template: 'record_corrected', body });
    await this.messaging.send({ channel: 'push', to: r.dphone, recipientType: 'driver', recipientId: r.did, template: 'record_corrected', body });
  }

  private async traveller(id: unknown) {
    if (!isUuid(id)) throw notFound('Traveller');
    const x = await this.db.selectFrom('travellers as x').innerJoin('bookings as b', 'b.request_id', 'x.request_id').innerJoin('trips as t', 't.id', 'b.trip_id')
      .select(['x.id', 'x.idx', 'x.full_name', 'x.boarding_status', 'x.request_id', 'b.id as bookingId', 'b.code', 'b.status as bookingStatus', 'b.passenger_id', 't.status as tripStatus'])
      .where('x.id', '=', id).executeTakeFirst();
    if (!x) throw notFound('Traveller');
    return x;
  }

  async service(staff: StaffUser, travellerId: unknown, newStatus: unknown, reason: unknown, ip?: string) {
    if (!STATUSES.includes(newStatus as any)) throw badInput('BAD_STATUS', 'Choose boarded, no-show or pending.');
    if (typeof reason !== 'string' || !reason.trim()) throw badInput('REASON_REQUIRED', 'Write the reason for the correction.');
    const x = await this.traveller(travellerId);
    if (x.boarding_status === newStatus) throw conflict('NO_CHANGE', 'The record already shows this.');
    const before = { boarding: x.boarding_status, booking: x.bookingStatus };
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('travellers').set({ boarding_status: newStatus as any, ...(newStatus === 'no_show' ? { no_show_at: new Date() } : {}), ...(newStatus === 'boarded' ? { boarded_at: new Date() } : {}) })
        .where('request_id', '=', x.request_id).where((eb) => eb.or([eb('id', '=', x.id), eb.and([eb('type', '=', 'baby'), eb('lap_of_idx', '=', x.idx)])])).execute();
      if (x.boarding_status === 'no_show') await trx.updateTable('warnings').set({ void: true }).where('ref_type', '=', 'traveller').where('ref_id', '=', x.id).execute();
      let bookingAfter = x.bookingStatus;
      if (x.tripStatus === 'completed' && ['completed', 'no_show'].includes(x.bookingStatus)) {
        const anyBoarded = await trx.selectFrom('travellers').select('id').where('request_id', '=', x.request_id).where('boarding_status', '=', 'boarded').executeTakeFirst();
        bookingAfter = anyBoarded ? 'completed' : 'no_show';
        await trx.updateTable('bookings').set({ status: bookingAfter as any, updated_at: new Date() }).where('id', '=', x.bookingId).execute();
        // A rating given on a trip that turns out not to have happened is hidden for review (T-021).
        if (bookingAfter === 'no_show') await trx.updateTable('ratings').set({ hidden: true }).where('booking_id', '=', x.bookingId).execute();
      }
      const after = { boarding: newStatus, booking: bookingAfter };
      await trx.insertInto('service_corrections').values({ traveller_id: x.id, before: JSON.stringify(before), after: JSON.stringify(after), reason: reason.trim(), staff_id: staff.id }).execute();
      await this.audit.record({ actorType: 'staff', actorId: staff.id, action: 'service.corrected', recordType: 'traveller', recordId: x.id, before, after: { ...after, reason: reason.trim() }, ip }, trx);
    });
    await this.tellBoth(x.bookingId, `Your trip record for booking ${x.code} was corrected: ${x.full_name} is now "${String(newStatus).replace('_', '-')}".`);
    return { travellerId: x.id, boarding: newStatus };
  }

  /** Support can only ask; the case goes to Admin. */
  async request(staff: StaffUser, travellerId: unknown, newStatus: unknown, reason: unknown) {
    if (!STATUSES.includes(newStatus as any)) throw badInput('BAD_STATUS', 'Choose boarded, no-show or pending.');
    if (typeof reason !== 'string' || !reason.trim()) throw badInput('REASON_REQUIRED', 'Write why the record should change.');
    const x = await this.traveller(travellerId);
    const c = await this.cases.open({ type: 'correction_request', bookingId: x.bookingId, travellerId: x.id, status: 'for_admin', reason: `Change ${x.full_name}: ${x.boarding_status} → ${newStatus}`, byType: 'staff', byId: staff.id, statement: reason });
    return { caseCode: c.code, status: 'for_admin' };
  }

  async cash(staff: StaffUser, cashRecordId: unknown, received: unknown, reason: unknown, actionId?: string, ip?: string) {
    if (!isUuid(cashRecordId)) throw notFound('Cash record');
    if (typeof reason !== 'string' || !reason.trim()) throw badInput('REASON_REQUIRED', 'Write the reason for the correction.');
    const key = typeof actionId === 'string' && actionId.length >= 8 ? actionId : randomUUID();
    const done = await this.db.selectFrom('cash_corrections').selectAll().where('action_id', '=', key).executeTakeFirst();
    if (done) return { cashRecordId, old: done.old_received_fils, new: done.new_received_fils };
    const rec = await this.db.selectFrom('cash_records').selectAll().where('id', '=', cashRecordId).executeTakeFirst();
    if (!rec) throw notFound('Cash record');
    if (!isFils(received) || received > rec.due_fils) throw badInput('BAD_AMOUNT', `Amount must be between JOD 0.000 and ${formatJod(rec.due_fils)}.`);
    if (received === rec.received_fils) throw conflict('NO_CHANGE', 'The record already shows this amount.');
    const status = received === rec.due_fils ? 'full' : received === 0 ? 'not_paid' : 'part';
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('cash_corrections').values({ cash_record_id: rec.id, old_received_fils: rec.received_fils, new_received_fils: received, reason: reason.trim(), staff_id: staff.id, action_id: key }).execute();
      await trx.updateTable('cash_records').set({ received_fils: received, status }).where('id', '=', rec.id).execute();
      await this.audit.record({ actorType: 'staff', actorId: staff.id, action: 'cash.corrected', recordType: 'cash_record', recordId: rec.id, before: { received: rec.received_fils, status: rec.status }, after: { received, status, reason: reason.trim() }, ip }, trx);
    });
    const b = await this.db.selectFrom('bookings').select('code').where('id', '=', rec.booking_id).executeTakeFirstOrThrow();
    await this.tellBoth(rec.booking_id, `Cash record for booking ${b.code} corrected: ${formatJod(rec.received_fils)} → ${formatJod(received)}.`);
    return { cashRecordId: rec.id, old: rec.received_fils, new: received, status };
  }

  async cashHistory(bookingId: string) {
    if (!isUuid(bookingId)) throw notFound('Booking');
    const rec = await this.db.selectFrom('cash_records').selectAll().where('booking_id', '=', bookingId).executeTakeFirst();
    if (!rec) return null;
    const corrections = await this.db.selectFrom('cash_corrections').select(['old_received_fils as old', 'new_received_fils as new', 'reason', 'at']).where('cash_record_id', '=', rec.id).orderBy('at').execute();
    return { id: rec.id, due: rec.due_fils, received: rec.received_fils, status: rec.status, recordedAt: rec.at, corrections };
  }
}
