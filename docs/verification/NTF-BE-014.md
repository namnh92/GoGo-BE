# NTF-BE-014 — one application-level push switch

Refs #572. Policy, owner decisions, migration and rollback: ADR-0025 (accepted 2026-09-14). Contract `1.0.0-alpha.32`, migration `0064_notification-master-switch`.

`GET/PUT /v1/me/notification-settings` read and write `{ pushEnabled }`. One predicate (`pushAllowed`) gates the transactional outbox, the campaign estimate and the campaign send; campaigns follow the switch (owner decision). Once an account has a switch row, per-kind push rows no longer affect delivery in this release. Older clients keep working: a per-kind push opt-out turns the switch off (`source: legacy`), an opt-in never turns it on, and the per-kind GET reports every push kind as the switch. The in-app inbox is written regardless. Export carries the switch; account deletion removes it.

Migration backfill is conservative: any push opt-out → off; every push row on → on; no push rows → no row (default on). Per-kind rows are not modified by the migration.

Rollback compatibility: every write that decides push also writes the per-kind `push` rows for every kind (campaign included) in the same transaction, under a lock on the account row, so the previous release — which reads only those rows — pushes to an account exactly when this release does. Verified by evaluating the previous release's outbox and campaign predicates, copied from develop `da6a89e`, after each write; the six rollback cases failed before the fix.

Validation: lint, format:check, typecheck (8 packages), api:check, api:routes, check:boundaries, api:version and 1,587 unit tests pass. Integration (isolated PostGIS Testcontainers, one file at a time): `notification-settings.int.spec.ts` 15/15 — backfill on seeded legacy rows, default/explicit/idempotent writes, per-account isolation, strict body, hidden per-kind rows vs explicit on, legacy writes, outbox filtering with in-app row kept, campaign audience including a racing legacy write, export and deletion, and rollback: explicit off, off/on/off, legacy opt-in while off, legacy opt-out, explicit on over a leftover opt-out, racing writes. Regression: `user-providers` 20/20, `profile` 31/31, `migration-upgrade` 9/9, `cms` 233/233. The pull request records the head these ran on.

Not run: DEV deploy, device checks, real push delivery, CI (GitHub Actions billing).
