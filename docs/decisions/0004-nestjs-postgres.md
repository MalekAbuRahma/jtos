# 0004 — NestJS (TypeScript) + PostgreSQL for the API
Status: Proposed · 8 Nov 2026
**Decision:** One NestJS API service with PostgreSQL 16. Migrations in code. Background jobs in the same service (queue table) for staging.
**Why:** Transactions and row locks for seats (T-013); integer money; append-only audit; large ecosystem.
**Trade-off:** One service = simpler now; split later only if needed.
