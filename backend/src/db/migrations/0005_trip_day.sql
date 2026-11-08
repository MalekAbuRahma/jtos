-- 0005 Trip day: arrival, boarding, no-show, cash, offline actions, late driver, cases, corrections
-- (T-019–T-023, T-026–T-028, T-035)

ALTER TABLE trip_stops ADD COLUMN lat double precision, ADD COLUMN lng double precision,
  ADD COLUMN arrived_at timestamptz, ADD COLUMN left_at timestamptz, ADD COLUMN late_notified_at timestamptz;
ALTER TABLE trips ADD COLUMN started_at timestamptz, ADD COLUMN completed_at timestamptz;
ALTER TABLE travellers ADD COLUMN boarded_at timestamptz, ADD COLUMN no_show_at timestamptz;
ALTER TABLE warnings ADD COLUMN void boolean NOT NULL DEFAULT false, ADD COLUMN under_review boolean NOT NULL DEFAULT false;

-- Every trip-day action from the driver app, kept by action ID so a retry never repeats it (T-022).
CREATE TABLE driver_actions (
  action_id text PRIMARY KEY,
  driver_id uuid NOT NULL REFERENCES drivers(id),
  kind text NOT NULL,
  device_at timestamptz,
  lat double precision,
  lng double precision,
  status text NOT NULL,                     -- accepted | rejected
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contact_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  kind text NOT NULL CHECK (kind IN ('call', 'message')),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  due_fils bigint NOT NULL,
  received_fils bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('full', 'part', 'not_paid')),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  at timestamptz NOT NULL DEFAULT now(),
  lat double precision,
  lng double precision,
  CHECK (received_fils >= 0 AND received_fils <= due_fils)
);

CREATE TABLE cash_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_record_id uuid NOT NULL REFERENCES cash_records(id),
  old_received_fils bigint NOT NULL,
  new_received_fils bigint NOT NULL,
  reason text NOT NULL,
  staff_id uuid NOT NULL REFERENCES staff(id),
  action_id text NOT NULL UNIQUE,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traveller_id uuid NOT NULL REFERENCES travellers(id),
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  reason text NOT NULL,
  staff_id uuid NOT NULL REFERENCES staff(id),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,                -- e.g. C-1042
  type text NOT NULL,                       -- cash | no_show_dispute | correction_request | other
  booking_id uuid REFERENCES bookings(id),
  traveller_id uuid REFERENCES travellers(id),
  status text NOT NULL DEFAULT 'open',      -- open | waiting_reply | for_admin | resolved
  reason text,
  opened_by_type text NOT NULL,
  opened_by_id uuid,
  resolution_note text,
  resolved_by uuid REFERENCES staff(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE case_number START 1001;

-- Statements are kept separately for each side; never merged or edited (T-027 AC3).
CREATE TABLE case_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id),
  author_type text NOT NULL,                -- passenger | driver | staff | system
  author_id uuid,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
