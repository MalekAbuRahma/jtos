import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { DB } from '../db/database';
import { DB_TOKEN } from './tokens';

export interface AuditEntry {
  actorType: 'staff' | 'driver' | 'passenger' | 'system';
  actorId?: string | null;
  action: string;
  recordType?: string;
  recordId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>) {}

  /** Pass a transaction so the audit row commits or rolls back with the change. */
  async record(e: AuditEntry, trx?: Transaction<DB>): Promise<void> {
    await (trx ?? this.db)
      .insertInto('audit_log')
      .values({
        actor_type: e.actorType,
        actor_id: e.actorId ?? null,
        action: e.action,
        record_type: e.recordType ?? null,
        record_id: e.recordId ?? null,
        before: e.before === undefined ? null : JSON.stringify(e.before),
        after: e.after === undefined ? null : JSON.stringify(e.after),
        ip: e.ip ?? null,
      })
      .execute();
  }
}
