import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { DOC_LABELS } from './rules';

export interface Eligibility { canPublish: boolean; code?: string; message?: string; earliestExpiry: string | null; }

/**
 * T-004: a driver may publish a trip only if approved, with an approved car,
 * and the trip date is on or before the earliest expiry of their approved documents.
 * Documents waiting for review never count (TC-04).
 */
@Injectable()
export class EligibilityService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>) {}

  async check(driverId: string, tripDate: string): Promise<Eligibility> {
    const d = await this.db.selectFrom('drivers').select('status').where('id', '=', driverId).executeTakeFirstOrThrow();
    const docs = await this.db.selectFrom('driver_documents').select(['type', 'expires_at'])
      .where('driver_id', '=', driverId).where('status', '=', 'approved').where('expires_at', 'is not', null).execute();
    const earliest = docs.reduce<{ type: string; date: string } | null>((m, x) => (!m || x.expires_at! < m.date ? { type: x.type, date: x.expires_at! } : m), null);
    const base = { earliestExpiry: earliest?.date ?? null };
    if (d.status !== 'approved') return { ...base, canPublish: false, code: 'NOT_APPROVED', message: 'Your account is not approved yet.' };
    const car = await this.db.selectFrom('vehicles').select('id').where('driver_id', '=', driverId).where('status', '=', 'active').executeTakeFirst();
    if (!car) return { ...base, canPublish: false, code: 'NO_VEHICLE', message: 'You need an approved vehicle.' };
    if (earliest && tripDate > earliest.date) {
      const label = DOC_LABELS[earliest.type as keyof typeof DOC_LABELS];
      return { ...base, canPublish: false, code: 'DOCUMENT_EXPIRES', message: `Your ${label.toLowerCase()} expires on ${earliest.date}. Renew it to publish trips after that date.` };
    }
    return { ...base, canPublish: true };
  }
}
