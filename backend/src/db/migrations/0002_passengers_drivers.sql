-- 0002 Passengers (T-001), drivers, vehicles, documents and applications (T-002–T-004)

-- One-time codes for passengers and drivers (WhatsApp/SMS/email). Only hashes are stored.
CREATE TABLE otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience text NOT NULL,            -- passenger | driver
  purpose text NOT NULL,             -- login | signup_email | recover | change_phone
  target text NOT NULL,              -- phone (E.164) or lower-case email
  channel text NOT NULL,             -- whatsapp | sms | email
  code_hash text NOT NULL,
  context jsonb,                     -- e.g. pending sign-up details
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_target ON otp_codes (audience, target, created_at DESC);

CREATE TABLE passengers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE,
  email text NOT NULL,
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',   -- active | under_review | blocked
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX passengers_email_unique ON passengers (lower(email));

CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE,
  email text,
  full_name text,
  status text NOT NULL DEFAULT 'draft',    -- draft | submitted | approved | sent_back | rejected | suspended
  rating_avg numeric(3,2),
  rating_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Private files (staging keeps them in the database; test data only).
CREATE TABLE file_blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  sha256 text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  status text NOT NULL DEFAULT 'pending',  -- pending | active | retired | rejected
  type text NOT NULL CHECK (type IN ('car', 'van')),
  make text NOT NULL,
  model text NOT NULL,
  year int NOT NULL,
  colour text NOT NULL,
  plate text NOT NULL,
  seats int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One car per driver (T-002): at most one active and one waiting for review.
CREATE UNIQUE INDEX vehicles_one_active ON vehicles (driver_id) WHERE status = 'active';
CREATE UNIQUE INDEX vehicles_one_pending ON vehicles (driver_id) WHERE status = 'pending';

CREATE TABLE driver_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  type text NOT NULL CHECK (type IN ('licence', 'registration', 'insurance', 'face_photo', 'id_document', 'good_conduct')),
  file_id uuid NOT NULL REFERENCES file_blobs(id),
  expires_at date,
  status text NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | superseded
  review_note text,
  expiry_warned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_documents_driver ON driver_documents (driver_id, type, created_at DESC);

-- Every review item: first application, document renewal, or car change (T-003, T-004).
CREATE TABLE driver_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  kind text NOT NULL,                      -- initial | renewal | vehicle_change
  status text NOT NULL DEFAULT 'submitted',-- submitted | approved | sent_back | rejected
  document_ids uuid[] NOT NULL DEFAULT '{}',
  vehicle_id uuid REFERENCES vehicles(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES staff(id),
  note text,
  document_notes jsonb
);
CREATE INDEX driver_applications_queue ON driver_applications (status, submitted_at);

-- Outbox now also records push / WhatsApp / SMS to people (content not stored).
ALTER TABLE notifications_outbox ADD COLUMN recipient_type text, ADD COLUMN recipient_id uuid;
