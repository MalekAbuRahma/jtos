import { Controller, Get, Header, Inject, Query, UseGuards } from '@nestjs/common';
import { Kysely } from 'kysely';
import { badInput } from '../common/errors';
import { Require, StaffAuthGuard } from '../common/staff-auth.guard';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';

interface Filters { actorId?: string; action?: string; recordId?: string; from?: string; to?: string; limit?: string; }

/** T-008: read-only audit history for Admin and Auditor. No write endpoints exist. */
@Controller('v1/staff/audit')
@UseGuards(StaffAuthGuard)
export class AuditController {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>) {}

  private query(f: Filters) {
    let q = this.db.selectFrom('audit_log as a').leftJoin('staff as s', (j) => j.onRef('s.id', '=', 'a.actor_id').on('a.actor_type', '=', 'staff'))
      .select(['a.id', 'a.at', 'a.actor_type as actorType', 'a.actor_id as actorId', 's.full_name as actorName', 's.role as actorRole', 'a.action', 'a.record_type as recordType', 'a.record_id as recordId', 'a.before', 'a.after', 'a.ip']);
    if (f.actorId) q = q.where('a.actor_id', '=', f.actorId);
    if (f.action) q = q.where('a.action', '=', f.action);
    if (f.recordId) q = q.where('a.record_id', '=', f.recordId);
    for (const [k, op] of [['from', '>='], ['to', '<=']] as const) {
      const v = f[k];
      if (v) {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw badInput('BAD_DATE', `"${k}" is not a valid date.`);
        q = q.where('a.at', op, d);
      }
    }
    return q.orderBy('a.at', 'desc').orderBy('a.id', 'desc');
  }

  @Get() @Require('audit.view')
  async list(@Query() f: Filters) {
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
    return this.query(f).limit(limit).execute();
  }

  @Get('export') @Require('audit.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="jtos-audit.csv"')
  async export(@Query() f: Filters) {
    const rows = await this.query(f).limit(50_000).execute();
    const esc = (v: unknown) => {
      const s = v == null ? '' : typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cols = ['at', 'actorName', 'actorRole', 'action', 'recordType', 'recordId', 'before', 'after', 'ip'] as const;
    return [cols.join(','), ...rows.map((r: any) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }
}
