import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AuditService } from '../common/audit.service';
import { badInput } from '../common/errors';
import { isFils } from '../common/money';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';

export interface City { id: string; code: string; name_en: string; name_ar: string; country: string; }
export interface Range { min: number; max: number; normal: number; wholeMin: number | null; wholeMax: number | null; wholeNormal: number | null; }

/** Cities and admin price ranges (Q05). */
@Injectable()
export class CatalogService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private audit: AuditService) {}

  cities(): Promise<City[]> {
    return this.db.selectFrom('cities').select(['id', 'code', 'name_en', 'name_ar', 'country']).orderBy('country').orderBy('name_en').execute();
  }

  async cityByCode(code: unknown): Promise<City> {
    const c = typeof code === 'string' ? await this.db.selectFrom('cities').select(['id', 'code', 'name_en', 'name_ar', 'country']).where('code', '=', code.toUpperCase()).executeTakeFirst() : undefined;
    if (!c) throw badInput('BAD_CITY', `Unknown city "${String(code)}".`);
    return c;
  }

  async range(fromId: string, toId: string, vehicleType: 'car' | 'van'): Promise<Range | null> {
    const r = await this.db.selectFrom('price_ranges').selectAll().where('from_city_id', '=', fromId).where('to_city_id', '=', toId).where('vehicle_type', '=', vehicleType).executeTakeFirst();
    return r ? { min: r.min_fils, max: r.max_fils, normal: r.normal_fils, wholeMin: r.whole_min_fils, wholeMax: r.whole_max_fils, wholeNormal: r.whole_normal_fils } : null;
  }

  listRanges() {
    return this.db.selectFrom('price_ranges as p').innerJoin('cities as f', 'f.id', 'p.from_city_id').innerJoin('cities as t', 't.id', 'p.to_city_id')
      .select(['p.id', 'f.code as from', 't.code as to', 'p.vehicle_type as vehicleType', 'p.min_fils as min', 'p.max_fils as max', 'p.normal_fils as normal',
        'p.whole_min_fils as wholeMin', 'p.whole_max_fils as wholeMax', 'p.whole_normal_fils as wholeNormal', 'p.updated_at as updatedAt'])
      .orderBy('f.code').orderBy('t.code').orderBy('p.vehicle_type').execute();
  }

  async saveRange(staffId: string, b: any, ip?: string) {
    const from = await this.cityByCode(b?.from);
    const to = await this.cityByCode(b?.to);
    if (from.id === to.id) throw badInput('SAME_CITY', 'From and to must be different cities.');
    if (b?.vehicleType !== 'car' && b?.vehicleType !== 'van') throw badInput('BAD_TYPE', 'Vehicle type must be car or van.');
    for (const k of ['min', 'max', 'normal']) if (!isFils(b?.[k])) throw badInput('BAD_PRICE', `${k} must be a price in fils.`);
    if (!(b.min <= b.normal && b.normal <= b.max)) throw badInput('BAD_RANGE', 'Lowest ≤ normal ≤ highest.');
    const whole = ['wholeMin', 'wholeMax', 'wholeNormal'].map((k) => b?.[k] ?? null);
    if (whole.some((v) => v !== null) && (!whole.every(isFils) || !(whole[0] <= whole[2] && whole[2] <= whole[1]))) throw badInput('BAD_RANGE', 'Whole vehicle: lowest ≤ normal ≤ highest.');
    const before = await this.range(from.id, to.id, b.vehicleType);
    const values = { min_fils: b.min, max_fils: b.max, normal_fils: b.normal, whole_min_fils: whole[0], whole_max_fils: whole[1], whole_normal_fils: whole[2], updated_by: staffId, updated_at: new Date() };
    await this.db.insertInto('price_ranges').values({ from_city_id: from.id, to_city_id: to.id, vehicle_type: b.vehicleType, ...values })
      .onConflict((oc) => oc.columns(['from_city_id', 'to_city_id', 'vehicle_type']).doUpdateSet(values)).execute();
    await this.audit.record({ actorType: 'staff', actorId: staffId, action: 'price_range.saved', recordType: 'price_range', recordId: `${from.code}-${to.code}-${b.vehicleType}`, before, after: { min: b.min, max: b.max, normal: b.normal, wholeMin: whole[0], wholeMax: whole[1], wholeNormal: whole[2] }, ip });
    return { from: from.code, to: to.code, vehicleType: b.vehicleType, min: b.min, max: b.max, normal: b.normal, wholeMin: whole[0], wholeMax: whole[1], wholeNormal: whole[2] };
  }
}
