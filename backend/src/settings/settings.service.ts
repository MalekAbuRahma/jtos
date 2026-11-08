import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AuditService } from '../common/audit.service';
import { badInput } from '../common/errors';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { DEFAULTS, SETTINGS, SettingsValues, validate } from './definitions';

export interface SettingsVersion { id: string; version: number; values: SettingsValues; effectiveFrom: Date; createdBy: string | null; }

@Injectable()
export class SettingsService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private audit: AuditService) {}

  /** Version 1 = owner defaults; created once. */
  async ensureDefaults(): Promise<void> {
    await sql`INSERT INTO settings_versions (version, "values", effective_from) VALUES (1, ${JSON.stringify(DEFAULTS)}::jsonb, '2000-01-01') ON CONFLICT (version) DO NOTHING`.execute(this.db);
  }

  /** The version in force at a moment (default now). Requests store this id (T-009 AC3). */
  async versionAt(at: Date = new Date()): Promise<SettingsVersion> {
    await this.ensureDefaults();
    const row = await this.db.selectFrom('settings_versions').selectAll()
      .where('effective_from', '<=', at).orderBy('version', 'desc').limit(1).executeTakeFirstOrThrow();
    return this.map(row);
  }

  async byId(id: string): Promise<SettingsVersion> {
    return this.map(await this.db.selectFrom('settings_versions').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  }

  async scheduled(): Promise<SettingsVersion[]> {
    const rows = await this.db.selectFrom('settings_versions').selectAll().where('effective_from', '>', new Date()).orderBy('version').execute();
    return rows.map((r) => this.map(r));
  }

  async lastChange() {
    return this.db.selectFrom('settings_versions as v').leftJoin('staff as s', 's.id', 'v.created_by')
      .select(['v.version', 'v.created_at', 's.full_name']).orderBy('v.version', 'desc').limit(1).executeTakeFirst();
  }

  /** Creates a new version; never edits an old one. */
  async change(staffId: string, changes: Record<string, unknown>, effectiveFrom?: string, ip?: string): Promise<SettingsVersion> {
    const unknownKeys = Object.keys(changes).filter((k) => !SETTINGS.some((s) => s.key === k));
    if (unknownKeys.length) throw badInput('UNKNOWN_SETTING', `Unknown setting: ${unknownKeys.join(', ')}.`);
    const when = effectiveFrom ? new Date(effectiveFrom) : new Date();
    if (Number.isNaN(when.getTime())) throw badInput('BAD_DATE', 'The start date is not valid.');
    return this.db.transaction().execute(async (trx) => {
      await sql`LOCK TABLE settings_versions IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
      const latest = await trx.selectFrom('settings_versions').selectAll().orderBy('version', 'desc').limit(1).executeTakeFirstOrThrow();
      const before = latest.values as unknown as SettingsValues;
      const next = { ...before, ...(changes as SettingsValues) };
      const errors = validate(next);
      if (errors.length) throw badInput('INVALID_SETTINGS', errors.join(' '));
      const row = await trx.insertInto('settings_versions')
        .values({ version: latest.version + 1, values: JSON.stringify(next), effective_from: when, created_by: staffId })
        .returningAll().executeTakeFirstOrThrow();
      const changedBefore = Object.fromEntries(Object.keys(changes).map((k) => [k, before[k]]));
      await this.audit.record({ actorType: 'staff', actorId: staffId, action: 'settings.changed', recordType: 'settings', recordId: String(row.version), before: changedBefore, after: { ...changes, effectiveFrom: when.toISOString() }, ip }, trx);
      return this.map(row);
    });
  }

  private map(r: { id: string; version: number; values: unknown; effective_from: Date; created_by: string | null }): SettingsVersion {
    return { id: r.id, version: r.version, values: r.values as SettingsValues, effectiveFrom: r.effective_from, createdBy: r.created_by };
  }
}
