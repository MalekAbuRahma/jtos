-- 0001 Foundation: staff, login codes, invitations, settings, audit, outbox
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE staff_role AS ENUM ('admin', 'support', 'auditor');
CREATE TYPE staff_status AS ENUM ('invited', 'active', 'deactivated');

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  password_hash text,
  role staff_role,                       -- NULL = no access (T-005 AC2)
  is_main_admin boolean NOT NULL DEFAULT false,
  status staff_status NOT NULL DEFAULT 'invited',
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_email_unique ON staff (lower(email));
CREATE UNIQUE INDEX staff_one_main_admin ON staff (is_main_admin) WHERE is_main_admin;

CREATE TABLE staff_login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff(id),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL UNIQUE,
  "values" jsonb NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,              -- staff | driver | passenger | system
  actor_id uuid,
  action text NOT NULL,
  record_type text,
  record_id text,
  before jsonb,
  after jsonb,
  ip text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_id, at DESC);
CREATE INDEX audit_log_record ON audit_log (record_type, record_id);

-- T-008: the audit history can never be edited or deleted.
CREATE FUNCTION audit_log_block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_changes();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_changes();

CREATE TABLE notifications_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,                 -- email | push | whatsapp | sms
  recipient text NOT NULL,
  template text NOT NULL,
  status text NOT NULL DEFAULT 'sent',
  created_at timestamptz NOT NULL DEFAULT now()
);
