import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Kysely } from 'kysely';
import { CasesService } from '../cases/cases.service';
import { AuditService } from '../common/audit.service';
import { badInput, conflict, notFound } from '../common/errors';
import { CITY_RADIUS_M, metresBetween } from '../common/geo';
import { MessagingService } from '../common/messaging.service';
import { formatJod, isFils } from '../common/money';
import { jordanHHMM } from '../common/time';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';

type Driver = { id: string; phone: string; full_name: string | null };
interface Meta { actionId?: string; at?: string; lat?: number; lng?: number }
const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const EARLIEST_ARRIVAL_MIN = 120;   // team decision: "I've arrived" accepted from 2 h before pickup

/**
 * Trip day (driver app): T-019 arrival & waiting, T-020 boarding & completion,
 * T-022 offline actions, T-026 cash received.
 * Every action has an action ID; a retry returns the first result and never repeats it.
 */
@Injectable()
export class TripDayService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    private settings: SettingsService,
    private audit: AuditService,
    private messaging: MessagingService,
    private cases: CasesService,
  ) {}

  // ---------- action log (T-022) ----------
  private eventTime(m: Meta): Date {
    // Offline actions keep their real time if it is believable (past 12 h, not in the future).
    const d = m.at ? new Date(m.at) : null;
    const now = Date.now();
    return d && !Number.isNaN(d.getTime()) && d.getTime() <= now + 60_000 && d.getTime() >= now - 12 * 3600_000 ? d : new Date();
  }

  private async run<T>(driver: Driver, kind: string, m: Meta, fn: (at: Date) => Promise<T>): Promise<T> {
    const actionId = typeof m.actionId === 'string' && m.actionId.length >= 8 ? m.actionId.slice(0, 100) : randomUUID();
    const prev = await this.db.selectFrom('driver_actions').selectAll().where('action_id', '=', actionId).executeTakeFirst();
    if (prev && prev.driver_id === driver.id) {
      if (prev.status === 'accepted') return prev.result as T;
      throw new HttpException(prev.result, prev.result?.httpStatus ?? 409);
    }
    const at = this.eventTime(m);
    const store = (status: 'accepted' | 'rejected', result: unknown) => this.db.insertInto('driver_actions')
      .values({ action_id: actionId, driver_id: driver.id, kind, device_at: m.at ? at : null, lat: m.lat ?? null, lng: m.lng ?? null, status, result: JSON.stringify(result ?? null) })
      .onConflict((oc) => oc.column('action_id').doNothing()).execute();
    try {
      const result = await fn(at);
      await store('accepted', result);
      return result;
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() < 500) await store('rejected', { ...(e.getResponse() as object), httpStatus: e.getStatus() });
      throw e;
    }
  }

  // ---------- helpers ----------
  private async trip(driver: Driver, tripId: string) {
    if (!isUuid(tripId)) throw notFound('Trip');
    const t = await this.db.selectFrom('trips').selectAll().where('id', '=', tripId).executeTakeFirst();
    if (!t || t.driver_id !== driver.id) throw notFound('Trip');
    if (!['published', 'running'].includes(t.status)) throw conflict('TRIP_NOT_ACTIVE', t.status === 'completed' ? 'This trip is already completed.' : 'This trip is not active.');
    return t;
  }

  private async stop(tripId: string, seq: number) {
    const s = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id')
      .select(['s.id', 's.seq', 's.pickup_at', 's.arrived_at', 's.left_at', 's.lat', 's.lng', 's.spot', 'c.name_en', 'c.lat as cityLat', 'c.lng as cityLng'])
      .where('s.trip_id', '=', tripId).where('s.seq', '=', Number(seq)).executeTakeFirst();
    if (!s) throw notFound('Stop');
    return s;
  }

  /** Travellers on confirmed bookings of this trip (optionally at one stop). */
  private travellersOn(tripId: string, seq?: number) {
    let q = this.db.selectFrom('travellers as x').innerJoin('booking_requests as r', 'r.id', 'x.request_id').innerJoin('bookings as b', 'b.request_id', 'r.id')
      .select(['x.id', 'x.idx', 'x.type', 'x.full_name', 'x.board_seq', 'x.boarding_status', 'x.lap_of_idx', 'x.request_id', 'b.id as bookingId', 'b.code', 'b.passenger_id', 'b.total_fils'])
      .where('r.trip_id', '=', tripId).where('b.status', '=', 'confirmed');
    if (seq != null) q = q.where('x.board_seq', '=', seq);
    return q.orderBy('b.code').orderBy('x.idx').execute();
  }

  private async passengerPush(passengerId: string, template: string, body: string) {
    const p = await this.db.selectFrom('passengers').select('phone').where('id', '=', passengerId).executeTakeFirstOrThrow();
    await this.messaging.send({ channel: 'push', to: p.phone, recipientType: 'passenger', recipientId: passengerId, template, body });
  }

  private async travellerOwned(driver: Driver, travellerId: string) {
    if (!isUuid(travellerId)) throw notFound('Traveller');
    const x = await this.db.selectFrom('travellers as x').innerJoin('booking_requests as r', 'r.id', 'x.request_id').innerJoin('bookings as b', 'b.request_id', 'r.id').innerJoin('trips as t', 't.id', 'r.trip_id')
      .select(['x.id', 'x.idx', 'x.type', 'x.full_name', 'x.board_seq', 'x.boarding_status', 'x.request_id', 'b.id as bookingId', 'b.status as bookingStatus', 'b.passenger_id', 't.id as tripId', 't.driver_id', 't.status as tripStatus'])
      .where('x.id', '=', travellerId).executeTakeFirst();
    if (!x || x.driver_id !== driver.id) throw notFound('Traveller');
    if (x.bookingStatus !== 'confirmed') throw conflict('BOOKING_NOT_ACTIVE', 'This booking is not active.');
    if (!['published', 'running'].includes(x.tripStatus)) throw conflict('TRIP_NOT_ACTIVE', 'This trip is not active.');
    return x;
  }

  // ---------- T-019 arrival ----------
  async arrived(driver: Driver, tripId: string, seq: number, m: Meta) {
    return this.run(driver, 'arrived', m, async (at) => {
      const t = await this.trip(driver, tripId);
      const s = await this.stop(tripId, seq);
      const last = await this.db.selectFrom('trip_stops').select((eb) => eb.fn.max('seq').as('m')).where('trip_id', '=', tripId).executeTakeFirstOrThrow();
      if (s.seq === Number(last.m)) throw badInput('FINAL_STOP', 'At the final stop, tap "Trip completed".');
      if (s.arrived_at) return { seq: s.seq, arrivedAt: s.arrived_at, already: true };
      if (s.pickup_at.getTime() - at.getTime() > EARLIEST_ARRIVAL_MIN * 60_000) throw badInput('TOO_EARLY', `It's too early. You can mark arrival from ${jordanHHMM(new Date(s.pickup_at.getTime() - EARLIEST_ARRIVAL_MIN * 60_000))}.`);
      const { values } = await this.settings.versionAt();
      if (typeof m.lat !== 'number' || typeof m.lng !== 'number') throw badInput('LOCATION_REQUIRED', 'Turn on location to mark your arrival.');
      const target = s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng, r: values.arrivalRadiusMeters as number } : { lat: s.cityLat!, lng: s.cityLng!, r: CITY_RADIUS_M };
      if (metresBetween({ lat: m.lat, lng: m.lng }, target) > target.r) throw badInput('NOT_AT_STOP', "You're not at the stop yet.");
      await this.db.updateTable('trip_stops').set({ arrived_at: at }).where('id', '=', s.id).execute();
      if (t.status === 'published') await this.db.updateTable('trips').set({ status: 'running', started_at: at }).where('id', '=', tripId).execute();
      const waitStart = new Date(Math.max(at.getTime(), s.pickup_at.getTime()));
      const noShowFrom = new Date(waitStart.getTime() + (values.stopWaitMinutes as number) * 60_000);
      const here = await this.travellersOn(tripId, s.seq);
      for (const pid of [...new Set(here.map((x) => x.passenger_id))])
        await this.passengerPush(pid, 'driver_arrived', `Your driver is at ${s.name_en} (${s.spot}). He waits until ${jordanHHMM(noShowFrom)}.`);
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.arrived', recordType: 'trip', recordId: tripId, after: { seq: s.seq, at, lat: m.lat, lng: m.lng } });
      return { seq: s.seq, arrivedAt: at, waitStartsAt: waitStart, noShowFrom };
    });
  }

  async contactAttempt(driver: Driver, bookingId: string, kind: unknown) {
    if (kind !== 'call' && kind !== 'message') throw badInput('BAD_KIND', 'Call or message.');
    if (!isUuid(bookingId)) throw notFound('Booking');
    const b = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').select(['b.id', 't.driver_id']).where('b.id', '=', bookingId).executeTakeFirst();
    if (!b || b.driver_id !== driver.id) throw notFound('Booking');
    await this.db.insertInto('contact_attempts').values({ booking_id: bookingId, driver_id: driver.id, kind }).execute();
    return { ok: true };
  }

  // ---------- T-020 boarding ----------
  async boarded(driver: Driver, travellerId: string, m: Meta) {
    return this.run(driver, 'boarded', m, async (at) => {
      const x = await this.travellerOwned(driver, travellerId);
      if (x.type === 'baby') throw badInput('BABY_WITH_ADULT', 'A baby boards with their adult.');
      const s = await this.stop(x.tripId, x.board_seq);
      if (!s.arrived_at) throw conflict('NOT_ARRIVED', `Tap "I've arrived" at ${s.name_en} first.`);
      if (s.left_at) throw conflict('STOP_LEFT', 'You already left this stop. Ask Support to correct the record.');
      await this.db.updateTable('travellers').set({ boarding_status: 'boarded', boarded_at: at, no_show_at: null })
        .where('request_id', '=', x.request_id).where((eb) => eb.or([eb('id', '=', x.id), eb.and([eb('type', '=', 'baby'), eb('lap_of_idx', '=', x.idx)])])).execute();
      return { travellerId, status: 'boarded' };
    });
  }

  // ---------- T-019 no-show ----------
  async noShow(driver: Driver, travellerId: string, m: Meta) {
    return this.run(driver, 'no_show', m, async (at) => {
      const x = await this.travellerOwned(driver, travellerId);
      if (x.type === 'baby') throw badInput('BABY_WITH_ADULT', 'Mark the adult; the baby follows.');
      if (x.boarding_status === 'no_show') return { travellerId, status: 'no_show' };
      if (x.boarding_status === 'boarded') throw conflict('ALREADY_BOARDED', 'This traveller is already on board.');
      const s = await this.stop(x.tripId, x.board_seq);
      if (!s.arrived_at) throw conflict('NOT_ARRIVED', `Tap "I've arrived" at ${s.name_en} first.`);
      const { values } = await this.settings.versionAt();
      const noShowFrom = Math.max(s.arrived_at.getTime(), s.pickup_at.getTime()) + (values.stopWaitMinutes as number) * 60_000;
      if (at.getTime() < noShowFrom) throw conflict('STILL_WAITING', `Please wait until ${jordanHHMM(new Date(noShowFrom))} before marking a no-show.`);
      const tried = await this.db.selectFrom('contact_attempts').select('id').where('booking_id', '=', x.bookingId).executeTakeFirst();
      if (!tried) throw conflict('CONTACT_FIRST', 'Call or message the passenger once before marking a no-show.');
      await this.db.updateTable('travellers').set({ boarding_status: 'no_show', no_show_at: at })
        .where('request_id', '=', x.request_id).where((eb) => eb.or([eb('id', '=', x.id), eb.and([eb('type', '=', 'baby'), eb('lap_of_idx', '=', x.idx)])])).execute();
      await this.db.insertInto('warnings').values({ subject_type: 'passenger', subject_id: x.passenger_id, kind: 'no_show', ref_type: 'traveller', ref_id: x.id }).execute();
      await this.passengerPush(x.passenger_id, 'marked_no_show', `${x.full_name} was marked as a no-show at ${s.name_en}. If you were there, report it within 48 hours.`);
      const n = Number((await this.db.selectFrom('warnings').select((eb) => eb.fn.countAll<number>().as('n')).where('subject_type', '=', 'passenger').where('subject_id', '=', x.passenger_id)
        .where('kind', '=', 'no_show').where('void', '=', false).where('under_review', '=', false).executeTakeFirstOrThrow()).n);
      if (n === (values.noShowWarningCount as number))
        await this.passengerPush(x.passenger_id, 'no_show_warning', `You have ${n} no-shows. Please cancel in the app if you can't travel — drivers wait for you.`);
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'traveller.no_show', recordType: 'traveller', recordId: x.id, after: { at } });
      return { travellerId, status: 'no_show' };
    });
  }

  // ---------- T-026 cash at boarding ----------
  async cash(driver: Driver, bookingId: string, body: { status?: string; amount?: number }, m: Meta) {
    return this.run(driver, 'cash', m, async (at) => {
      if (!isUuid(bookingId)) throw notFound('Booking');
      const b = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').select(['b.id', 'b.code', 'b.status', 'b.total_fils', 'b.passenger_id', 'b.request_id', 't.driver_id'])
        .where('b.id', '=', bookingId).executeTakeFirst();
      if (!b || b.driver_id !== driver.id) throw notFound('Booking');
      if (!['confirmed', 'completed'].includes(b.status)) throw conflict('BOOKING_NOT_ACTIVE', 'This booking is not active.');
      const status = body?.status;
      if (status !== 'full' && status !== 'part' && status !== 'not_paid') throw badInput('BAD_STATUS', 'Choose: received in full, received part, or not paid.');
      let received = status === 'full' ? b.total_fils : 0;
      if (status === 'part') {
        if (!isFils(body.amount) || body.amount <= 0) throw badInput('AMOUNT_REQUIRED', 'Enter the amount you received.');
        if (body.amount >= b.total_fils) throw badInput('AMOUNT_TOO_HIGH', body.amount > b.total_fils ? 'Amount is more than the fare.' : 'That is the full amount — choose "Received in full".');
        received = body.amount;
      }
      const existing = await this.db.selectFrom('cash_records').selectAll().where('booking_id', '=', bookingId).executeTakeFirst();
      if (existing) throw conflict('CASH_ALREADY_RECORDED', 'Cash for this booking is already recorded. Ask Support to correct it.');
      const rec = await this.db.insertInto('cash_records').values({ booking_id: bookingId, due_fils: b.total_fils, received_fils: received, status, driver_id: driver.id, at, lat: m.lat ?? null, lng: m.lng ?? null })
        .returning('id').executeTakeFirstOrThrow();
      let caseCode: string | undefined;
      if (status !== 'full') {
        const c = await this.cases.open({ type: 'cash', bookingId, reason: status === 'part' ? `Part paid: ${formatJod(received)} of ${formatJod(b.total_fils)}` : 'Not paid',
          byType: 'driver', byId: driver.id, statement: status === 'part' ? `Driver recorded ${formatJod(received)} of ${formatJod(b.total_fils)}.` : 'Driver recorded: not paid.' });
        caseCode = c.code;
        await this.passengerPush(b.passenger_id, 'cash_case_opened', `Your driver recorded ${status === 'part' ? `${formatJod(received)} of ${formatJod(b.total_fils)}` : 'no payment'} for booking ${b.code}. Support will contact you (case ${c.code}).`);
      } else {
        await this.passengerPush(b.passenger_id, 'cash_receipt', `Receipt for booking ${b.code}: ${formatJod(received)} paid in cash to the driver.`);
      }
      return { cashRecordId: rec.id, status, received, due: b.total_fils, caseCode };
    });
  }

  // ---------- T-020 leave a stop / complete ----------
  async leave(driver: Driver, tripId: string, seq: number, m: Meta) {
    return this.run(driver, 'leave', m, async (at) => {
      await this.trip(driver, tripId);
      const s = await this.stop(tripId, seq);
      if (!s.arrived_at) throw conflict('NOT_ARRIVED', `Tap "I've arrived" at ${s.name_en} first.`);
      if (s.left_at) return { seq: s.seq, leftAt: s.left_at };
      const pending = (await this.travellersOn(tripId, s.seq)).filter((x) => x.boarding_status === 'pending' && x.type !== 'baby');
      if (pending.length) throw conflict('TRAVELLERS_UNMARKED', `Mark everyone first: ${pending.map((x) => x.full_name).join(', ')}.`);
      await this.db.updateTable('trip_stops').set({ left_at: at }).where('id', '=', s.id).execute();
      return { seq: s.seq, leftAt: at };
    });
  }

  async complete(driver: Driver, tripId: string, m: Meta) {
    return this.run(driver, 'complete', m, async (at) => {
      const t = await this.trip(driver, tripId);
      if (t.status !== 'running') throw conflict('NOT_STARTED', 'Start the trip at the first stop before completing it.');
      const pending = (await this.travellersOn(tripId)).filter((x) => x.boarding_status === 'pending' && x.type !== 'baby');
      if (pending.length) throw conflict('TRAVELLERS_UNMARKED', `Mark everyone first: ${pending.map((x) => x.full_name).join(', ')}.`);
      const bookings = await this.db.selectFrom('bookings').select(['id', 'status', 'request_id', 'passenger_id']).where('trip_id', '=', tripId).execute();
      const done: string[] = [];
      for (const b of bookings) {
        if (b.status === 'awaiting_completion') {
          await this.db.updateTable('bookings').set({ status: 'cancelled', cancelled_at: at, cancel_reason: 'booking_not_completed', counts_toward_warning: false, updated_at: at }).where('id', '=', b.id).execute();
          continue;
        }
        if (b.status !== 'confirmed') continue;
        const anyBoarded = await this.db.selectFrom('travellers').select('id').where('request_id', '=', b.request_id).where('boarding_status', '=', 'boarded').executeTakeFirst();
        const req = await this.db.selectFrom('booking_requests').select('kind').where('id', '=', b.request_id).executeTakeFirstOrThrow();
        const hasTravellers = await this.db.selectFrom('travellers').select('id').where('request_id', '=', b.request_id).executeTakeFirst();
        const ok = anyBoarded || (req.kind === 'whole' && !hasTravellers);
        await this.db.updateTable('bookings').set({ status: ok ? 'completed' : 'no_show', updated_at: at }).where('id', '=', b.id).execute();
        if (ok) done.push(b.passenger_id);
      }
      await this.db.updateTable('trips').set({ status: 'completed', completed_at: at, updated_at: at }).where('id', '=', tripId).execute();
      for (const pid of [...new Set(done)]) await this.passengerPush(pid, 'trip_completed', 'Thanks for travelling with JTOS! Please rate your trip within 48 hours.');
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.completed', recordType: 'trip', recordId: tripId, after: { at } });
      return { tripId, status: 'completed', completedAt: at };
    });
  }

  /** Today's work list for the driver app: stops, who gets on, cash due, what's marked. */
  async board(driver: Driver, tripId: string) {
    if (!isUuid(tripId)) throw notFound('Trip');
    const t = await this.db.selectFrom('trips').selectAll().where('id', '=', tripId).executeTakeFirst();
    if (!t || t.driver_id !== driver.id) throw notFound('Trip');
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id').select(['s.seq', 'c.name_en', 's.spot', 's.pickup_at', 's.arrived_at', 's.left_at']).where('s.trip_id', '=', tripId).orderBy('s.seq').execute();
    const tr = await this.travellersOn(tripId);
    const cash = await this.db.selectFrom('cash_records as c').innerJoin('bookings as b', 'b.id', 'c.booking_id').select(['c.booking_id', 'c.status', 'c.received_fils']).where('b.trip_id', '=', tripId).execute();
    return {
      tripId, status: t.status,
      stops: stops.map((s) => ({ seq: s.seq, city: s.name_en, spot: s.spot, time: jordanHHMM(s.pickup_at), arrivedAt: s.arrived_at, leftAt: s.left_at,
        bookings: [...new Set(tr.filter((x) => x.board_seq === s.seq).map((x) => x.bookingId))].map((bid) => {
          const xs = tr.filter((x) => x.bookingId === bid);
          const c = cash.find((k) => k.booking_id === bid);
          return { bookingId: bid, code: xs[0].code, cashDue: xs[0].total_fils, cash: c ? { status: c.status, received: c.received_fils } : null,
            travellers: xs.map((x) => ({ id: x.id, name: x.full_name, type: x.type, status: x.boarding_status })) };
        }) })),
    };
  }

  // ---------- T-022 offline batch ----------
  async sync(driver: Driver, actions: any[]) {
    if (!Array.isArray(actions) || actions.length > 100) throw badInput('BAD_BATCH', 'Send up to 100 actions.');
    const out = [];
    for (const a of actions) {
      const m: Meta = { actionId: a?.actionId, at: a?.at, lat: a?.lat, lng: a?.lng };
      try {
        let result: unknown;
        switch (a?.type) {
          case 'arrived': result = await this.arrived(driver, a.tripId, a.seq, m); break;
          case 'boarded': result = await this.boarded(driver, a.travellerId, m); break;
          case 'no_show': result = await this.noShow(driver, a.travellerId, m); break;
          case 'cash': result = await this.cash(driver, a.bookingId, { status: a.status, amount: a.amount }, m); break;
          case 'leave': result = await this.leave(driver, a.tripId, a.seq, m); break;
          case 'complete': result = await this.complete(driver, a.tripId, m); break;
          default: throw badInput('BAD_TYPE', 'Unknown action.');
        }
        out.push({ actionId: a.actionId, status: 'sent', result });
      } catch (e) {
        const r = e instanceof HttpException ? (e.getResponse() as any) : { code: 'ERROR', message: 'Something went wrong.' };
        out.push({ actionId: a?.actionId, status: 'rejected', code: r.code, message: r.message });
      }
    }
    return { results: out };
  }
}
