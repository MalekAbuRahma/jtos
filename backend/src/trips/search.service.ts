import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { addDays, isDate, jordanDate } from '../common/dates';
import { badInput, notFound } from '../common/errors';
import { jordanHHMM } from '../common/time';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { CatalogService } from './catalog.service';

const NEW_DRIVER_RATINGS = 5;
const shortName = (n: string | null) => {
  if (!n) return 'Driver';
  const [first, ...rest] = n.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
};

/**
 * T-012: public search and trip details — no sign-in needed.
 * Never returns the number plate, documents, or other passengers.
 */
@Injectable()
export class SearchService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private catalog: CatalogService, private settings: SettingsService) {}

  private async rows(fromId: string, toId: string, date: string) {
    // Everyone gets off at the final stop: "to" must be the trip's final stop.
    return this.db.selectFrom('trips as t')
      .innerJoin('trip_stops as a', (j) => j.onRef('a.trip_id', '=', 't.id').on('a.city_id', '=', fromId))
      .innerJoin('trip_stops as z', (j) => j.onRef('z.trip_id', '=', 't.id').on('z.city_id', '=', toId))
      .innerJoin('drivers as d', 'd.id', 't.driver_id')
      .innerJoin('vehicles as v', 'v.id', 't.vehicle_id')
      .select(['t.id', 't.booking_type', 't.seats_offered', 't.seats_booked', 't.seats_held', 't.whole_taken', 't.whole_price_fils', 't.vehicle_id',
        'a.seq as fromSeq', 'a.pickup_at', 'a.spot', 'a.section_price_fils', 'a.last_chance_price_fils', 'z.pickup_at as arriveAt',
        'd.id as driverId', 'd.full_name', 'd.rating_avg', 'd.rating_count', 'v.type as vehicleType', 'v.make', 'v.model', 'v.colour'])
      .where('t.status', '=', 'published').where('t.travel_date', '=', date)
      .where(sql<boolean>`z.seq = (select max(seq) from trip_stops where trip_id = t.id)`)
      .whereRef('a.seq', '<', 'z.seq')
      .execute();
  }

  async search(q: { from?: string; to?: string; date?: string; travellers?: string }) {
    if (!isDate(q.date)) throw badInput('BAD_DATE', 'Choose a date.');
    const from = await this.catalog.cityByCode(q.from);
    const to = await this.catalog.cityByCode(q.to);
    const travellers = q.travellers ? Math.max(1, Math.min(7, Number(q.travellers) || 1)) : 1;
    const { values } = await this.settings.versionAt();
    const cutoffMs = (values.bookingCutoffMinutes as number) * 60_000;
    const now = Date.now();
    const open = (r: Awaited<ReturnType<SearchService['rows']>>[number]) => {
      if (r.pickup_at.getTime() - cutoffMs <= now) return false;              // booking closed at your stop (T-009)
      if (r.booking_type === 'whole') return !r.whole_taken && r.seats_booked + r.seats_held === 0;
      return !r.whole_taken && r.seats_offered - r.seats_booked - r.seats_held >= travellers;
    };
    const rows = (await this.rows(from.id, to.id, q.date)).filter(open);
    const vt = new Map<string, number | null>();
    const results = [];
    for (const r of rows) {
      const key = r.vehicleType;
      if (!vt.has(key)) vt.set(key, (await this.catalog.range(from.id, to.id, r.vehicleType))?.normal ?? null);
      const normal = vt.get(key);
      const price = r.last_chance_price_fils ?? r.section_price_fils;
      const isNew = r.rating_count < NEW_DRIVER_RATINGS;
      const badges: string[] = [];
      if (r.last_chance_price_fils != null) badges.push('last_chance');
      else if (normal != null && r.section_price_fils != null && r.section_price_fils < normal) badges.push('good_price');
      if (isNew) badges.push('new');
      results.push({
        tripId: r.id, departs: jordanHHMM(r.pickup_at), departsAt: r.pickup_at, from: from.code, spot: r.spot, to: to.code, arrivesAbout: jordanHHMM(r.arriveAt),
        pricePerPerson: r.booking_type === 'whole' ? null : price, originalPrice: r.last_chance_price_fils != null ? r.section_price_fils : null,
        wholePrice: r.booking_type !== 'seats' && r.fromSeq === 1 ? r.whole_price_fils : null,
        seatsLeft: r.booking_type === 'whole' ? 0 : r.seats_offered - r.seats_booked - r.seats_held,
        driver: { id: r.driverId, name: shortName(r.full_name), rating: isNew ? null : Number(r.rating_avg), ratings: r.rating_count, isNew },
        vehicle: { type: r.vehicleType, make: r.make, model: r.model, colour: r.colour },
        badges,
      });
    }
    results.sort((a, b) => (a.pricePerPerson ?? a.wholePrice ?? 0) - (b.pricePerPerson ?? b.wholePrice ?? 0) || +a.departsAt - +b.departsAt);
    let suggestions: { date: string; trips: number }[] = [];
    if (!results.length) {
      suggestions = [];
      for (const d of [addDays(q.date, -1), addDays(q.date, 1)]) {
        if (d < jordanDate()) continue;
        suggestions.push({ date: d, trips: (await this.rows(from.id, to.id, d)).filter(open).length });
      }
    }
    return { from: from.code, to: to.code, date: q.date, travellers, results, suggestions };
  }

  async trip(id: string, fromCode?: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Trip');
    const t = await this.db.selectFrom('trips as t').innerJoin('drivers as d', 'd.id', 't.driver_id').innerJoin('vehicles as v', 'v.id', 't.vehicle_id')
      .select(['t.id', 't.status', 't.travel_date', 't.booking_type', 't.seats_offered', 't.seats_booked', 't.seats_held', 't.whole_taken', 't.whole_price_fils', 't.response_window_min',
        'd.id as driverId', 'd.full_name', 'd.rating_avg', 'd.rating_count', 'v.type', 'v.make', 'v.model', 'v.colour'])
      .where('t.id', '=', id).executeTakeFirst();
    if (!t || t.status !== 'published') throw notFound('Trip');
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id')
      .select(['s.seq', 'c.code', 'c.name_en', 'c.name_ar', 's.spot', 's.pickup_at', 's.section_price_fils', 's.last_chance_price_fils'])
      .where('s.trip_id', '=', id).orderBy('s.seq').execute();
    const { values } = await this.settings.versionAt();
    const cutoffMs = (values.bookingCutoffMinutes as number) * 60_000;
    const isNew = t.rating_count < NEW_DRIVER_RATINGS;
    return {
      tripId: t.id, date: t.travel_date, bookingType: t.booking_type,
      seatsLeft: t.whole_taken ? 0 : t.seats_offered - t.seats_booked - t.seats_held,
      wholeAvailable: t.booking_type !== 'seats' && !t.whole_taken && t.seats_booked + t.seats_held === 0,
      wholePrice: t.booking_type !== 'seats' ? t.whole_price_fils : null,
      driverRepliesWithinMinutes: t.response_window_min,
      stops: stops.map((s, i) => ({
        seq: s.seq, city: s.code, cityName: s.name_en, cityNameAr: s.name_ar, spot: s.spot, time: jordanHHMM(s.pickup_at),
        price: s.last_chance_price_fils ?? s.section_price_fils, originalPrice: s.last_chance_price_fils != null ? s.section_price_fils : null,
        isFinal: i === stops.length - 1, open: i < stops.length - 1 && s.pickup_at.getTime() - cutoffMs > Date.now(),
        yourStop: fromCode ? s.code === fromCode.toUpperCase() : false,
      })),
      driver: { id: t.driverId, name: shortName(t.full_name), rating: isNew ? null : Number(t.rating_avg), ratings: t.rating_count, isNew, photoUrl: `/v1/public/drivers/${t.driverId}/photo` },
      vehicle: { type: t.type, make: t.make, model: t.model, colour: t.colour },
      plateNote: 'The number plate shows after you complete your booking.',
    };
  }

  /** Driver photo for passengers: only the approved face photo of an approved driver with a published trip. */
  async driverPhoto(driverId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(driverId)) throw notFound('Photo');
    const row = await this.db.selectFrom('driver_documents as d').innerJoin('file_blobs as f', 'f.id', 'd.file_id').innerJoin('drivers as r', 'r.id', 'd.driver_id')
      .select(['f.mime', 'f.data']).where('d.driver_id', '=', driverId).where('d.type', '=', 'face_photo').where('d.status', '=', 'approved').where('r.status', '=', 'approved')
      .where((eb) => eb.exists(eb.selectFrom('trips').select('id').where('driver_id', '=', driverId).where('status', '=', 'published')))
      .orderBy('d.created_at', 'desc').executeTakeFirst();
    if (!row) throw notFound('Photo');
    return row;
  }
}
