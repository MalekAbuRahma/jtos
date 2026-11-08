-- 0003 Cities, price ranges, trips and stops (T-010–T-013), warnings

CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,          -- e.g. AMM
  name_en text NOT NULL,
  name_ar text NOT NULL,
  country text NOT NULL,              -- JO | SY
  lat double precision,
  lng double precision
);
INSERT INTO cities (code, name_en, name_ar, country, lat, lng) VALUES
  ('AMM', 'Amman',    'عمّان',   'JO', 31.9539, 35.9106),
  ('ZRQ', 'Zarqa',    'الزرقاء', 'JO', 32.0728, 36.0880),
  ('IRB', 'Irbid',    'إربد',    'JO', 32.5556, 35.8500),
  ('MFQ', 'Mafraq',   'المفرق',  'JO', 32.3416, 36.2020),
  ('RMT', 'Ramtha',   'الرمثا',  'JO', 32.5592, 36.0069),
  ('JRS', 'Jerash',   'جرش',     'JO', 32.2803, 35.8993),
  ('DRA', 'Daraa',    'درعا',    'SY', 32.6189, 36.1021),
  ('DAM', 'Damascus', 'دمشق',    'SY', 33.5138, 36.2765);

-- Admin price range per section and vehicle type (Q05). Money in fils.
CREATE TABLE price_ranges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_city_id uuid NOT NULL REFERENCES cities(id),
  to_city_id uuid NOT NULL REFERENCES cities(id),
  vehicle_type text NOT NULL CHECK (vehicle_type IN ('car', 'van')),
  min_fils bigint NOT NULL,
  max_fils bigint NOT NULL,
  normal_fils bigint NOT NULL,
  whole_min_fils bigint,
  whole_max_fils bigint,
  whole_normal_fils bigint,
  updated_by uuid REFERENCES staff(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_city_id, to_city_id, vehicle_type),
  CHECK (min_fils <= normal_fils AND normal_fils <= max_fils)
);
-- Staging sample ranges (sample data; Admin changes them).
INSERT INTO price_ranges (from_city_id, to_city_id, vehicle_type, min_fils, max_fils, normal_fils, whole_min_fils, whole_max_fils, whole_normal_fils)
SELECT f.id, t.id, v.vt, v.mn, v.mx, v.nm, v.wmn, v.wmx, v.wnm
FROM (VALUES
  ('AMM','DAM','car',25000,35000,30000, 90000,130000,110000),
  ('ZRQ','DAM','car',22000,32000,27000, 80000,120000,100000),
  ('MFQ','DAM','car',18000,28000,23000, 70000,110000, 90000),
  ('IRB','DAM','car',15000,25000,20000, 55000, 95000, 75000),
  ('RMT','DAM','car',12000,22000,17000, 45000, 85000, 65000),
  ('AMM','DAM','van',20000,30000,25000,130000,190000,160000),
  ('ZRQ','DAM','van',18000,28000,23000,120000,180000,150000),
  ('IRB','DAM','van',12000,22000,17000, 90000,140000,115000),
  ('AMM','IRB','car', 4000, 8000, 6000, 15000, 30000, 22000),
  ('ZRQ','IRB','car', 3500, 7000, 5000, 13000, 26000, 19000),
  ('DAM','AMM','car',25000,35000,30000, 90000,130000,110000),
  ('DRA','AMM','car',15000,25000,20000, 55000, 95000, 75000)
) AS v(f, t, vt, mn, mx, nm, wmn, wmx, wnm)
JOIN cities f ON f.code = v.f JOIN cities t ON t.code = v.t;

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  status text NOT NULL DEFAULT 'draft',      -- draft | published | suspended | cancelled | completed
  travel_date date NOT NULL,
  booking_type text NOT NULL CHECK (booking_type IN ('seats', 'whole', 'both')),
  seats_offered int NOT NULL CHECK (seats_offered > 0),
  whole_price_fils bigint,
  response_window_min int NOT NULL,
  notes text,
  settings_version_id uuid REFERENCES settings_versions(id),
  publish_action_id text UNIQUE,
  -- Capacity counters, changed only inside a transaction that locks this row (T-013).
  seats_booked int NOT NULL DEFAULT 0,
  seats_held int NOT NULL DEFAULT 0,
  whole_taken boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  suspended_reason text,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (seats_booked + seats_held <= seats_offered)
);
CREATE INDEX trips_driver ON trips (driver_id, travel_date);
CREATE INDEX trips_search ON trips (travel_date, status);

CREATE TABLE trip_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq int NOT NULL,
  city_id uuid NOT NULL REFERENCES cities(id),
  spot text NOT NULL,
  pickup_at timestamptz NOT NULL,
  section_price_fils bigint,                 -- price to the final stop; NULL on the final stop
  last_chance_price_fils bigint,             -- lower price for new passengers only
  UNIQUE (trip_id, seq)
);
CREATE INDEX trip_stops_city ON trip_stops (city_id);

-- Warnings for drivers and passengers (cancellations, late, rejections …).
CREATE TABLE warnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,                -- driver | passenger
  subject_id uuid NOT NULL,
  kind text NOT NULL,                        -- trip_cancelled | booking_cancelled | late | no_show | rejection | non_payment
  ref_type text,
  ref_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX warnings_subject ON warnings (subject_type, subject_id, kind, at DESC);
