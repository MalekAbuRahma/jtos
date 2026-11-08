-- 0006 Ratings, chat, share trip, live position, traveller removal (T-009/Q13, T-017, T-025, Q04)

CREATE TABLE ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  from_type text NOT NULL CHECK (from_type IN ('passenger', 'driver')),
  from_id uuid NOT NULL,
  to_type text NOT NULL,
  to_id uuid NOT NULL,
  stars int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment text,
  hidden boolean NOT NULL DEFAULT false,      -- hidden while a correction is reviewed (T-021)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, from_type)
);
CREATE INDEX ratings_to ON ratings (to_type, to_id, created_at DESC);
ALTER TABLE passengers ADD COLUMN rating_avg numeric(3,2), ADD COLUMN rating_count int NOT NULL DEFAULT 0;

-- Chat between booker and driver; numbers and links hidden. Raw text encrypted for Support only.
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  sender_type text NOT NULL CHECK (sender_type IN ('passenger', 'driver')),
  sender_id uuid NOT NULL,
  body_masked text NOT NULL,
  body_raw_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_booking ON chat_messages (booking_id, created_at);

CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Last known position, only while the trip is running (privacy: never before arrival or after completion).
ALTER TABLE trips ADD COLUMN last_lat double precision, ADD COLUMN last_lng double precision, ADD COLUMN last_position_at timestamptz;

ALTER TABLE travellers ADD COLUMN removed_at timestamptz;
