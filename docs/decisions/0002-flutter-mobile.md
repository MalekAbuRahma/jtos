# 0002 — Flutter for passenger and driver apps
Status: Proposed · 8 Nov 2026
**Decision:** One Flutter codebase in `mobile/` producing two apps (passenger, driver) via flavours. Arabic RTL + English.
**Why:** One codebase for iOS and Android; strong RTL support; already chosen in the PRD.
**Trade-off:** iOS builds need a Mac → built in the cloud (Codemagic or GitHub Actions macOS).
