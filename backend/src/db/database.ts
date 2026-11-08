import { Kysely, PostgresDialect, Generated, ColumnType } from 'kysely';
import { Pool, types } from 'pg';

// DATE columns stay plain 'YYYY-MM-DD' strings (no time-zone shifts).
types.setTypeParser(1082, (v) => v);
// BIGINT (money in fils) as JS numbers — safe up to 9 quadrillion fils.
types.setTypeParser(20, (v) => Number(v));

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
export interface CitiesTable {
  id: Generated<string>;
  code: string;
  name_en: string;
  name_ar: string;
  country: string;
  lat: number | null;
  lng: number | null;
}
export interface PriceRangesTable {
  id: Generated<string>;
  from_city_id: string;
  to_city_id: string;
  vehicle_type: 'car' | 'van';
  min_fils: ColumnType<number, number, number>;
  max_fils: ColumnType<number, number, number>;
  normal_fils: ColumnType<number, number, number>;
  whole_min_fils: number | null;
  whole_max_fils: number | null;
  whole_normal_fils: number | null;
  updated_by: string | null;
  updated_at: Generated<Date>;
}
export type TripStatus = 'draft' | 'published' | 'suspended' | 'cancelled' | 'completed';
export interface TripsTable {
  id: Generated<string>;
  driver_id: string;
  vehicle_id: string;
  status: Generated<TripStatus>;
  travel_date: string;
  booking_type: 'seats' | 'whole' | 'both';
  seats_offered: number;
  whole_price_fils: number | null;
  response_window_min: number;
  notes: string | null;
  settings_version_id: string | null;
  publish_action_id: string | null;
  seats_booked: Generated<number>;
  seats_held: Generated<number>;
  whole_taken: Generated<boolean>;
  published_at: Date | null;
  suspended_reason: string | null;
  cancelled_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface TripStopsTable {
  id: Generated<string>;
  trip_id: string;
  seq: number;
  city_id: string;
  spot: string;
  pickup_at: Ts;
  section_price_fils: number | null;
  last_chance_price_fils: number | null;
}
export interface WarningsTable {
  id: Generated<string>;
  subject_type: 'driver' | 'passenger';
  subject_id: string;
  kind: string;
  ref_type: string | null;
  ref_id: string | null;
  at: Generated<Date>;
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
  cities: CitiesTable;
  price_ranges: PriceRangesTable;
  trips: TripsTable;
  trip_stops: TripStopsTable;
  warnings: WarningsTable;
}

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 10 }) }) });
}
