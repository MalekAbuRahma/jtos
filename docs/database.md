# JTOS — Database design (Release 1, staging)

Status: **Proposed** — owner approval needed before code.
Engine: PostgreSQL 16. All tables have `id uuid` primary key, `created_at`, `updated_at` (timestamptz, UTC).

## Conventions
- **Money:** integer **fils** (`bigint`), 1 JOD = 1000 fils. Shown as `JOD 30.000`. Never floats.
- **Time:** stored UTC (`timestamptz`), shown in Jordan time (`Asia/Amman`). Server time decides every deadline.
- **Idempotency:** every create/action from an app carries a client `action_id` (uuid). Unique index → a retry returns the first result (T-018, T-022).
- **Never delete history:** corrections, audit and cash use *append* records. Soft status changes elsewhere.
- **Sensitive data:** passport/ID numbers encrypted at column level (`bytea`, app-side AES-GCM); document files in private object storage, only keys stored here.
- **Settings snapshot:** a request stores `settings_version_id` + `terms_snapshot`; later changes never affect it (T-009 AC3, T-014).

---

## 1. Accounts and staff

### `passengers` (T-001)
| Field | Type | Notes |
|---|---|---|
| phone | text unique | E.164, e.g. +9627… |
| email | text | verified at sign-up, used for recovery |
| full_name | text | |
| status | enum | active, under_review, blocked |
| consent_documents_at | timestamptz | consent to store traveller documents (Q04) |

### `otp_codes` (T-001, T-005)
| Field | Type | Notes |
|---|---|---|
| target | text | phone or email |
| channel | enum | whatsapp, sms, email |
| code_hash | text | never store the code itself |
| expires_at | timestamptz | +5 min (setting) |
| attempts, resend_count | int | 3 resends → `locked_until` +30 min |

### `staff` (T-005–T-007)
| Field | Type | Notes |
|---|---|---|
| email | text unique | |
| full_name | text | |
| password_hash | text | argon2id |
| role | enum null | admin, support, auditor; **null = no access** |
| is_main_admin | bool | only one; created by setup script |
| status | enum | invited, active, deactivated |
| failed_logins, locked_until | | 5 wrong → 30 min lock |

### `audit_log` (T-008) — append-only
| Field | Type | Notes |
|---|---|---|
| at | timestamptz | server time |
| actor_type, actor_id | | staff / driver / passenger / system |
| action | text | e.g. `settings.changed`, `passport.viewed` |
| record_type, record_id | | |
| before, after | jsonb | when relevant |
| ip | inet | |
Database rule: `REVOKE UPDATE, DELETE` for the app role; trigger blocks changes.

## 2. Settings and prices

### `settings_versions` (T-009, T-024)
| Field | Type | Notes |
|---|---|---|
| version | int unique | increasing |
| values | jsonb | full set (see list below), validated against min/max in code |
| effective_from | timestamptz | allows scheduled commission change |
| created_by | staff id | |

Default values (8 Nov decisions): response window 15 min–24 h · waiting requests 3 · booking cutoff 1 h · WhatsApp backup 1 h · rejection warning 3 · arrival radius 300 m · waiting time 15 min · driver late 30 min · late warning 3 in 30 days · no-show warning 3 · cancellation warning after 2 · rating window 48 h · warn < 4.0 · review < 3.5 · login code 5 min / 3 resends / 30 min · documents warning 30 days · car max age 10 years · seats car 4 / van 7 · passport warning 3 months · max active trips 10 · commission 0 %.

### `cities`
`name_en`, `name_ar`, `country` (JO / SY), `lat`, `lng`.

### `price_ranges` (Q05)
| Field | Notes |
|---|---|
| from_city_id, to_city_id | a section, e.g. Irbid → Damascus |
| vehicle_type | car, van |
| min_fils, max_fils, normal_fils | admin sets |
| whole_min_fils, whole_max_fils, whole_normal_fils | whole-vehicle price |

## 3. Drivers and vehicles

### `drivers` (T-002–T-004)
| Field | Notes |
|---|---|
| phone unique, email, full_name | |
| status | draft, submitted, in_review, approved, sent_back, rejected, suspended |
| rating_avg, rating_count | average of last 50 (T-009/Q13) |
| warnings_count | cancellations, late, rejections |

### `vehicles` — one per driver (T-002)
`driver_id unique`, `make`, `model`, `year`, `colour`, `plate`, `type` (car/van), `seats`.

### `driver_documents`
| Field | Notes |
|---|---|
| driver_id, type | licence, registration, insurance, face_photo, id_card, good_conduct |
| file_key | private storage key |
| expires_at | |
| review_status, review_note | ok, sent_back |

### `driver_applications` (T-003)
`driver_id`, `status`, `submitted_at`, `decided_at`, `decided_by`, `note`. New row per (re)application — history kept.

## 4. Trips

### `trips` (T-010, T-011)
| Field | Notes |
|---|---|
| driver_id, vehicle_id | |
| status | draft, published, suspended, cancelled, running, completed |
| travel_date | |
| booking_type | seats, whole, both |
| seats_offered | ≤ vehicle seats |
| whole_price_fils | |
| response_window_min | driver picks within admin range |
| settings_version_id | |
| publish_action_id | unique → no double publish |
| suspended_reason, cancelled_reason | |

### `trip_stops`
| Field | Notes |
|---|---|
| trip_id, seq | order 1..n; last = final stop |
| city_id, spot_text | spot masked for phones/links |
| pickup_at | |
| section_price_fils | price **to the final stop** from this stop; null on final |
| last_chance_price_fils | null or lower price for new passengers only |

Seats left = `seats_offered − seats in confirmed bookings − seats in waiting requests`. Calculated inside the same transaction with `SELECT … FOR UPDATE` on the trip row (T-013).

## 5. Requests, bookings, travellers

### `booking_requests` (T-014–T-018)
| Field | Notes |
|---|---|
| trip_id, passenger_id | |
| kind | seats, whole |
| seats | adults + children (babies on lap don't take seats) |
| total_fils | server-calculated |
| terms_snapshot | jsonb: prices, total, deadline, cancellation rules |
| settings_version_id | |
| deadline_at | sent_at + driver's response window |
| status | waiting, accepted, rejected, expired, withdrawn, closed_trip_full |
| reject_reason | admin-only |
| action_id | unique per passenger |

### `bookings` (T-015, T-017, T-035)
| Field | Notes |
|---|---|
| request_id unique, trip_id, passenger_id | |
| status | awaiting_completion, confirmed, completed, no_show, cancelled |
| payment_method | cash (release 1) |
| completed_booking_at | passenger finished the booking step → **plate + chat unlocked** |
| cancelled_at, cancel_reason, counts_toward_warning | lateness / driver change → not counted |

### `travellers` (Q04, T-014, T-020)
| Field | Notes |
|---|---|
| request_id | |
| type | adult, child, baby |
| full_name, date_of_birth | |
| doc_type, doc_number_enc, doc_expiry | passport or national ID (Jordan-only trips) |
| board_stop_id, board_spot | |
| lap_of_traveller_id | baby → adult |
| price_fils | 0 for lap baby |
| responsibility_ticked | passport warning |
| contact | optional, for "booked by" message |
| boarding_status | pending, boarded, no_show |
| delete_after | trip date + 30 days → personal fields wiped |

## 6. Trip day

### `stop_events` (T-019, T-020, T-022)
`trip_id`, `stop_id`, `type` (arrived, left, completed), `at`, `lat`, `lng`, `action_id unique`, `accepted` (bool), `reject_reason`.

### `contact_attempts` (T-019)
`booking_id`, `driver_id`, `type` (call, message), `at`.

### `cash_records` (T-026)
| Field | Notes |
|---|---|
| booking_id unique | |
| due_fils, received_fils | received ≤ due |
| status | full, part, not_paid |
| at, lat, lng, action_id unique | |

### `cash_corrections` (T-028) — append-only
`cash_record_id`, `new_received_fils`, `reason`, `staff_id`, `action_id unique`.

### `service_corrections` (T-021) — append-only
`target_type`, `target_id`, `before`, `after`, `reason`, `staff_id`.

### `late_records` (T-023) / `warnings`
`subject_type` (driver/passenger), `subject_id`, `kind` (late, cancellation, no_show, rejection, non_payment, rating), `at`, `booking_id`.

## 7. Support, ratings, chat, sharing

### `cases` (T-019 dispute, T-021 request, T-027)
`type` (cash, no_show_dispute, correction_request, other), `booking_id`, `status` (open, waiting_reply, for_admin, resolved), `opened_by_type/id`, `resolution_note`.

### `case_statements`
`case_id`, `author_type/id`, `text`, `attachment_keys`. One row per side — never merged.

### `ratings` (T-009, Q13)
`booking_id`, `from_type/id`, `to_type/id`, `stars` 1–5, `hidden_for_review`. Window 48 h from completion.

### `chat_messages` (T-017)
`booking_id`, `sender_type/id`, `body_masked`, `body_raw_enc` (Support review only).

### `share_links` (T-017)
`token_hash`, `booking_id`, `expires_at` (trip end).

### `notifications_outbox`
`recipient`, `channel` (push, whatsapp, sms, email), `template`, `payload`, `status`, `send_after` (WhatsApp backup after 1 h).

## 8. Release 2 (not built now)
Settlement tables (holds, offsets, remittances, statements) for T-029–T-034 — design when online payment/commission starts.
