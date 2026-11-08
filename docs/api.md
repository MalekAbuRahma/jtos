# JTOS — API list (Release 1, staging)

Status: **Proposed**. REST + JSON, base path `/v1`. Three audiences with separate login tokens:
`/passenger/*`, `/driver/*`, `/staff/*`, plus public `/public/*`.

Rules for every endpoint:
- Permission checked on the server (SEC-001). Own records only for passengers and drivers.
- Writes accept an `Idempotency-Key` header (= client `action_id`).
- Money in fils; times ISO-8601 UTC.
- Errors: `{ "code": "WAITING_LIMIT", "message": "You already have 3 waiting requests…" }`, plain words, never other users' data.
- Rate limits on login, search, requests (SEC-001).

## Auth
| Method | Path | Story |
|---|---|---|
| POST | /passenger/auth/code | send WhatsApp code (SMS backup) | T-001 |
| POST | /passenger/auth/verify | verify code → token | T-001 |
| POST | /passenger/auth/recover-email | email code for lost phone | T-001 |
| POST | /passenger/me/phone | change phone (verified) | T-001 |
| POST | /driver/auth/code, /driver/auth/verify | same flow for drivers | T-002 |
| POST | /staff/auth/login | email + password → email code | T-005 |
| POST | /staff/auth/verify | email code → token | T-005 |
| POST | /staff/auth/set-password | invitation link (24 h) | T-005 |

## Public (no login)
| GET | /public/search?from&to&date&travellers | cheapest first, open at your stop | T-012 |
| GET | /public/trips/:id | stops, prices, car, driver — no plate | T-012 |
| GET | /public/share/:token | Share-trip page | T-017 |

## Driver app
| Method | Path | Story |
|---|---|---|
| GET/PUT | /driver/me/application | details, vehicle | T-002 |
| POST | /driver/me/documents | upload (signed URL) | T-002 |
| POST | /driver/me/application/submit | | T-002/T-003 |
| GET/POST | /driver/trips | list / create draft | T-010 |
| PUT | /driver/trips/:id | edit draft (locked after first booking) | T-010/T-011 |
| POST | /driver/trips/:id/repeat | copy to new date | T-010 |
| POST | /driver/trips/:id/publish | server checks | T-011 |
| POST | /driver/trips/:id/last-chance | lower price of seats left | T-011 |
| POST | /driver/trips/:id/cancel | | T-011 |
| GET | /driver/requests/:id | full request incl. travellers' passports | T-015 |
| POST | /driver/requests/:id/accept | | T-015 |
| POST | /driver/requests/:id/reject | reason required | T-015/T-016 |
| POST | /driver/trips/:id/stops/:stopId/arrived | GPS ≤ 300 m | T-019 |
| POST | /driver/bookings/:id/contact-attempt | call/message logged | T-019 |
| POST | /driver/travellers/:id/boarded | | T-020 |
| POST | /driver/travellers/:id/no-show | after wait + contact attempt | T-019 |
| POST | /driver/bookings/:id/cash | full / part / not_paid | T-026 |
| POST | /driver/trips/:id/stops/:stopId/leave | blocked while anyone unmarked | T-020 |
| POST | /driver/trips/:id/complete | | T-020 |
| POST | /driver/sync | batch of offline actions | T-022 |
| GET | /driver/earnings?period | | T-025 |

## Passenger app
| Method | Path | Story |
|---|---|---|
| POST | /passenger/requests | travellers, stops, server total | T-014/T-018 |
| GET | /passenger/requests | my requests | T-014 |
| POST | /passenger/requests/:id/withdraw | free | T-016 |
| POST | /passenger/bookings/:id/complete | choose cash → unlock plate + chat | T-015 |
| GET | /passenger/bookings/:id | booking page | T-017 |
| POST | /passenger/bookings/:id/cancel | free, warning after 2 | T-035/T-023 |
| POST | /passenger/bookings/:id/share-link | | T-017 |
| POST | /passenger/bookings/:id/dispute-no-show | within 48 h | T-019 |
| POST | /passenger/bookings/:id/cash-case | within 48 h | T-027 |
| POST | /{passenger,driver}/bookings/:id/rating | 48 h window | T-009 |
| GET/POST | /{passenger,driver}/bookings/:id/messages | numbers masked | T-017 |

## Staff console
| Method | Path | Permission | Story |
|---|---|---|---|
| GET/POST | /staff/staff | staff.manage (main admin) | T-005 |
| POST | /staff/staff/:id/role | staff.manage | T-007 |
| POST | /staff/staff/:id/deactivate | staff.manage | T-005 |
| GET | /staff/roles | any | T-006 |
| GET | /staff/applications?status | drivers.view | T-003 |
| GET | /staff/applications/:id | drivers.view (views audited) | T-003 |
| POST | /staff/applications/:id/decision | drivers.review | T-003 |
| GET/PUT | /staff/settings | settings.edit for PUT | T-009/T-024 |
| GET/PUT | /staff/price-ranges | settings.edit | Q05 |
| POST | /staff/trips/:id/suspend | trips.suspend | T-011 |
| GET | /staff/bookings/:id | bookings.view | — |
| GET | /staff/travellers/:id/document | documents.view (audited) | T-006 |
| GET/POST | /staff/cases, /staff/cases/:id/* | cases.handle | T-019/T-027 |
| POST | /staff/corrections/service | records.correct (Admin) | T-021 |
| POST | /staff/corrections/cash | cash.correct (Admin) | T-028 |
| GET | /staff/audit?filters, /staff/audit/export | audit.view | T-008 |
| GET | /staff/reports/late-drivers | reports.view | T-023 |

## Background jobs
| Job | Story |
|---|---|
| Expire requests at deadline, release holds | T-016 |
| WhatsApp backup if push unopened after 1 h | T-015 |
| Mark "driver late" at pickup + 30 min | T-023 |
| Document expiry warnings (30 days) | T-004 |
| Wipe traveller personal data 30 days after trip | Q04 |
| Close rating windows after 48 h | T-009 |
