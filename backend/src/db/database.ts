import { Kysely, PostgresDialect, Generated, ColumnType } from 'kysely';
import { Pool } from 'pg';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;

export interface StaffTable {
  id: Generated<string>;
  email: string;
  full_name: string;
  password_hash: string | null;
  role: 'admin' | 'support' | 'auditor' | null;
  is_main_admin: Generated<boolean>;
  status: Generated<'invited' | 'active' | 'deactivated'>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface StaffLoginCodesTable {
  id: Generated<string>;
  staff_id: string;
  code_hash: string;
  expires_at: Ts;
  attempts: Generated<number>;
  used_at: Date | null;
  created_at: Generated<Date>;
}
export interface StaffInvitationsTable {
  id: Generated<string>;
  staff_id: string;
  token_hash: string;
  expires_at: Ts;
  used_at: Date | null;
  created_at: Generated<Date>;
}
export interface SettingsVersionsTable {
  id: Generated<string>;
  version: number;
  values: ColumnType<Record<string, unknown>, string, string>;
  effective_from: Ts;
  created_by: string | null;
  created_at: Generated<Date>;
}
export interface AuditLogTable {
  id: Generated<string>;
  at: Generated<Date>;
  actor_type: string;
  actor_id: string | null;
  action: string;
  record_type: string | null;
  record_id: string | null;
  before: ColumnType<unknown, string | null, never> | null;
  after: ColumnType<unknown, string | null, never> | null;
  ip: string | null;
}
export interface OutboxTable {
  id: Generated<string>;
  channel: string;
  recipient: string;
  template: string;
  status: Generated<string>;
  created_at: Generated<Date>;
}
export interface DB {
  staff: StaffTable;
  staff_login_codes: StaffLoginCodesTable;
  staff_invitations: StaffInvitationsTable;
  settings_versions: SettingsVersionsTable;
  audit_log: AuditLogTable;
  notifications_outbox: OutboxTable;
}

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 10 }) }) });
}
