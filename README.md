# JTOS

Scheduled intercity and cross-border (Jordan → Syria) trip booking.

| Part | Folder | Tech |
|---|---|---|
| Backend API | `backend/` | NestJS (TypeScript) + PostgreSQL |
| Staff console | `admin-web/` | React + TypeScript |
| Passenger & driver apps | `mobile/` | Flutter (iOS + Android) |
| Design docs | `docs/` | Database, API, decision records |

**Stage:** staging test only. No production until the legal review (Jira JTOS-439) is done.

**Source of truth for rules:** Jira project JTOS (stories T-001…T-035, labels `requirement-completed`).
**Designs:** JTOS design canvas (Claude artifact).

## Release 1 rules in one paragraph
Cash only, paid to the driver at boarding. 0% commission. Passengers request seats; the driver accepts or rejects (all or nothing); the passenger completes the booking. Each traveller pays their own section price to the final stop. Booking closes 1 h before each stop. All limits are admin settings.
