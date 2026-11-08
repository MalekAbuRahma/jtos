import { Kysely, PostgresDialect, Generated, ColumnType } from 'kysely';
import { Pool, types } from 'pg';

// DATE columns stay plain 'YYYY-MM-DD' strings (no time-zone shifts).
types.setTypeParser(1082, (v) => v);

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
  recipient_type: string | null;
  recipient_id: string | null;
  template: string;
  status: Generated<string>;
  created_at: Generated<Date>;
}
export interface OtpCodesTable {
  id: Generated<string>;
  audience: string;
  purpose: string;
  target: string;
  channel: string;
  code_hash: string;
  context: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  expires_at: Ts;
  attempts: Generated<number>;
  used_at: Date | null;
  created_at: Generated<Date>;
}
export interface PassengersTable {
  id: Generated<string>;
  phone: string;
  email: string;
  full_name: string;
  status: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface DriversTable {
  id: Generated<string>;
  phone: string;
  email: string | null;
  full_name: string | null;
  status: Generated<'draft' | 'submitted' | 'approved' | 'sent_back' | 'rejected' | 'suspended'>;
  rating_avg: string | null;
  rating_count: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface FileBlobsTable {
  id: Generated<string>;
  owner_type: string;
  owner_id: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  data: Buffer;
  created_at: Generated<Date>;
}
export interface VehiclesTable {
  id: Generated<string>;
  driver_id: string;
  status: Generated<'pending' | 'active' | 'retired' | 'rejected'>;
  type: 'car' | 'van';
  make: string;
  model: string;
  year: number;
  colour: string;
  plate: string;
  seats: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type DocType = 'licence' | 'registration' | 'insurance' | 'face_photo' | 'id_document' | 'good_conduct';
export interface DriverDocumentsTable {
  id: Generated<string>;
  driver_id: string;
  type: DocType;
  file_id: string;
  expires_at: string | null;
  status: Generated<'pending' | 'approved' | 'rejected' | 'superseded'>;
  review_note: string | null;
  expiry_warned_at: Date | null;
  created_at: Generated<Date>;
}
export interface DriverApplicationsTable {
  id: Generated<string>;
  driver_id: string;
  kind: 'initial' | 'renewal' | 'vehicle_change';
  status: Generated<'submitted' | 'approved' | 'sent_back' | 'rejected'>;
  document_ids: ColumnType<string[], string[] | undefined, string[]>;
  vehicle_id: string | null;
  submitted_at: Generated<Date>;
  decided_at: Date | null;
  decided_by: string | null;
  note: string | null;
  document_notes: ColumnType<Record<string, string> | null, string | null, string | null>;
}
export interface DB {
  staff: StaffTable;
  staff_login_codes: StaffLoginCodesTable;
  staff_invitations: StaffInvitationsTable;
  settings_versions: SettingsVersionsTable;
  audit_log: AuditLogTable;
  notifications_outbox: OutboxTable;
  otp_codes: OtpCodesTable;
  passengers: PassengersTable;
  drivers: DriversTable;
  file_blobs: FileBlobsTable;
  vehicles: VehiclesTable;
  driver_documents: DriverDocumentsTable;
  driver_applications: DriverApplicationsTable;
}

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 10 }) }) });
}
