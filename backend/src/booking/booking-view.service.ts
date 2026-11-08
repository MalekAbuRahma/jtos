import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { notFound } from '../common/errors';
import { jordanHHMM } from '../common/time';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';

/** T-017 booking page for the booker. The plate appears only after the booking step is completed. */
@Injectable()
export class BookingViewService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>) {}

  list(passengerId: string) {
    return this.db.selectFrom('bookings as b').innerJoin('trips as t', 't.id', 'b.trip_id')
      .select(['b.id', 'b.code', 'b.status', 'b.total_fils as total', 't.travel_date as date', 'b.created_at as createdAt'])
      .where('b.passenger_id', '=', passengerId).orderBy('t.travel_date', 'desc').limit(100).execute();
  }

  async view(passengerId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Booking');
    const b = await this.db.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirst();
    if (!b || b.passenger_id !== passengerId) throw notFound('Booking');
    const t = await this.db.selectFrom('trips as t').innerJoin('drivers as d', 'd.id', 't.driver_id').innerJoin('vehicles as v', 'v.id', 't.vehicle_id')
      .select(['t.id', 't.status', 't.travel_date', 'd.id as driverId', 'd.full_name', 'd.rating_avg', 'd.rating_count', 'v.make', 'v.model', 'v.colour', 'v.type', 'v.plate'])
      .where('t.id', '=', b.trip_id).executeTakeFirstOrThrow();
    const stops = await this.db.selectFrom('trip_stops as s').innerJoin('cities as c', 'c.id', 's.city_id')
      .select(['s.seq', 'c.code', 'c.name_en', 'c.name_ar', 's.spot', 's.pickup_at']).where('s.trip_id', '=', b.trip_id).orderBy('s.seq').execute();
    const tr = await this.db.selectFrom('travellers').select(['idx', 'type', 'full_name', 'board_seq', 'board_spot', 'price_fils', 'boarding_status']).where('request_id', '=', b.request_id).orderBy('idx').execute();
    const unlocked = !!b.completed_booking_at && ['confirmed', 'completed'].includes(b.status);
    const name = t.full_name ?? 'Driver';
    return {
      id: b.id, code: b.code, status: b.status, total: b.total_fils, paymentMethod: b.payment_method,
      payment: b.payment_method === 'cash' ? 'Pay in cash to the driver when you get in the car.' : 'Choose how to pay to complete your booking.',
      date: t.travel_date, tripStatus: t.status,
      stops: stops.map((s) => ({ seq: s.seq, city: s.code, cityName: s.name_en, cityNameAr: s.name_ar, spot: s.spot, time: jordanHHMM(s.pickup_at) })),
      travellers: tr.map((x) => ({ idx: x.idx, type: x.type, fullName: x.full_name, getsOnAt: stops.find((s) => s.seq === x.board_seq)?.name_en, spot: x.board_spot, price: x.price_fils, boarding: x.boarding_status })),
      driver: { id: t.driverId, name, rating: t.rating_count >= 5 ? Number(t.rating_avg) : null, isNew: t.rating_count < 5 },
      vehicle: { type: t.type, make: t.make, model: t.model, colour: t.colour, plate: unlocked ? t.plate : null },
      plateNote: unlocked ? undefined : 'The number plate shows after you complete your booking.',
      chatOpen: unlocked,
      canCancel: ['awaiting_completion', 'confirmed'].includes(b.status),
    };
  }
}
