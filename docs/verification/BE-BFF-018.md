# BE-BFF-018 — latest three GoGo reviews of a place

Refs #570. Contract alpha.32 adds `GET /v1/places/{id}/reviews` (`listPlaceReviews`).

Existing API checked first: develop had create (`POST /reviews`), edit (`PATCH /reviews/{id}`) and the caller's own list (`GET /me/reviews`), and `PlaceDetail` carries only the provider rating. No public read of a place's reviews existed, so this adds one rather than widening an owner-only route.

Behaviour: at most three reviews whose status is `published`; `pending`, `rejected`, `removed` and emergency-`hidden` never appear. Ordered `created_at desc, id desc`. The response says `source: gogo` and never carries a provider number. Author is a display name only (no id, email or avatar); a deleted account's review stays with `displayName: null`. The route answers for the places Place Detail opens (`published`, `community_submitted`) and 404 otherwise. There is no server-side cache of place detail or reviews; the route is served `Cache-Control: no-store`, so a moderation change holds on the next read. Own rate-limit bucket `places.reviews`, 120/min per IP.

Policy proposals (not previously written down): display name as the only public author fact; avatars stay room-scoped as ADR-0022 describes; `createdAt` is the shown date and an edit keeps it.

Validation: 1,596 unit tests pass (9 new). `apps/api/test/place-reviews.int.spec.ts` passes 12 tests on an isolated PostgreSQL/PostGIS container: zero, one, exactly three and more than three reviews; tied timestamps; per-place isolation; 404 parity with Place Detail; publish → edit → re-publish → emergency hide over real HTTP; rejection; no id/email/avatar in the body; deleted author. Lint, format, typecheck, `api:check`, `api:routes`, `check:boundaries` and `api:version` (alpha.31 → alpha.32) pass.

Not run: DEV deploy, device acceptance, the unrelated integration suites. No migration. Deploy before Mobile APP-056 (#212). Keep the issue open until acceptance.
