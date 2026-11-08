# JTOS backend (NestJS + PostgreSQL)

Built so far: **foundation** — staff sign-in (T-005), roles and permissions (T-006, T-007), audit history (T-008), versioned settings (T-009, T-024 commission setting).

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

## Safety rules in code
- Permissions are checked on the server for every endpoint; the staff row is reloaded on every request, so removing a role works at once.
- The audit table refuses UPDATE/DELETE/TRUNCATE at database level.
- Settings never change in place — each change is a new version; requests will store the version they were sent with.
- Passwords: argon2id. Login codes and invitation links are stored only as hashes.
- Staging sends emails to the server log (`EMAIL_DRIVER=log`) — test data only. A real email provider comes before production.
