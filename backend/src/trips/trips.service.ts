import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { AuditService } from '../common/audit.service';
import { isDate, jordanDate } from '../common/dates';
import { AppError, badInput, conflict, notFound } from '../common/errors';
import { MessagingService } from '../common/messaging.service';
import { formatJod, isFils } from '../common/money';
import { maskContacts } from '../common/text';
import { jordanDateTime, jordanHHMM } from '../common/time';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { EligibilityService } from '../drivers/eligibility.service';
import { SettingsValues } from '../settings/definitions';
import { SettingsService } from '../settings/settings.service';
import { CatalogService, City } from './catalog.service';

type Driver = { id: string; status: string; phone: string };
interface StopIn { city: string; spot: string; time: string; price?: number | null }
export interface TripIn { date: string; stops: StopIn[]; seatsOffered: number; bookingType: 'seats' | 'whole' | 'both'; wholePrice?: number | null; responseWindowMinutes: number; notes?: string }

interface Normalized {
  date: string; seatsOffered: number; bookingType: 'seats' | 'whole' | 'both'; wholePrice: number | null; responseWindow: number; notes: string | null;
  stops: { city: City; spot: string; at: Date; price: number | null }[];
}

/** T-010 draft a trip, T-011 publish, T-013 capacity rules (driver side). */
@Injectable()
export class TripsService {
  constructor(
    @Inject(DB_TOKEN) private db: Kysely<DB>,
    private catalog: CatalogService,
    private settings: SettingsService,
    private eligibility: EligibilityService,
    private audit: AuditService,
    private messaging: MessagingService,
  ) {}

  // ---------------- validation ----------------
  private async normalize(input: TripIn, vehicle: { type: 'car' | 'van'; seats: number }, values: SettingsValues): Promise<Normalized> {
    const errors: string[] = [];
    const today = jordanDate();
    if (!isDate(input?.date)) throw badInput('BAD_DATE', 'Choose the trip date.');
    if (input.date < today) errors.push('The trip date has passed.');
    if (!Array.isArray(input.stops) || input.stops.length < 2) throw badInput('STOPS_REQUIRED', 'Add at least a start and a final stop.');
    if (input.stops.length > 8) errors.push('A trip can have at most 8 stops.');
    const stops: Normalized['stops'] = [];
    for (const [i, s] of input.stops.entries()) {
      const city = await this.catalog.cityByCode(s?.city);
      const at = jordanDateTime(input.date, s?.time);
      if (!at) { errors.push(`Stop ${i + 1}: enter the time as HH:MM.`); continue; }
      if (typeof s.spot !== 'string' || !s.spot.trim()) errors.push(`Stop ${i + 1} (${city.name_en}): enter the exact pickup spot.`);
      stops.push({ city, spot: maskContacts((s.spot ?? '').trim()).slice(0, 200), at, price: s.price ?? null });
    }
    if (new Set(stops.map((s) => s.city.code)).size !== stops.length) errors.push('Each city can appear only once.');
    for (let i = 1; i < stops.length; i++) if (stops[i].at <= stops[i - 1].at) errors.push(`Stop times must be in order: ${stops[i].city.name_en} is not after ${stops[i - 1].city.name_en}.`);
    const final = stops[stops.length - 1];
    if (final && final.price != null) errors.push('The final stop has no price (everyone gets off there).');
    for (const s of stops.slice(0, -1)) {
      if (!final) break;
      const r = await this.catalog.range(s.city.id, final.city.id, vehicle.type);
      if (!r) { errors.push(`No price range is set for ${s.city.name_en} → ${final.city.name_en}. Contact JTOS.`); continue; }
      if (!isFils(s.price)) errors.push(`${s.city.name_en}: enter the price.`);
      else if (s.price < r.min || s.price > r.max) errors.push(`${s.city.name_en} → ${final.city.name_en}: allowed ${formatJod(r.min)} – ${formatJod(r.max)}.`);
    }
    if (!Number.isInteger(input.seatsOffered) || input.seatsOffered < 1 || input.seatsOffered > vehicle.seats) errors.push(`Seats offered must be 1 to ${vehicle.seats} (your ${vehicle.type}).`);
    if (!['seats', 'whole', 'both'].includes(input.bookingType)) errors.push('Booking type must be seats, whole vehicle, or both.');
    let wholePrice: number | null = null;
    if (input.bookingType === 'whole' || input.bookingType === 'both') {
      const r = stops.length >= 2 ? await this.catalog.range(stops[0].city.id, final.city.id, vehicle.type) : null;
      if (!isFils(input.wholePrice)) errors.push('Enter the whole vehicle price.');
      else if (!r || r.wholeMin == null) errors.push(`No whole-vehicle price range is set for this route. Contact JTOS.`);
      else if (input.wholePrice < r.wholeMin || input.wholePrice > r.wholeMax!) errors.push(`Whole vehicle: allowed ${formatJod(r.wholeMin)} – ${formatJod(r.wholeMax!)}.`);
      else wholePrice = input.wholePrice;
    }
    const minW = values.driverResponseMinMinutes as number, maxW = values.driverResponseMaxMinutes as number;
    if (!Number.isInteger(input.responseWindowMinutes) || input.responseWindowMinutes < minW || input.responseWindowMinutes > maxW)
      errors.push(`Reply time must be between ${minW} minutes and ${maxW / 60} hours.`);
    if (errors.length) throw badInput('TRIP_RULES', errors.join(' '));
    return { date: input.date, seatsOffered: input.seatsOffered, bookingType: input.bookingType, wholePrice, responseWindow: input.responseWindowMinutes,
      notes: input.notes ? maskContacts(String(input.notes)).slice(0, 500) : null, stops };
  }

  private async approvedVehicle(driver: Driver) {
    if (driver.status !== 'approved') throw new AppError(HttpStatus.FORBIDDEN, 'NOT_APPROVED', 'Your account is not approved yet.');
    const v = await this.db.selectFrom('vehicles').selectAll().where('driver_id', '=', driver.id).where('status', '=', 'active').executeTakeFirst();
    if (!v) throw new AppError(HttpStatus.FORBIDDEN, 'NO_VEHICLE', 'You need an approved vehicle.');
    return v;
  }

  private async activeTripCount(driverId: string, exceptId?: string) {
    let q = this.db.selectFrom('trips').select((eb) => eb.fn.countAll<number>().as('n'))
      .where('driver_id', '=', driverId).where('status', 'in', ['draft', 'published']).where('travel_date', '>=', jordanDate());
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Number((await q.executeTakeFirstOrThrow()).n);
  }

  /** Own trips only (security point 14): someone else's trip looks "not found" and the attempt is logged. */
  private async ownTrip(driver: Driver, id: string, trx: Kysely<DB> | Transaction<DB> = this.db, lock = false) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Trip');
    let q = trx.selectFrom('trips').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const t = await q.executeTakeFirst();
    if (!t) throw notFound('Trip');
    if (t.driver_id !== driver.id) {
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.access_denied', recordType: 'trip', recordId: id });
      throw notFound('Trip');
    }
    return t;
  }

  private async writeStops(trx: Transaction<DB>, tripId: string, n: Normalized) {
    await trx.deleteFrom('trip_stops').where('trip_id', '=', tripId).execute();
    await trx.insertInto('trip_stops').values(n.stops.map((s, i) => ({
      trip_id: tripId, seq: i + 1, city_id: s.city.id, spot: s.spot, pickup_at: s.at, section_price_fils: s.price, last_chance_price_fils: null,
    }))).execute();
  }

  // ---------------- actions ----------------
  async create(driver: Driver, input: TripIn) {
    const vehicle = await this.approvedVehicle(driver);
    const { values } = await this.settings.versionAt();
    const n = await this.normalize(input, vehicle, values);
    if ((await this.activeTripCount(driver.id)) >= (values.maxActiveTrips as number))
      throw conflict('TOO_MANY_TRIPS', `You can have at most ${values.maxActiveTrips} upcoming trips.`);
    const id = await this.db.transaction().execute(async (trx) => {
      const t = await trx.insertInto('trips').values({
        driver_id: driver.id, vehicle_id: vehicle.id, travel_date: n.date, booking_type: n.bookingType, seats_offered: n.seatsOffered,
        whole_price_fils: n.wholePrice, response_window_min: n.responseWindow, notes: n.notes, settings_version_id: null,
        publish_action_id: null, published_at: null, suspended_reason: null, cancelled_reason: null,
      }).returning('id').executeTakeFirstOrThrow();
      await this.writeStops(trx, t.id, n);
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.created', recordType: 'trip', recordId: t.id }, trx);
      return t.id;
    });
    return this.view(driver, id);
  }

  async update(driver: Driver, id: string, input: TripIn) {
    const vehicle = await this.approvedVehicle(driver);
    const { values } = await this.settings.versionAt();
    const n = await this.normalize(input, vehicle, values);
    await this.db.transaction().execute(async (trx) => {
      const t = await this.ownTrip(driver, id, trx, true);
      if (!['draft', 'published'].includes(t.status)) throw conflict('TRIP_CLOSED', 'This trip can no longer be changed.');
      // T-011: after the first booking or request, time and stops are locked.
      if (t.seats_booked + t.seats_held > 0 || t.whole_taken)
        throw conflict('TRIP_LOCKED', "This trip has bookings, so you can't change the time or stops. You can lower the price of seats left, or cancel the trip.");
      if (n.seatsOffered < t.seats_booked + t.seats_held) throw conflict('SEATS_IN_USE', 'You can\'t offer fewer seats than are already booked or held.');
      if (t.status === 'published') await this.publishChecks(driver, n, values, t.id);
      await trx.updateTable('trips').set({ travel_date: n.date, booking_type: n.bookingType, seats_offered: n.seatsOffered, whole_price_fils: n.wholePrice,
        response_window_min: n.responseWindow, notes: n.notes, updated_at: new Date() }).where('id', '=', id).execute();
      await this.writeStops(trx, id, n);
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.edited', recordType: 'trip', recordId: id }, trx);
    });
    return this.view(driver, id);
  }

  private async publishChecks(driver: Driver, n: Normalized, values: SettingsValues, tripId: string) {
    const elig = await this.eligibility.check(driver.id, n.date);
    if (!elig.canPublish) throw conflict(elig.code!, elig.message!);
    if (n.stops[0].at <= new Date()) throw badInput('TRIP_STARTED', 'The first pickup time has already passed.');
    // No other published trip of his overlaps this time (first pickup → final stop).
    const start = n.stops[0].at, end = n.stops[n.stops.length - 1].at;
    const others = await this.db.selectFrom('trips as t').innerJoin('trip_stops as s', 's.trip_id', 't.id')
      .select(['t.id']).select((eb) => [eb.fn.min('s.pickup_at').as('start'), eb.fn.max('s.pickup_at').as('end')])
      .where('t.driver_id', '=', driver.id).where('t.status', '=', 'published').where('t.id', '!=', tripId).groupBy('t.id').execute();
    if (others.some((o) => new Date(o.start as any) < end && new Date(o.end as any) > start)) throw conflict('TRIP_OVERLAP', 'You already have a trip at this time.');
    if ((await this.activeTripCount(driver.id, tripId)) >= (values.maxActiveTrips as number))
      throw conflict('TOO_MANY_TRIPS', `You can have at most ${values.maxActiveTrips} upcoming trips.`);
  }

  /** T-011: instant publish after server checks. The same action ID never publishes twice. */
  async publish(driver: Driver, id: string, actionId?: string) {
    const vehicle = await this.approvedVehicle(driver);
    const settingsVersion = await this.settings.versionAt();
    const t0 = await this.ownTrip(driver, id);
    if (t0.status === 'published') return this.view(driver, id);
    if (t0.status !== 'draft') throw conflict('TRIP_CLOSED', 'Only a draft can be published.');
    const n = await this.normalize(await this.asInput(id), vehicle, settingsVersion.values);
    await this.publishChecks(driver, n, settingsVersion.values, id);
    await this.db.transaction().execute(async (trx) => {
      const t = await this.ownTrip(driver, id, trx, true);
      if (t.status !== 'draft') return;
      await trx.updateTable('trips').set({ status: 'published', published_at: new Date(), settings_version_id: settingsVersion.id, publish_action_id: actionId ?? null, vehicle_id: vehicle.id, updated_at: new Date() })
        .where('id', '=', id).execute();
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.published', recordType: 'trip', recordId: id }, trx);
    });
    return this.view(driver, id);
  }

  /** "Last chance": lower the price of the seats left. Never below the admin's lowest; new passengers only. */
  async lastChance(driver: Driver, id: string, prices: { seq: number; price: number }[]) {
    if (!Array.isArray(prices) || !prices.length) throw badInput('PRICES_REQUIRED', 'Enter at least one lower price.');
    const t = await this.ownTrip(driver, id);
    if (t.status !== 'published') throw conflict('NOT_PUBLISHED', 'Only a published trip can have a last-chance price.');
    const stops = await this.db.selectFrom('trip_stops').selectAll().where('trip_id', '=', id).orderBy('seq').execute();
    const vehicle = await this.db.selectFrom('vehicles').select('type').where('id', '=', t.vehicle_id).executeTakeFirstOrThrow();
    const final = stops[stops.length - 1];
    const errors: string[] = [];
    for (const p of prices) {
      const s = stops.find((x) => x.seq === p.seq && x.section_price_fils != null);
      if (!s) { errors.push(`Stop ${p.seq} has no price.`); continue; }
      const r = await this.catalog.range(s.city_id, final.city_id, vehicle.type);
      if (!isFils(p.price) || p.price >= s.section_price_fils!) errors.push(`Stop ${p.seq}: the last-chance price must be lower than ${formatJod(s.section_price_fils!)}.`);
      else if (r && p.price < r.min) errors.push(`Stop ${p.seq}: can't go below ${formatJod(r.min)}.`);
    }
    if (errors.length) throw badInput('LAST_CHANCE_RULES', errors.join(' '));
    for (const p of prices) await this.db.updateTable('trip_stops').set({ last_chance_price_fils: p.price }).where('trip_id', '=', id).where('seq', '=', p.seq).execute();
    await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.last_chance', recordType: 'trip', recordId: id, after: prices });
    return this.view(driver, id);
  }

  /** Cancelling a published trip counts toward the cancellation warning (after 2 in 30 days). */
  async cancel(driver: Driver, id: string, reason?: string) {
    const { values } = await this.settings.versionAt();
    const wasPublished = await this.db.transaction().execute(async (trx) => {
      const t = await this.ownTrip(driver, id, trx, true);
      if (!['draft', 'published'].includes(t.status)) throw conflict('TRIP_CLOSED', 'This trip is already closed.');
      await trx.updateTable('trips').set({ status: 'cancelled', cancelled_reason: reason ? maskContacts(String(reason)).slice(0, 300) : null, updated_at: new Date() }).where('id', '=', id).execute();
      if (t.status === 'published') await trx.insertInto('warnings').values({ subject_type: 'driver', subject_id: driver.id, kind: 'trip_cancelled', ref_type: 'trip', ref_id: id }).execute();
      await this.audit.record({ actorType: 'driver', actorId: driver.id, action: 'trip.cancelled', recordType: 'trip', recordId: id, after: { reason: reason ?? null } }, trx);
      return t.status === 'published';
    });
    // Passengers with bookings are notified here once bookings exist (T-014+).
    if (wasPublished) {
      const n = Number((await this.db.selectFrom('warnings').select((eb) => eb.fn.countAll<number>().as('n')).where('subject_type', '=', 'driver').where('subject_id', '=', driver.id)
        .where('kind', '=', 'trip_cancelled').where('at', '>', new Date(Date.now() - 30 * 86400_000)).executeTakeFirstOrThrow()).n);
      if (n > (values.cancellationWarningAfter as number))
        await this.messaging.send({ channel: 'push', to: driver.phone, recipientType: 'driver', recipientId: driver.id, template: 'driver_cancellation_warning',
          body: `You have cancelled ${n} trips in the last 30 days. More cancellations may stop you from publishing trips.` });
    }
    return { id, status: 'cancelled' };
  }

  /** "Repeat trip": same stops, times and prices on a new date, as a draft. */
  async repeat(driver: Driver, id: string, date: string) {
    await this.ownTrip(driver, id);
    const input = await this.asInput(id);
    return this.create(driver, { ...input, date });
  }

  async list(driver: Driver) {
    const trips = await this.db.selectFrom('trips').select('id').where('driver_id', '=', driver.id).orderBy('travel_date', 'desc').limit(100).execute();
    return Promise.all(trips.map((t) => this.view(driver, t.id)));
  }

  async view(driver: Driver, id: string) {
    const t = await this.ownTrip(driver, id);
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id')
      .select(['s.seq', 'c.code', 'c.name_en', 'c.name_ar', 's.spot', 's.pickup_at', 's.section_price_fils', 's.last_chance_price_fils'])
      .where('s.trip_id', '=', id).orderBy('s.seq').execute();
    return {
      id: t.id, status: t.status, date: t.travel_date, bookingType: t.booking_type, seatsOffered: t.seats_offered,
      seatsLeft: t.seats_offered - t.seats_booked - t.seats_held, seatsBooked: t.seats_booked, seatsHeld: t.seats_held, wholeTaken: t.whole_taken,
      wholePrice: t.whole_price_fils, responseWindowMinutes: t.response_window_min, notes: t.notes,
      locked: t.seats_booked + t.seats_held > 0 || t.whole_taken,
      stops: stops.map((s) => ({ seq: s.seq, city: s.code, cityName: s.name_en, cityNameAr: s.name_ar, spot: s.spot, time: jordanHHMM(s.pickup_at), pickupAt: s.pickup_at, price: s.section_price_fils, lastChancePrice: s.last_chance_price_fils })),
      suspendedReason: t.suspended_reason, cancelledReason: t.cancelled_reason, publishedAt: t.published_at,
    };
  }

  private async asInput(id: string): Promise<TripIn> {
    const t = await this.db.selectFrom('trips').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id').select(['c.code', 's.spot', 's.pickup_at', 's.section_price_fils'])
      .where('s.trip_id', '=', id).orderBy('s.seq').execute();
    return { date: t.travel_date, seatsOffered: t.seats_offered, bookingType: t.booking_type, wholePrice: t.whole_price_fils, responseWindowMinutes: t.response_window_min, notes: t.notes ?? undefined,
      stops: stops.map((s) => ({ city: s.code, spot: s.spot, time: jordanHHMM(s.pickup_at), price: s.section_price_fils })) };
  }
}
