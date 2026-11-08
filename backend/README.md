# JTOS backend (NestJS + PostgreSQL)

Built so far — **all Release 1 backend stories (T-001 to T-028, T-035)**:

| Area | Stories |
|---|---|
| Staff, roles, audit, settings | T-005–T-009, T-024 (commission setting, 0 %) |
| Passenger and driver accounts, driver approval, renewals, expiry | T-001–T-004 |
| Trips, publishing, search, capacity | T-010–T-013 |
| Requests, travellers, accept/reject, complete with cash, limits | T-014–T-018 |
| Trip day: arrival, waiting, boarding, no-show, offline sync, late driver | T-019–T-023 |
| Cash received, cash cases, corrections, earnings | T-025–T-028 |
| Booking page: plate after completion, chat, Share trip, ratings, cancel | T-017, T-035, Q13 |

Release 2 (not built): settlement T-029–T-034, online payment.

**Team decisions made while building (Prof approved, recorded in Jira):**
- Arrival check uses a map pin per stop (300 m). A stop without a pin is checked against the city centre (15 km).
- "I've arrived" is accepted from 2 hours before the pickup time.
- Seats are held while a request waits, so a trip can't overfill; "trip full" closing stays as a safety net.
- Share trip page shows driver first name, car, plate and live position while running — never passports or phone numbers.
- Removing a traveller: before acceptance the price drops and seats are freed; after acceptance the seat stays paid.

Still open: Support moving a passenger to a new number (T-001 TC-10), real WhatsApp/SMS/email/push providers (staging prints to the log).

## Background jobs (run inside the API)
| Job | Every |
|---|---|
| Expire requests at their deadline, release seats | 1 min |
| WhatsApp backup to drivers who didn't open a request | 5 min |
| Driver late (30 min) → tell passengers, warn driver | 1 min |
| Document expiry warnings (30 days) | 6 h |
| Delete traveller document data 30 days after the trip | 1 h |

## Run locally
```bash
cp .env.example .env            # then edit values
npm install
npm run migrate                 # creates tables
MAIN_ADMIN_EMAIL=you@example.com MAIN_ADMIN_NAME="Your Name" npm run setup:main-admin
npm run dev                     # http://localhost:3000/health
```

## Tests
`npm test` runs the automated versions of Sam's test cases against a real PostgreSQL
(`TEST_DATABASE_URL`, default `postgres://jtos:jtos@localhost:5432/jtos_test`). They also run on every push (GitHub Actions).

## Endpoints built
| Method | Path | Who |
|---|---|---|
| GET | /health | anyone |
| POST | /v1/staff/auth/login → /verify | staff (password + email code) |
| POST | /v1/staff/auth/set-password | invited staff (24 h link) |
| GET | /v1/staff/me | signed-in staff |
| GET | /v1/staff/roles | roles.view |
| GET/POST | /v1/staff/staff | view: Admin, Auditor · create: main admin |
| POST | /v1/staff/staff/:id/role, /deactivate, /resend-invitation | main admin |
| GET/PUT | /v1/staff/settings | view: all roles · change: Admin |
| GET | /v1/staff/audit, /audit/export (CSV) | Admin, Auditor |
| POST | /v1/passenger/auth/code → /verify | passenger (WhatsApp, `channel: "sms"` backup) |
| POST | /v1/passenger/auth/signup → /signup/verify-email | new passenger (name + verified email) |
| POST | /v1/passenger/auth/recover → /recover/verify | lost phone (email code) |
| GET / POST | /v1/passenger/me, /me/phone → /me/phone/verify | signed-in passenger |
| POST | /v1/driver/auth/code → /verify | driver |
| GET | /v1/driver/me | application, car, documents, checklist, warnings |
| PUT | /v1/driver/me/profile, /me/vehicle | driver (car change after approval goes to review) |
| POST | /v1/driver/me/documents (multipart: file, type, expiresAt) | driver (renewal after approval goes to review) |
| POST | /v1/driver/me/application/submit | driver |
| GET | /v1/driver/me/eligibility?date= | can a trip be published on that date (T-004) |
| GET | /v1/staff/applications?status=, /applications/:id | drivers.view |
| POST | /v1/staff/applications/:id/decision | drivers.review (Admin) |
| GET | /v1/staff/documents/:id/file | documents.view — every view audited |
| GET/POST/PUT | /v1/driver/trips, /v1/driver/trips/:id | driver (own trips only) |
| POST | /v1/driver/trips/:id/publish · /repeat · /last-chance · /cancel | driver |
| GET | /v1/public/cities, /v1/public/search?from&to&date&travellers | anyone (rate-limited) |
| GET | /v1/public/trips/:id?from=, /v1/public/drivers/:id/photo | anyone — no plate, no documents |
| GET/PUT | /v1/staff/price-ranges | view: all roles · change: Admin |
| GET | /v1/staff/trips · POST /trips/:id/suspend, /unsuspend | staff |
| POST | /v1/passenger/requests (Idempotency-Key) · GET /requests, /requests/:id · POST /requests/:id/withdraw | passenger |
| POST | /v1/passenger/requests/:id/travellers/:idx/remove | passenger |
| GET/POST | /v1/passenger/bookings, /bookings/:id, /complete, /cancel-preview, /cancel | passenger |
| POST | /v1/passenger/bookings/:id/dispute-no-show, /cash-case, /rating, /share-link · GET/POST /messages | passenger |
| GET/POST | /v1/passenger/cases, /cases/:id/statement | passenger |
| GET/POST | /v1/driver/requests, /requests/:id, /accept, /reject | driver |
| GET | /v1/driver/trips/:id/board | driver (today's list) |
| POST | /v1/driver/trips/:id/stops/:seq/arrived, /leave · /trips/:id/complete, /position | driver |
| POST | /v1/driver/travellers/:id/boarded, /no-show · /bookings/:id/contact-attempt, /cash, /cash-case, /rating | driver |
| POST | /v1/driver/sync (offline actions) · GET /v1/driver/earnings?period= · GET/POST /messages, /cases | driver |
| GET | /v1/public/share/:token | family (Share trip) |
| GET/POST | /v1/staff/cases, /cases/:id, /ask, /resolve | staff (resolve: Admin, Support) |
| POST | /v1/staff/corrections/service, /cash (Admin) · /corrections/requests (Support) | staff |
| GET | /v1/staff/bookings/:id/cash · /reports/late-drivers | staff |

## Safety rules in code
- Permissions are checked on the server for every endpoint; the staff row is reloaded on every request, so removing a role works at once.
- The audit table refuses UPDATE/DELETE/TRUNCATE at database level.
- Settings never change in place — each change is a new version; requests will store the version they were sent with.
- Passwords: argon2id. Login codes and invitation links are stored only as hashes.
- Codes (WhatsApp/SMS/email) are 6 digits, valid 5 min, first + 3 resends then 30 min wait; only hashes stored.
- Driver documents: JPG/PNG/PDF ≤ 5 MB, kept private; only staff can open them.
- Staging sends emails and WhatsApp/SMS to the server log (`EMAIL_DRIVER=log`) — test data only. A real email provider comes before production.
