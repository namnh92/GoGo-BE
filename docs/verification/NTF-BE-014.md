# NTF-BE-014 — one application-level push switch

Refs #572. Policy, migration and rollback: ADR-0025. Contract `1.0.0-alpha.32`, migration `0064_notification-master-switch`.

`GET/PUT /v1/me/notification-settings` read and write `{ pushEnabled }`. One predicate (`pushAllowed`) gates the transactional outbox, the campaign estimate and the campaign send. Once an account has a switch row, per-kind push rows no longer affect delivery. Older clients keep working: a per-kind push opt-out turns the switch off (`source: legacy`), an opt-in never turns it on, and the per-kind GET reports every push kind as the switch. The in-app inbox is written regardless. Export carries the switch; account deletion removes it.

Migration backfill is conservative: any push opt-out → off; every push row on → on; no push rows → no row (default on). Per-kind rows are left untouched.

Validation: lint, format:check, typecheck (8 packages), api:check, api:routes, check:boundaries, api:version and 1,587 unit tests pass. Integration (isolated PostGIS Testcontainers, one file at a time): `notification-settings.int.spec.ts` 9/9 — backfill on seeded legacy rows (never chose, all on, mixed, campaign-only off, email-only off, all off), default/explicit/idempotent writes, per-account isolation, strict body, hidden per-kind rows vs explicit on, legacy writes, outbox filtering with in-app row kept, campaign audience including a racing legacy write, export and deletion. Regression: `user-providers` 20/20, `profile` 31/31, `migration-upgrade` 9/9, `cms` 233/233.

Not run: DEV deploy, device checks, real push delivery.
