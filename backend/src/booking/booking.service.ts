import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { randomInt } from 'crypto';
import { AuditService } from '../common/audit.service';
import { decrypt, docHash, encrypt, maskDoc } from '../common/data-crypto';
import { AppError, badInput, conflict, notFound } from '../common/errors';
import { MessagingService } from '../common/messaging.service';
import { formatJod } from '../common/money';
import { normalizePhone } from '../common/phone';
import { maskContacts } from '../common/text';
import { jordanHHMM } from '../common/time';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { checkTravellers, REJECT_REASONS, TravellerIn } from './rules';

type Passenger = { id: string; phone: string; full_name: string; consent_documents_at: Date | null };
type Driver = { id: string; phone: string; status: string };
const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const CANCEL_RULES = 'Cancelling is free until the driver arrives at your stop. After 2 cancellations in 30 days you get a warning.';

/** T-014 request, T-015 accept, T-016 reject/withdraw/expire, T-018 limits, T-013 seat holds. */
@Injectable()
export class BookingService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    private settings: SettingsService,
    private audit: AuditService,
    private messaging: MessagingService,
  ) {}

  // ---------- capacity (T-013): always inside a transaction holding the trip row lock ----------
  private async release(trx: Transaction<DB>, r: { trip_id: string; seats: number; kind: string }) {
    await trx.updateTable('trips').set((eb) => ({ seats_held: eb('seats_held', '-', r.seats), ...(r.kind === 'whole' ? { whole_taken: false } : {}) }))
      .where('id', '=', r.trip_id).execute();
  }

  private async tripWithStops(tripId: string) {
    const trip = await this.db.selectFrom('trips').selectAll().where('id', '=', tripId).executeTakeFirst();
    if (!trip) throw notFound('Trip');
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id')
      .select(['s.seq', 's.spot', 's.pickup_at', 's.section_price_fils', 's.last_chance_price_fils', 'c.id as cityId', 'c.code', 'c.name_en', 'c.country'])
      .where('s.trip_id', '=', tripId).orderBy('s.seq').execute();
    return { trip, stops };
  }

  private async notifyPassenger(passengerId: string, template: string, body: string) {
    const p = await this.db.selectFrom('passengers').select(['phone']).where('id', '=', passengerId).executeTakeFirstOrThrow();
    await this.messaging.send({ channel: 'push', to: p.phone, recipientType: 'passenger', recipientId: passengerId, template, body });
  }

  // ---------- T-014 request ----------
  async createRequest(passenger: Passenger, b: any, actionIdIn?: string) {
    const actionId = typeof actionIdIn === 'string' && actionIdIn.length >= 8 && actionIdIn.length <= 100 ? actionIdIn : null;
    if (!actionId) throw badInput('ACTION_ID_REQUIRED', 'Missing Idempotency-Key header.');
    const existing = await this.db.selectFrom('booking_requests').select('id').where('passenger_id', '=', passenger.id).where('action_id', '=', actionId).executeTakeFirst();
    if (existing) return this.passengerRequestView(passenger.id, existing.id);   // T-018 AC3: a retry is the same request
    if (!isUuid(b?.tripId)) throw badInput('BAD_TRIP', 'Choose a trip.');
    const kind: 'seats' | 'whole' = b.kind === 'whole' ? 'whole' : 'seats';
    const version = await this.settings.versionAt();
    const v = version.values;
    const { trip, stops } = await this.tripWithStops(b.tripId);
    if (trip.status !== 'published') throw conflict('TRIP_UNAVAILABLE', 'This trip is not available any more.');
    if (trip.driver_id === passenger.id) throw conflict('OWN_TRIP', "You can't book your own trip.");
    const cutoff = (v.bookingCutoffMinutes as number) * 60_000;
    const final = stops[stops.length - 1];
    const crossBorder = new Set(stops.map((s) => s.country)).size > 1;
    const stopFor = (seq: unknown) => stops.find((s) => s.seq === seq && s.seq !== final.seq);
    const isOpen = (s: { pickup_at: Date }) => s.pickup_at.getTime() - cutoff > Date.now();

    const travellers: TravellerIn[] = Array.isArray(b.travellers) ? b.travellers : [];
    let seats: number, headCount: number, total: number, boardSeq: number;
    const priced: { t: TravellerIn; seq: number; spot: string; price: number }[] = [];
    let warnings: { idx: number; message: string }[] = [];

    if (kind === 'whole') {
      if (trip.booking_type === 'seats') throw conflict('NO_WHOLE', 'This trip sells seats only.');
      const first = stops[0];
      if (!isOpen(first)) throw conflict('BOOKING_CLOSED', 'Booking has closed for this trip.');
      headCount = Number(b.headCount);
      if (!Number.isInteger(headCount) || headCount < 1 || headCount > trip.seats_offered + 3) throw badInput('HEAD_COUNT', `Enter how many people will travel (1 to ${trip.seats_offered} seats).`);
      seats = trip.seats_offered; total = trip.whole_price_fils!; boardSeq = 1;
      if (travellers.length) {   // whole vehicle: traveller forms optional (Q04)
        const c = checkTravellers(travellers, { date: trip.travel_date, crossBorder, warnMonths: v.passportWarningMonths as number });
        if (c.errors.length) throw badInput('TRAVELLERS', c.errors.join(' '));
        warnings = c.warnings;
        travellers.forEach((t) => priced.push({ t, seq: 1, spot: first.spot, price: 0 }));
      }
    } else {
      if (trip.booking_type === 'whole') throw conflict('WHOLE_ONLY', 'This trip is booked as a whole vehicle only.');
      const c = checkTravellers(travellers, { date: trip.travel_date, crossBorder, warnMonths: v.passportWarningMonths as number });
      if (c.errors.length) throw badInput('TRAVELLERS', c.errors.join(' '));
      warnings = c.warnings;
      for (const [i, t] of travellers.entries()) {
        const seq = t.type === 'baby' ? (travellers[t.lapOf!].boardSeq ?? 1) : t.boardSeq ?? 1;
        const s = stopFor(seq);
        if (!s) throw badInput('BAD_STOP', `Traveller ${i + 1}: choose where they get on (not the final stop).`);
        if (!isOpen(s)) throw conflict('BOOKING_CLOSED', `Booking has closed at ${s.name_en}.`);
        const spot = stops.length > 2 && typeof t.boardSpot === 'string' && t.boardSpot.trim() ? maskContacts(t.boardSpot.trim()).slice(0, 200) : s.spot;
        priced.push({ t, seq, spot, price: t.type === 'baby' ? 0 : (s.last_chance_price_fils ?? s.section_price_fils!) });
      }
      seats = travellers.filter((t) => t.type !== 'baby').length;
      headCount = travellers.length;
      total = priced.reduce((a, p) => a + p.price, 0);
      boardSeq = Math.min(...priced.map((p) => p.seq));
    }
    if (priced.length && b.consent !== true) throw badInput('CONSENT_REQUIRED', 'Please agree that we keep traveller documents until 30 days after the trip.');

    // ---------- T-018 limits ----------
    const boardAt = stops.find((s) => s.seq === boardSeq)!.pickup_at;
    const endAt = final.pickup_at;
    const active = await this.db.selectFrom('booking_requests as r').innerJoin('trips as t', 't.id', 'r.trip_id')
      .leftJoin('bookings as b', 'b.request_id', 'r.id')
      .select(['r.id', 'r.status', 'r.trip_id', 'r.board_seq', 't.travel_date'])
      .select(sql<string>`(select c.code from trip_stops s join cities c on c.id = s.city_id where s.trip_id = t.id order by s.seq desc limit 1)`.as('finalCode'))
      .select(sql<Date>`(select pickup_at from trip_stops s where s.trip_id = t.id and s.seq = r.board_seq)`.as('startAt'))
      .select(sql<Date>`(select max(pickup_at) from trip_stops s where s.trip_id = t.id)`.as('endAt'))
      .where('r.passenger_id', '=', passenger.id)
      .where((eb) => eb.or([eb('r.status', '=', 'waiting'), eb.and([eb('r.status', '=', 'accepted'), eb('b.status', 'in', ['awaiting_completion', 'confirmed'])])]))
      .execute();
    const waiting = active.filter((a) => a.status === 'waiting').length;
    const maxWaiting = v.waitingRequestsMax as number;
    if (waiting >= maxWaiting) throw conflict('WAITING_LIMIT', `You already have ${maxWaiting} waiting requests. Withdraw one to send a new request.`);
    if (active.some((a) => a.trip_id === trip.id)) throw conflict('ALREADY_REQUESTED', 'You already have a request or booking on this trip.');
    if (active.some((a) => a.travel_date === trip.travel_date && a.finalCode === final.code))
      throw conflict('SAME_ROUTE_DAY', `You already have a trip to ${final.name_en} on ${trip.travel_date}. A return trip the same day is fine.`);
    if (active.some((a) => new Date(a.startAt) < endAt && new Date(a.endAt) > boardAt)) throw conflict('TIME_CLASH', 'This trip clashes with another trip you requested.');

    const hashes = priced.map((p) => docHash(p.t.docNumber));
    if (new Set(hashes).size !== hashes.length) throw badInput('DUPLICATE_TRAVELLER', 'The same document appears twice.');

    const deadline = new Date(Date.now() + trip.response_window_min * 60_000);
    const id = await this.db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('trips').selectAll().where('id', '=', trip.id).forUpdate().executeTakeFirstOrThrow();
      if (t.status !== 'published') throw conflict('TRIP_UNAVAILABLE', 'This trip is not available any more.');
      const free = t.seats_offered - t.seats_booked - t.seats_held;
      if (kind === 'whole' ? t.whole_taken || t.seats_booked + t.seats_held > 0 : t.whole_taken || free < seats)
        throw conflict('SEAT_UNAVAILABLE', kind === 'whole' ? 'The whole vehicle is no longer available.' : seats === 1 ? 'This seat is no longer available.' : `Only ${Math.max(free, 0)} seats are left.`);
      if (hashes.length) {
        const dup = await trx.selectFrom('travellers as x').innerJoin('booking_requests as r', 'r.id', 'x.request_id').leftJoin('bookings as b', 'b.request_id', 'r.id')
          .select('x.id').where('r.trip_id', '=', t.id).where('x.doc_hash', 'in', hashes)
          .where((eb) => eb.or([eb('r.status', '=', 'waiting'), eb.and([eb('r.status', '=', 'accepted'), eb('b.status', 'in', ['awaiting_completion', 'confirmed'])])])).executeTakeFirst();
        if (dup) throw conflict('TRAVELLER_ALREADY_BOOKED', 'One of the travellers is already booked on this trip.');
      }
      const terms = {
        prices: stops.filter((s) => s.seq !== final.seq).map((s) => ({ seq: s.seq, city: s.code, price: s.last_chance_price_fils ?? s.section_price_fils })),
        wholePrice: t.whole_price_fils, total, deadlineAt: deadline.toISOString(), cancellation: CANCEL_RULES, payment: 'Cash to the driver when you get in the car.',
      };
      const r = await trx.insertInto('booking_requests').values({
        trip_id: t.id, passenger_id: passenger.id, kind, seats, head_count: headCount, board_seq: boardSeq, total_fils: total,
        terms_snapshot: JSON.stringify(terms), settings_version_id: version.id, deadline_at: deadline, reject_reason: null,
        driver_opened_at: null, whatsapp_backup_at: null, action_id: actionId, decided_at: null,
      }).returning('id').executeTakeFirstOrThrow();
      if (priced.length) await trx.insertInto('travellers').values(priced.map((p, i) => ({
        request_id: r.id, idx: i, type: p.t.type, full_name: p.t.fullName.trim(), date_of_birth: p.t.dateOfBirth, doc_type: p.t.docType,
        doc_number_enc: encrypt(p.t.docNumber.trim().toUpperCase()), doc_hash: hashes[i], doc_expiry: p.t.docExpiry,
        responsibility_ticked: p.t.responsibility === true, board_seq: p.seq, board_spot: p.spot, lap_of_idx: p.t.type === 'baby' ? p.t.lapOf! : null,
        price_fils: p.price, contact: p.t.contact ? String(p.t.contact).trim() : null, personal_deleted_at: null,
      }))).execute();
      await trx.updateTable('trips').set((eb) => ({ seats_held: eb('seats_held', '+', seats), ...(kind === 'whole' ? { whole_taken: true } : {}) })).where('id', '=', t.id).execute();
      if (priced.length && !passenger.consent_documents_at) await trx.updateTable('passengers').set({ consent_documents_at: new Date() }).where('id', '=', passenger.id).execute();
      await this.audit.record({ actorType: 'passenger', actorId: passenger.id, action: 'request.created', recordType: 'booking_request', recordId: r.id, after: { tripId: t.id, kind, seats, total } }, trx);
      return r.id;
    });
    const d = await this.db.selectFrom('drivers').select(['id', 'phone']).where('id', '=', trip.driver_id).executeTakeFirstOrThrow();
    await this.messaging.send({ channel: 'push', to: d.phone, recipientType: 'driver', recipientId: d.id, template: 'new_request',
      body: `New request: ${headCount} ${headCount === 1 ? 'person' : 'people'}, ${formatJod(total)}. Reply by ${jordanHHMM(deadline)}.` });
    return { ...(await this.passengerRequestView(passenger.id, id)), warnings };
  }

  // ---------- views ----------
  private async travellerRows(requestId: string) {
    return this.db.selectFrom('travellers').selectAll().where('request_id', '=', requestId).orderBy('idx').execute();
  }

  async passengerRequestView(passengerId: string, id: string) {
    if (!isUuid(id)) throw notFound('Request');
    const r = await this.db.selectFrom('booking_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r || r.passenger_id !== passengerId) throw notFound('Request');
    const booking = await this.db.selectFrom('bookings').select(['id', 'code', 'status']).where('request_id', '=', id).executeTakeFirst();
    const tr = await this.travellerRows(id);
    return {
      id: r.id, tripId: r.trip_id, kind: r.kind, status: r.status, seats: r.seats, headCount: r.head_count, total: r.total_fils, deadlineAt: r.deadline_at,
      terms: r.terms_snapshot, booking: booking ?? null,
      // T-016: the passenger never sees the driver's reject reason.
      message: r.status === 'rejected' ? 'Request not accepted.' : r.status === 'expired' ? "The driver didn't reply in time. You can request again." : r.status === 'closed_trip_full' ? 'Trip full.' : r.status === 'trip_cancelled' ? 'The driver cancelled this trip.' : undefined,
      travellers: tr.map((x) => ({ idx: x.idx, type: x.type, fullName: x.full_name, boardSeq: x.board_seq, boardSpot: x.board_spot, price: x.price_fils,
        document: x.doc_number_enc ? `${x.doc_type} ${maskDoc(decrypt(x.doc_number_enc))}` : null })),
    };
  }

  listPassengerRequests(passengerId: string) {
    return this.db.selectFrom('booking_requests').select(['id', 'trip_id as tripId', 'kind', 'status', 'total_fils as total', 'deadline_at as deadlineAt', 'created_at as createdAt'])
      .where('passenger_id', '=', passengerId).orderBy('created_at', 'desc').limit(100).execute();
  }

  private async ownRequest(driver: Driver, id: string, trx: Kysely<DB> | Transaction<DB> = this.db, lock = false) {
    if (!isUuid(id)) throw notFound('Request');
    let q = trx.selectFrom('booking_requests as r').innerJoin('trips as t', 't.id', 'r.trip_id').selectAll('r').select(['t.driver_id']).where('r.id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r || r.driver_id !== driver.id) throw notFound('Request');
    return r;
  }

  async driverRequests(driver: Driver, status = 'waiting') {
    return this.db.selectFrom('booking_requests as r').innerJoin('trips as t', 't.id', 'r.trip_id')
      .select(['r.id', 'r.trip_id as tripId', 't.travel_date as date', 'r.kind', 'r.status', 'r.seats', 'r.head_count as headCount', 'r.total_fils as total', 'r.deadline_at as deadlineAt', 'r.created_at as createdAt'])
      .where('t.driver_id', '=', driver.id).where('r.status', '=', status as any).orderBy('r.deadline_at').execute();
  }

  /** T-015: the driver sees the full request including passports. Opening it stops the WhatsApp backup. */
  async driverRequestView(driver: Driver, id: string) {
    const r = await this.ownRequest(driver, id);
    if (!r.driver_opened_at) await this.db.updateTable('booking_requests').set({ driver_opened_at: new Date() }).where('id', '=', id).execute();
    const tr = await this.travellerRows(id);
    if (tr.length) await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'passport.viewed_by_driver', recordType: 'booking_request', recordId: id });
    const p = await this.db.selectFrom('passengers').select(['full_name']).where('id', '=', r.passenger_id).executeTakeFirstOrThrow();
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id').select(['s.seq', 'c.name_en', 's.spot', 's.pickup_at']).where('s.trip_id', '=', r.trip_id).orderBy('s.seq').execute();
    return {
      id: r.id, tripId: r.trip_id, kind: r.kind, status: r.status, seats: r.seats, headCount: r.head_count, total: r.total_fils, deadlineAt: r.deadline_at,
      bookerName: p.full_name.split(/\s+/)[0],
      travellers: tr.map((x) => ({
        idx: x.idx, type: x.type, fullName: x.full_name, dateOfBirth: x.date_of_birth, docType: x.doc_type, docNumber: x.doc_number_enc ? decrypt(x.doc_number_enc) : null,
        docExpiry: x.doc_expiry, responsibilityTicked: x.responsibility_ticked, getsOnAt: stops.find((s) => s.seq === x.board_seq)?.name_en, time: jordanHHMM(stops.find((s) => s.seq === x.board_seq)!.pickup_at),
        spot: x.board_spot, onLapOf: x.lap_of_idx, price: x.price_fils,
      })),
    };
  }

  // ---------- T-015 accept ----------
  async accept(driver: Driver, id: string) {
    const out = await this.db.transaction().execute(async (trx) => {
      const r0 = await this.ownRequest(driver, id, trx);
      await trx.selectFrom('trips').select('id').where('id', '=', r0.trip_id).forUpdate().execute();
      const r = await this.ownRequest(driver, id, trx, true);
      if (r.status === 'accepted') return { already: true, r };                     // a repeated accept never confirms twice
      if (r.status !== 'waiting') throw conflict('REQUEST_CLOSED', 'This request is closed.');
      if (r.deadline_at <= new Date()) {
        await trx.updateTable('booking_requests').set({ status: 'expired', decided_at: new Date() }).where('id', '=', id).execute();
        await this.release(trx, r);
        return { expired: true, r };
      }
      await trx.updateTable('booking_requests').set({ status: 'accepted', decided_at: new Date() }).where('id', '=', id).execute();
      await trx.updateTable('trips').set((eb) => ({ seats_held: eb('seats_held', '-', r.seats), seats_booked: eb('seats_booked', '+', r.seats) })).where('id', '=', r.trip_id).execute();
      let code = '';
      for (let i = 0; i < 5 && !code; i++) {
        const c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
        if (!(await trx.selectFrom('bookings').select('id').where('code', '=', c).executeTakeFirst())) code = c;
      }
      const b = await trx.insertInto('bookings').values({ request_id: id, trip_id: r.trip_id, passenger_id: r.passenger_id, code, total_fils: r.total_fils,
        payment_method: null, completed_booking_at: null, cancelled_at: null, cancel_reason: null, counts_toward_warning: null }).returning(['id', 'code']).executeTakeFirstOrThrow();
      // Trip full → close any other waiting requests (JTOS-436).
      const t = await trx.selectFrom('trips').select(['seats_offered', 'seats_booked']).where('id', '=', r.trip_id).executeTakeFirstOrThrow();
      let closed: { id: string; passenger_id: string }[] = [];
      if (t.seats_booked >= t.seats_offered) {
        closed = await trx.updateTable('booking_requests').set({ status: 'closed_trip_full', decided_at: new Date() })
          .where('trip_id', '=', r.trip_id).where('status', '=', 'waiting').returning(['id', 'passenger_id']).execute();
        await trx.updateTable('trips').set({ seats_held: 0 }).where('id', '=', r.trip_id).execute();
      }
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'request.accepted', recordType: 'booking_request', recordId: id, after: { bookingId: b.id } }, trx);
      return { r, booking: b, closed };
    });
    if ('expired' in out && out.expired) {
      await this.notifyPassenger(out.r.passenger_id, 'request_expired', "The driver didn't reply in time. You can request again.");
      throw conflict('REQUEST_EXPIRED', 'Too late — this request has expired.');
    }
    if ('already' in out) {
      const b = await this.db.selectFrom('bookings').select(['id', 'code']).where('request_id', '=', id).executeTakeFirstOrThrow();
      return { requestId: id, status: 'accepted', bookingId: b.id, code: b.code };
    }
    const o = out as { r: { passenger_id: string; total_fils: number }; booking: { id: string; code: string }; closed: { passenger_id: string }[] };
    await this.notifyPassenger(o.r.passenger_id, 'request_accepted', `Your request was accepted! Complete your booking: choose how to pay (${formatJod(o.r.total_fils)}).`);
    for (const c of o.closed) await this.notifyPassenger(c.passenger_id, 'request_trip_full', 'Trip full. Please choose another trip.');
    return { requestId: id, status: 'accepted', bookingId: o.booking.id, code: o.booking.code };
  }

  // ---------- T-016 reject / withdraw / expire ----------
  async reject(driver: Driver, id: string, reason: unknown, note?: unknown) {
    if (!REJECT_REASONS.includes(reason as any)) throw badInput('REASON_REQUIRED', 'Choose a reason: trip full, pick-up too far, can\'t make it, or other.');
    const { values } = await this.settings.versionAt();
    const r = await this.db.transaction().execute(async (trx) => {
      const r0 = await this.ownRequest(driver, id, trx);
      await trx.selectFrom('trips').select('id').where('id', '=', r0.trip_id).forUpdate().execute();
      const r = await this.ownRequest(driver, id, trx, true);
      if (r.status !== 'waiting') throw conflict('REQUEST_CLOSED', 'This request is closed.');
      const text = `${reason}${note ? `: ${maskContacts(String(note)).slice(0, 300)}` : ''}`;
      await trx.updateTable('booking_requests').set({ status: 'rejected', reject_reason: text, decided_at: new Date() }).where('id', '=', id).execute();
      await this.release(trx, r);
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'request.rejected', recordType: 'booking_request', recordId: id, after: { reason: text } }, trx);
      return r;
    });
    const n = Number((await this.db.selectFrom('booking_requests').select((eb) => eb.fn.countAll<number>().as('n')).where('trip_id', '=', r.trip_id).where('status', '=', 'rejected').executeTakeFirstOrThrow()).n);
    const cap = values.rejectionWarningPerTrip as number;
    let warning: string | undefined;
    if (n > cap) {   // warning only — nothing is blocked
      await this.db.insertInto('warnings').values({ subject_type: 'driver', subject_id: driver.id, kind: 'rejection', ref_type: 'trip', ref_id: r.trip_id }).execute();
      warning = `You have rejected ${n} requests on this trip. Rejecting many requests may stop you from publishing trips.`;
    }
    await this.notifyPassenger(r.passenger_id, 'request_rejected', 'Request not accepted. You can request another trip straight away.');
    return { requestId: id, status: 'rejected', warning };
  }

  async withdraw(passengerId: string, id: string) {
    if (!isUuid(id)) throw notFound('Request');
    const r = await this.db.transaction().execute(async (trx) => {
      const r0 = await trx.selectFrom('booking_requests').selectAll().where('id', '=', id).executeTakeFirst();
      if (!r0 || r0.passenger_id !== passengerId) throw notFound('Request');
      await trx.selectFrom('trips').select('id').where('id', '=', r0.trip_id).forUpdate().execute();
      const r = await trx.selectFrom('booking_requests').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (r.status !== 'waiting') throw conflict('REQUEST_CLOSED', r.status === 'accepted' ? 'The driver already accepted. Cancel the booking instead.' : 'This request is already closed.');
      await trx.updateTable('booking_requests').set({ status: 'withdrawn', decided_at: new Date() }).where('id', '=', id).execute();
      await this.release(trx, r);
      await this.audit.record({ actorType: 'passenger', actorId: passengerId, action: 'request.withdrawn', recordType: 'booking_request', recordId: id }, trx);
      return r;
    });
    return { requestId: r.id, status: 'withdrawn' };
  }

  /** Background: expire requests at their saved deadline and release the seats. */
  async expireDue(now = new Date()): Promise<number> {
    const due = await this.db.selectFrom('booking_requests').select(['id', 'trip_id']).where('status', '=', 'waiting').where('deadline_at', '<=', now).execute();
    let n = 0;
    for (const d of due) {
      const r = await this.db.transaction().execute(async (trx) => {
        await trx.selectFrom('trips').select('id').where('id', '=', d.trip_id).forUpdate().execute();
        const r = await trx.selectFrom('booking_requests').selectAll().where('id', '=', d.id).forUpdate().executeTakeFirstOrThrow();
        if (r.status !== 'waiting') return null;
        await trx.updateTable('booking_requests').set({ status: 'expired', decided_at: now }).where('id', '=', d.id).execute();
        await this.release(trx, r);
        return r;
      });
      if (r) { n++; await this.notifyPassenger(r.passenger_id, 'request_expired', "The driver didn't reply in time. You can request again — same or another driver."); }
    }
    return n;
  }

  /** Background: WhatsApp backup to the driver if the push wasn't opened (default after 1 h). */
  async whatsappBackups(now = new Date()): Promise<number> {
    const { values } = await this.settings.versionAt(now);
    const before = new Date(now.getTime() - (values.whatsappBackupMinutes as number) * 60_000);
    const due = await this.db.selectFrom('booking_requests as r').innerJoin('trips as t', 't.id', 'r.trip_id').innerJoin('drivers as d', 'd.id', 't.driver_id')
      .select(['r.id', 'd.id as driverId', 'd.phone']).where('r.status', '=', 'waiting').where('r.driver_opened_at', 'is', null)
      .where('r.whatsapp_backup_at', 'is', null).where('r.created_at', '<=', before).execute();
    for (const d of due) {
      await this.messaging.send({ channel: 'whatsapp', to: d.phone, recipientType: 'driver', recipientId: d.driverId, template: 'new_request_reminder', body: 'You have a booking request waiting in the JTOS driver app.' });
      await this.db.updateTable('booking_requests').set({ whatsapp_backup_at: now }).where('id', '=', d.id).execute();
    }
    return due.length;
  }

  // ---------- T-015 complete booking (passenger chooses payment) ----------
  async complete(passengerId: string, bookingId: string, method: unknown) {
    if (method === 'online') throw new AppError(HttpStatus.BAD_REQUEST, 'COMING_SOON', 'Online payment is coming soon. Please choose cash.');
    if (method !== 'cash') throw badInput('BAD_METHOD', 'Choose cash.');
    if (!isUuid(bookingId)) throw notFound('Booking');
    const b = await this.db.selectFrom('bookings').selectAll().where('id', '=', bookingId).executeTakeFirst();
    if (!b || b.passenger_id !== passengerId) throw notFound('Booking');
    if (b.status === 'confirmed') return { bookingId, status: 'confirmed' };
    if (b.status !== 'awaiting_completion') throw conflict('BOOKING_CLOSED', 'This booking can no longer be completed.');
    await this.db.updateTable('bookings').set({ status: 'confirmed', payment_method: 'cash', completed_booking_at: new Date(), updated_at: new Date() }).where('id', '=', bookingId).execute();
    await this.audit.record({ actorType: 'passenger', actorId: passengerId, action: 'booking.completed', recordType: 'booking', recordId: bookingId, after: { paymentMethod: 'cash' } });
    // "Booked by" message to travellers who gave a contact (Q04).
    const p = await this.db.selectFrom('passengers').select(['full_name', 'phone']).where('id', '=', passengerId).executeTakeFirstOrThrow();
    const tr = await this.db.selectFrom('travellers').select(['full_name', 'contact']).where('request_id', '=', b.request_id).where('contact', 'is not', null).execute();
    for (const x of tr) {
      const phone = normalizePhone(x.contact);
      const body = `${p.full_name} booked a JTOS trip for you (${x.full_name}). Booking ${b.code}. Questions? Contact ${p.full_name} at ${p.phone}.`;
      if (phone) await this.messaging.send({ channel: 'whatsapp', to: phone, template: 'booked_by', body });
    }
    return { bookingId, status: 'confirmed' };
  }

  /** Called when the driver cancels a trip: close requests, cancel bookings, tell passengers. */
  async onTripCancelled(tripId: string) {
    const reqs = await this.db.updateTable('booking_requests').set({ status: 'trip_cancelled', decided_at: new Date() })
      .where('trip_id', '=', tripId).where('status', '=', 'waiting').returning(['passenger_id']).execute();
    const books = await this.db.updateTable('bookings').set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'driver_cancelled_trip', counts_toward_warning: false, updated_at: new Date() })
      .where('trip_id', '=', tripId).where('status', 'in', ['awaiting_completion', 'confirmed']).returning(['passenger_id', 'code']).execute();
    await this.db.updateTable('trips').set({ seats_held: 0, seats_booked: 0, whole_taken: false }).where('id', '=', tripId).execute();
    for (const r of reqs) await this.notifyPassenger(r.passenger_id, 'trip_cancelled', 'The driver cancelled this trip. Your request is closed — please choose another trip.');
    for (const b of books) await this.notifyPassenger(b.passenger_id, 'trip_cancelled', `The driver cancelled the trip for booking ${b.code}. Nothing to pay. Please choose another trip.`);
  }
}
