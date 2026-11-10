# GoGo-BE #829 — credit events slices

Authority: `dev/handoffs/sa-shape-credit-events.fable.md`, read in full,
including Astra-CE-01/02/03 (2026-11-10). Those amendments override the
historical cutoff, lock-order, seeding and flag-ownership passages.

## S1 — platform prerequisites (this change)

- Migration 0097: short, DDL-only transaction, `lock_timeout = 5s`;
  singleton `credit_cutover` initially sync / epoch 0 / no first activation;
  nullable `reviews.credit_epoch` and `first_published_at`. No ledger scan,
  catalogue, seed rules, constraint replacement or eligibility backfill.
- Review creation reads cutover FOR SHARE before account/domain locks and
  stores the creation epoch only after first activation. Publication locks
  and revalidates the discovered author/target, atomically writes status,
  once-only publication stamp, audit and versioned `review.published` event.
- `writeOutbox` accepts an explicit payload schema version (default 1).
  Submission decisions publish v2 facts plus evidence-approved events on
  approve/merge with approved evidence. Keep the existing synchronous grant
  formula, ledger and grant path unchanged.
- Completion discovers accounts, locks them in UUID order before the room,
  revalidates cohort under the room FOR UPDATE lock, retries discovery on a
  new account, snapshots facts and emits `room.completed` atomically. Join,
  removal and guest claim serialize through the room FOR SHARE lock.
- Every stored credit recipient is active under its held account lock;
  erasure scrubs recipient fields from all four allowlisted event types.
- Register `credit_events.enabled`, default off, as the future evaluator
  pause switch. It does not select grant ownership. S1 cannot activate:
  operators must leave cutover sync until S2–S4 readiness is established.
- Supply a bounded, resumable ops script for positively audited historical
  publication stamps; never fabricate stamps or review eligibility. Legacy ledger attribution
  belongs to S2 when the necessary schema and stable seeds exist.
- Keep public OpenAPI at 9.1.0-alpha.1; document additive internal events.
- Prove S1 regressions FAIL-before / PASS-after; run typecheck, lint, full
  unit suite. Record required Testcontainers integration specs for Claude.

## S2 — catalogue, ledger and evaluator, flag off

- Short DDL creates catalogue, entitlements, evaluations and ledger columns;
  replacement CHECKs NOT VALID accept precisely the authoritative row shapes.
  Install stable-ID rules +50 submission, +10 evidence, +5 review in this DDL.
- Check complete seed definitions, schema and required valid indexes before
  serving compatible writer traffic. Build existing-table indexes
  CONCURRENTLY outside the DDL transaction.
- Implement versioned trigger decoders, quarantine, payload-only predicates,
  supported audiences/scopes, business entitlement keys, all-or-none group
  budgets and atomic grant+ack. Preserve unpaid and quarantined outbox rows.
- Upgrade sync grants to rule → account → domain locking and 50+10 component
  entitlements; reconcile a conflicting legacy row before paying anything.
  Extend erasure to entitlement and ledger key copies using one tombstone map.
- Implement bounded, separately committed legacy attribution batches with
  stable business keys and unchanged historical deltas. Reconcile after old
  writers drain; validate constraints post-commit. Evaluator remains paused.

## S3 — contract and CMS

- One public MAJOR: 10.0.0-alpha.1, regenerated types, pinned contract diff
  exceptions and ADR-0054. Tolerant CMS readers deploy before BE MAJOR.
- Catalogue/trigger endpoints, super-admin mutations and subject-key lookup;
  open event-key credit history and catalogue-derived submission previews.
- Repeatable-read dry-run over ordered events with simulated entitlements,
  caps, budgets and closure; label its snapshot result as an estimate.

## S4 — enablement runbook

- Fence/drain every old mutation writer; no unfenced rollback binary returns.
  Reconcile legacy rows until remaining=0; verify seed definitions, valid
  indexes, validated constraints, compatible producers/decoders and erasure.
- Activation under cutover write lock changes mode, increments epoch and sets
  first_activated_at once using DB time. Review epochs remain immutable.
- Resume evaluator separately with credit_events.enabled; pause retains all
  evaluator-owned work. Ownership rollback to sync affects new events only;
  pending evaluator work survives rollback/resume. Include operational
  metrics, alerts, quarantine recovery, retention and rollback evidence.
- Require migration forward test, Testcontainers concurrency scenarios,
  CODEOWNER and the shape's domain/privacy/platform and independent reviews
  before activation. S1 provides no deployment or enablement acceptance.
