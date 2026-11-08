-- 0004 Booking requests, travellers, bookings (T-013–T-018)

CREATE TABLE booking_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  passenger_id uuid NOT NULL REFERENCES passengers(id),
  kind text NOT NULL CHECK (kind IN ('seats', 'whole')),
  seats int NOT NULL CHECK (seats > 0),       -- seats held (whole = all offered seats)
  head_count int NOT NULL,                     -- people travelling, incl. lap babies
  board_seq int NOT NULL,                      -- where the booker's group gets on (whole: 1)
  total_fils bigint NOT NULL,
  terms_snapshot jsonb NOT NULL,               -- prices, total, deadline, cancellation rules (T-014)
  settings_version_id uuid NOT NULL REFERENCES settings_versions(id),
  deadline_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'waiting',      -- waiting | accepted | rejected | expired | withdrawn | closed_trip_full | trip_cancelled
  reject_reason text,                          -- seen by staff only
  driver_opened_at timestamptz,
  whatsapp_backup_at timestamptz,
  action_id text NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (passenger_id, action_id)
);
CREATE INDEX booking_requests_trip ON booking_requests (trip_id, status);
CREATE INDEX booking_requests_passenger ON booking_requests (passenger_id, status);
CREATE INDEX booking_requests_deadline ON booking_requests (deadline_at) WHERE status = 'waiting';

CREATE TABLE travellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES booking_requests(id),
  idx int NOT NULL,                            -- order in the request
  type text NOT NULL CHECK (type IN ('adult', 'child', 'baby')),
  full_name text,
  date_of_birth date,
  doc_type text CHECK (doc_type IN ('passport', 'national_id')),
  doc_number_enc text,                         -- AES-256-GCM, never plain text
  doc_hash text,                               -- to stop the same person booking twice on a trip
  doc_expiry date,
  responsibility_ticked boolean NOT NULL DEFAULT false,
  board_seq int NOT NULL,
  board_spot text,
  lap_of_idx int,                              -- baby on an adult's lap
  price_fils bigint NOT NULL DEFAULT 0,
  contact text,                                -- optional phone/email for the "booked by" message
  boarding_status text NOT NULL DEFAULT 'pending', -- pending | boarded | no_show
  personal_deleted_at timestamptz,
  UNIQUE (request_id, idx)
);
CREATE INDEX travellers_doc ON travellers (doc_hash);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES booking_requests(id),
  trip_id uuid NOT NULL REFERENCES trips(id),
  passenger_id uuid NOT NULL REFERENCES passengers(id),
  code text NOT NULL UNIQUE,                   -- short reference shown to people, e.g. A7K2
  status text NOT NULL DEFAULT 'awaiting_completion', -- awaiting_completion | confirmed | completed | no_show | cancelled
  payment_method text,                         -- cash (release 1)
  total_fils bigint NOT NULL,
  completed_booking_at timestamptz,            -- plate + chat unlocked (T-012/T-017)
  cancelled_at timestamptz,
  cancel_reason text,
  counts_toward_warning boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_passenger ON bookings (passenger_id, status);
CREATE INDEX bookings_trip ON bookings (trip_id, status);

ALTER TABLE passengers ADD COLUMN consent_documents_at timestamptz;
