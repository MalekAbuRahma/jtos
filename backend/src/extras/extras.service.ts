import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AuditService } from '../common/audit.service';
import { randomToken, sha256 } from '../common/crypto';
import { encrypt } from '../common/data-crypto';
import { badInput, conflict, notFound } from '../common/errors';
import { MessagingService } from '../common/messaging.service';
import { maskContacts } from '../common/text';
import { jordanHHMM } from '../common/time';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { SettingsValues } from '../settings/definitions';
import { SettingsService } from '../settings/settings.service';

type Who = { type: 'passenger' | 'driver'; id: string };

/** T-025 AC1: (gross fare − fixed fees and taxes) × (1 − commission) + bonuses + tips. All in fils. */
export function driverEntitlement(o: { gross: number; feesAndTaxes?: number; commissionPercent: number; bonuses?: number; tips?: number }) {
  const base = o.gross - (o.feesAndTaxes ?? 0);
  const commission = Math.round((base * o.commissionPercent) / 100);
  return { commission, entitlement: base - commission + (o.bonuses ?? 0) + (o.tips ?? 0) };
}
const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const LAST_N = 50;

/** T-009/Q13 ratings, T-017 chat and Share trip, T-025 earnings, Q04 removing a traveller. */
@Injectable()
export class ExtrasService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private settings: SettingsService, private audit: AuditService, private messaging: MessagingService) {}

  /** The booking, checked to belong to this passenger (as booker) or driver. */
  private async booking(who: Who, bookingId: string) {
    if (!isUuid(bookingId)) throw notFound('Booking');
    const b = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').innerJoin('booking_requests as r', 'r.id', 'b.request_id')
      .select(['b.id', 'b.code', 'b.status', 'b.passenger_id', 'b.completed_booking_at', 'b.total_fils', 'b.request_id', 'r.settings_version_id', 'r.seats', 'r.kind',
        't.id as tripId', 't.driver_id', 't.status as tripStatus', 't.completed_at', 't.travel_date'])
      .where('b.id', '=', bookingId).executeTakeFirst();
    if (!b || (who.type === 'passenger' ? b.passenger_id : b.driver_id) !== who.id) throw notFound('Booking');
    return b;
  }

  // ---------- ratings ----------
  async rate(who: Who, bookingId: string, stars: unknown, comment?: unknown) {
    const b = await this.booking(who, bookingId);
    if (b.status !== 'completed' || !b.completed_at) throw conflict('NOT_COMPLETED', 'You can rate after the trip is completed.');
    const v = (await this.db.selectFrom('settings_versions').select('values').where('id', '=', b.settings_version_id).executeTakeFirstOrThrow()).values as SettingsValues;
    const hours = v.ratingWindowHours as number;
    if (Date.now() - b.completed_at.getTime() > hours * 3600_000) throw conflict('RATING_CLOSED', `Ratings close ${hours} hours after the trip.`);
    if (!Number.isInteger(stars) || (stars as number) < 1 || (stars as number) > 5) throw badInput('BAD_STARS', 'Choose 1 to 5 stars.');
    const to = who.type === 'passenger' ? { type: 'driver', id: b.driver_id } : { type: 'passenger', id: b.passenger_id };
    const exists = await this.db.selectFrom('ratings').select('id').where('booking_id', '=', bookingId).where('from_type', '=', who.type).executeTakeFirst();
    if (exists) throw conflict('ALREADY_RATED', 'You already rated this trip.');
    await this.db.insertInto('ratings').values({ booking_id: bookingId, from_type: who.type, from_id: who.id, to_type: to.type, to_id: to.id, stars: stars as number,
      comment: typeof comment === 'string' && comment.trim() ? maskContacts(comment.trim()).slice(0, 500) : null }).execute();
    await this.recompute(to.type as 'driver' | 'passenger', to.id);
    return { ok: true };
  }

  /** Average of the last 50 visible ratings; warning below 4.0, admin review below 3.5 (settings). */
  async recompute(type: 'driver' | 'passenger', id: string) {
    const rows = await this.db.selectFrom('ratings').select('stars').where('to_type', '=', type).where('to_id', '=', id).where('hidden', '=', false).orderBy('created_at', 'desc').limit(LAST_N).execute();
    const all = Number((await this.db.selectFrom('ratings').select((eb) => eb.fn.countAll<number>().as('n')).where('to_type', '=', type).where('to_id', '=', id).where('hidden', '=', false).executeTakeFirstOrThrow()).n);
    const avg = rows.length ? Math.round((rows.reduce((a, r) => a + r.stars, 0) / rows.length) * 100) / 100 : null;
    const table = type === 'driver' ? 'drivers' : 'passengers';
    await this.db.updateTable(table as 'drivers').set({ rating_avg: avg == null ? null : avg.toFixed(2), rating_count: all }).where('id', '=', id).execute();
    const { values } = await this.settings.versionAt();
    if (avg != null && all >= 5) {
      const kind = avg < (values.ratingReviewBelow as number) ? 'rating_review' : avg < (values.ratingWarnBelow as number) ? 'rating_warning' : null;
      if (kind) {
        const recent = await this.db.selectFrom('warnings').select('id').where('subject_type', '=', type).where('subject_id', '=', id).where('kind', '=', kind).where('at', '>', new Date(Date.now() - 7 * 86400_000)).executeTakeFirst();
        if (!recent) {
          await this.db.insertInto('warnings').values({ subject_type: type, subject_id: id, kind, ref_type: null, ref_id: null }).execute();
          const phone = (await this.db.selectFrom(table as 'drivers').select('phone').where('id', '=', id).executeTakeFirstOrThrow()).phone;
          await this.messaging.send({ channel: 'push', to: phone, recipientType: type, recipientId: id, template: kind,
            body: kind === 'rating_review' ? `Your rating is ${avg.toFixed(1)}. Our team will review your account.` : `Your rating is ${avg.toFixed(1)}. Please keep trips on time and friendly.` });
        }
      }
    }
    return avg;
  }

  // ---------- chat ----------
  private async chatBooking(who: Who, bookingId: string) {
    const b = await this.booking(who, bookingId);
    if (!b.completed_booking_at || !['confirmed', 'completed'].includes(b.status)) throw conflict('CHAT_CLOSED', 'Chat opens after the booking is completed.');
    return b;
  }
  async messages(who: Who, bookingId: string) {
    await this.chatBooking(who, bookingId);
    const rows = await this.db.selectFrom('chat_messages').select(['id', 'sender_type', 'body_masked', 'created_at']).where('booking_id', '=', bookingId).orderBy('created_at').limit(500).execute();
    return rows.map((r) => ({ id: r.id, mine: r.sender_type === who.type, from: r.sender_type, text: r.body_masked, at: r.created_at }));
  }
  async send(who: Who, bookingId: string, text: unknown) {
    const b = await this.chatBooking(who, bookingId);
    if (typeof text !== 'string' || !text.trim()) throw badInput('EMPTY', 'Write a message.');
    const raw = text.trim().slice(0, 1000);
    const masked = maskContacts(raw);
    const m = await this.db.insertInto('chat_messages').values({ booking_id: bookingId, sender_type: who.type, sender_id: who.id, body_masked: masked, body_raw_enc: encrypt(raw) }).returning(['id', 'created_at']).executeTakeFirstOrThrow();
    const toId = who.type === 'passenger' ? b.driver_id : b.passenger_id;
    const phone = who.type === 'passenger' ? (await this.db.selectFrom('drivers').select('phone').where('id', '=', toId).executeTakeFirstOrThrow()).phone : (await this.db.selectFrom('passengers').select('phone').where('id', '=', toId).executeTakeFirstOrThrow()).phone;
    await this.messaging.send({ channel: 'push', to: phone, recipientType: who.type === 'passenger' ? 'driver' : 'passenger', recipientId: toId, template: 'chat_message', body: `New message about booking ${b.code}: ${masked.slice(0, 80)}` });
    return { id: m.id, text: masked, at: m.created_at };
  }

  // ---------- live position + Share trip ----------
  async position(driverId: string, tripId: string, lat: unknown, lng: unknown) {
    if (!isUuid(tripId)) throw notFound('Trip');
    const t = await this.db.selectFrom('trips').select(['driver_id', 'status']).where('id', '=', tripId).executeTakeFirst();
    if (!t || t.driver_id !== driverId) throw notFound('Trip');
    if (t.status !== 'running') throw conflict('NOT_RUNNING', 'Location is shared only while the trip is running.');
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badInput('BAD_LOCATION', 'Invalid location.');
    await this.db.updateTable('trips').set({ last_lat: lat, last_lng: lng, last_position_at: new Date() }).where('id', '=', tripId).execute();
    return { ok: true };
  }

  async shareLink(passengerId: string, bookingId: string) {
    const b = await this.booking({ type: 'passenger', id: passengerId }, bookingId);
    if (!b.completed_booking_at || !['confirmed', 'completed'].includes(b.status)) throw conflict('NOT_READY', 'Share trip works after you complete your booking.');
    const token = randomToken();
    await this.db.insertInto('share_links').values({ booking_id: bookingId, token_hash: sha256(token) }).execute();
    return { url: `/share/${token}`, token };
  }

  /** Public page for family: no passport data, no phone numbers; position only while running. */
  async sharedTrip(token: string) {
    if (typeof token !== 'string' || token.length < 20) throw notFound('Link');
    const l = await this.db.selectFrom('share_links as l').innerJoin('bookings as b', 'b.id', 'l.booking_id').innerJoin('trips as t', 't.id', 'b.trip_id')
      .innerJoin('drivers as d', 'd.id', 't.driver_id').innerJoin('vehicles as v', 'v.id', 't.vehicle_id')
      .select(['b.status as bookingStatus', 't.id as tripId', 't.status', 't.travel_date', 't.last_lat', 't.last_lng', 't.last_position_at', 'd.full_name', 'v.make', 'v.model', 'v.colour', 'v.plate'])
      .where('l.token_hash', '=', sha256(token)).executeTakeFirst();
    if (!l) throw notFound('Link');
    if (['completed', 'cancelled'].includes(l.status) || ['cancelled', 'completed', 'no_show'].includes(l.bookingStatus)) return { status: 'ended', message: 'Trip ended.' };
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id').select(['c.name_en', 's.pickup_at', 's.arrived_at']).where('s.trip_id', '=', l.tripId).orderBy('s.seq').execute();
    return {
      status: l.status === 'running' ? 'on_the_way' : 'scheduled', date: l.travel_date,
      driver: (l.full_name ?? 'Driver').split(/\s+/)[0], car: `${l.colour} ${l.make} ${l.model}`, plate: l.plate,
      stops: stops.map((s) => ({ city: s.name_en, time: jordanHHMM(s.pickup_at), passed: !!s.arrived_at })),
      position: l.status === 'running' && l.last_lat != null ? { lat: l.last_lat, lng: l.last_lng, at: l.last_position_at } : null,
    };
  }

  // ---------- T-025 earnings ----------
  async earnings(driverId: string, period: unknown) {
    const days = period === 'today' ? 0 : period === 'month' ? 30 : 7;
    const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - days);
    const rows = await this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id').innerJoin('booking_requests as r', 'r.id', 'b.request_id')
      .innerJoin('settings_versions as sv', 'sv.id', 'r.settings_version_id').leftJoin('cash_records as c', 'c.booking_id', 'b.id')
      .select(['b.id', 'b.code', 'b.status', 'b.total_fils', 'r.seats', 'r.kind', 't.travel_date', 't.id as tripId', 'c.received_fils', 'c.status as cashStatus'])
      .select(sql<number>`(sv.values->>'commissionPercent')::numeric`.as('commissionPercent'))
      .where('t.driver_id', '=', driverId).where('b.status', 'in', ['completed', 'confirmed']).where('t.completed_at', '>=', since).orderBy('t.travel_date', 'desc').execute();
    const lines = rows.map((r) => {
      const received = r.received_fils ?? 0;
      const pct = Number(r.commissionPercent) || 0;
      // (fare − fees and taxes) × (1 − commission) + bonuses + tips; release 1: fees, taxes, bonuses, tips = 0.
      const commission = Math.round((received * pct) / 100);
      return { bookingId: r.id, code: r.code, date: r.travel_date, seats: r.seats, fare: r.total_fils, cashReceived: received, cashStatus: r.cashStatus ?? 'not_recorded',
        commission, commissionPercent: pct, youEarn: received - commission, counted: r.status === 'completed' && received > 0 };
    });
    const counted = lines.filter((l) => l.counted);
    return { period: period === 'today' || period === 'month' ? period : 'week', bookings: lines,
      totals: { fare: counted.reduce((a, l) => a + l.fare, 0), cashReceived: counted.reduce((a, l) => a + l.cashReceived, 0), commission: counted.reduce((a, l) => a + l.commission, 0), youEarn: counted.reduce((a, l) => a + l.youEarn, 0) } };
  }

  // ---------- Q04 remove a traveller ----------
  async removeTraveller(passengerId: string, requestId: string, idx: number) {
    if (!isUuid(requestId)) throw notFound('Request');
    return this.db.transaction().execute(async (trx) => {
      const r0 = await trx.selectFrom('booking_requests').selectAll().where('id', '=', requestId).executeTakeFirst();
      if (!r0 || r0.passenger_id !== passengerId) throw notFound('Request');
      await trx.selectFrom('trips').select('id').where('id', '=', r0.trip_id).forUpdate().execute();
      const r = await trx.selectFrom('booking_requests').selectAll().where('id', '=', requestId).forUpdate().executeTakeFirstOrThrow();
      const list = await trx.selectFrom('travellers').selectAll().where('request_id', '=', requestId).where('removed_at', 'is', null).orderBy('idx').execute();
      const x = list.find((t) => t.idx === Number(idx));
      if (!x) throw notFound('Traveller');
      const going = list.filter((t) => t.id === x.id || (t.type === 'baby' && t.lap_of_idx === x.idx));
      const left = list.filter((t) => !going.includes(t));
      if (!left.some((t) => t.type === 'adult')) throw conflict('LAST_ADULT', 'At least one adult must travel. Withdraw or cancel instead.');
      const now = new Date();
      await trx.updateTable('travellers').set({ removed_at: now, doc_number_enc: null, doc_hash: null }).where('id', 'in', going.map((t) => t.id)).execute();
      if (r.status === 'waiting') {
        // Before acceptance the price goes down and the seats are released.
        const seatsFreed = going.filter((t) => t.type !== 'baby').length;
        const minus = going.reduce((a, t) => a + t.price_fils, 0);
        await trx.updateTable('booking_requests').set({ seats: r.seats - seatsFreed, head_count: r.head_count - going.length, total_fils: r.total_fils - minus }).where('id', '=', requestId).execute();
        await trx.updateTable('trips').set((eb) => ({ seats_held: eb('seats_held', '-', seatsFreed) })).where('id', '=', r.trip_id).execute();
        return { removed: going.length, newTotal: r.total_fils - minus, seatStaysPaid: false };
      }
      if (r.status === 'accepted') {
        const b = await trx.selectFrom('bookings').select(['status']).where('request_id', '=', requestId).executeTakeFirstOrThrow();
        if (!['awaiting_completion', 'confirmed'].includes(b.status)) throw conflict('BOOKING_CLOSED', 'This booking can no longer change.');
        // After acceptance the seat stays paid (Q04).
        return { removed: going.length, newTotal: r.total_fils, seatStaysPaid: true };
      }
      throw conflict('REQUEST_CLOSED', 'This request is closed.');
    });
  }
}
