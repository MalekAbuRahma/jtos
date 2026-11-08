# 0005 — Staging hosting on a simple managed platform
Status: Proposed · 8 Nov 2026
**Decision:** Staging runs on a managed platform (Render recommended; Railway alternative): API service + managed PostgreSQL + private file storage, deployed automatically from GitHub `main`.
**Why:** Minimal set-up and maintenance for a team with no developers; roughly USD 20–50/month.
**Limits:** Staging only, test data only (JTOS-115). Production hosting (e.g. AWS Bahrain) decided after the legal review (JTOS-439, data location).
