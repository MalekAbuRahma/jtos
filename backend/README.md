# JTOS backend (NestJS + PostgreSQL)

Built so far:
- **Foundation** — staff sign-in (T-005), roles and permissions (T-006, T-007), audit history (T-008), versioned settings (T-009, T-024 commission setting).
- **Sign-up** — passenger accounts with WhatsApp/SMS codes and email recovery (T-001); driver application, car, documents (T-002); staff review queue (T-003); renewals, car changes, expiry warnings and the publish-date rule (T-004).

- **Trips and search** — drivers draft, publish, repeat, lower the price ("Last chance") and cancel trips (T-010, T-011); passengers search cheapest first with badges and see trip details without the plate (T-012); seat/whole-vehicle capacity rules (T-013, finished together with booking requests T-014). Admin price ranges per section; staff suspend trips.

Not yet: Support moving an account to a new number (T-001 TC-10, staff tool), passenger view of car/driver (T-002 TC-11, comes with search T-012), platform-wide rate limits (SEC-001).

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

## Safety rules in code
- Permissions are checked on the server for every endpoint; the staff row is reloaded on every request, so removing a role works at once.
- The audit table refuses UPDATE/DELETE/TRUNCATE at database level.
- Settings never change in place — each change is a new version; requests will store the version they were sent with.
- Passwords: argon2id. Login codes and invitation links are stored only as hashes.
- Codes (WhatsApp/SMS/email) are 6 digits, valid 5 min, first + 3 resends then 30 min wait; only hashes stored.
- Driver documents: JPG/PNG/PDF ≤ 5 MB, kept private; only staff can open them.
- Staging sends emails and WhatsApp/SMS to the server log (`EMAIL_DRIVER=log`) — test data only. A real email provider comes before production.
