# 0007 — Every app action has an action ID
Status: Proposed · 8 Nov 2026
**Decision:** Every create/action from the apps sends a unique action ID. The server stores it with a unique index and returns the first result on retry. The driver app queues actions offline and syncs later.
**Why:** No double bookings, double cash records or double accepts (T-015, T-018, T-022, T-026).
