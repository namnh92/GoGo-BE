# #853 — #832 D2 validation

Authority: `dev/handoffs/sa-shape-be-832-credit-spend-D.rev2.astra.md` §3/5/6/8/9
and owner implementation brief, both 2026-11-11. Configured daily allowance is
`ASSISTANT_USER_DAILY_MAX_MESSAGES`, never a literal 3. D1 base supplied by owner:
origin/re-design 8ee29556, containing #852. No git command used to inspect/change it.

Implementation is local and uncommitted. No policy switch, flag/remote state
change, live inference, migration execution, deployment or DEV acceptance claimed.
Integration tests are written for DEV and only collected here.

## Implemented

- Migration 0100: attempt correlation, exact versioned receipt history, scrubbed
  persistent billing incidents and versioned bound artifact descriptions. 0099 is
  unchanged. No artifact, binding or activation is seeded. The existing-outbox
  index is built CONCURRENTLY by `scripts/ops/index-assistant-credit-spend.sql`
  outside the migration transaction; runtime readiness verifies its exact shape.
  Interrupted invalid remnants require an explicit concurrent drop/rebuild.
- Jev/Haiku existing adapters: committed intent and dispatch claim before fetch,
  early generation identity, exact decimal cost parsing from original JSON source,
  allowlisted receipt capture even when answer validation fails. Each explicit
  retry makes another attempt. Adapter-internal retries remain disabled.
- Atomic receipt ingest, duplicate/stale/conflict handling, usage/turn revision
  synchronization and durable outbox wakeup. Dispatch closure fences future calls;
  only unclaimed intents can be finalized at zero. All valid disputed receipt
  components remain in the journal. No provider I/O under SQL locks.
- Application settlement uses D1 primitives under the common account lock:
  sum-before-ceil targets, one base debit, revision-unique signed adjustments,
  zero-diff advancement, downward refunds, final release, no-debt quarantine,
  wallet-int32 protection, atomic audit/notification marker and post-commit counters.
- Dedicated worker consumer plus bounded indexed sweep, existing periodic
  `worker_leases` row and expiring turn CAS claims, retry/backoff and crash dedup.
  Up to four generation metadata lookups per reconciliation, unknown evidence
  first then oldest checked; no inference redispatch. Receipt failures do not
  destroy complete evidence. Cost capture continues under financial pause.
- Bound readiness requires matching exact amount/version/environment, unexpired
  unrevoked evidence, provider/models/caps/config fingerprint, pricing revision
  and bound/finality proof digests. The artifact retains its full reviewable
  configuration description as well as the matching fingerprint. Calibration alone fails. No artifact certified.
- Erasure scrubs new personal/call/queued linkage under the account lock and stops
  resurrection. Safety incidents retain scrubbed accounting identity. Conversation
  deletion keeps holds; unresolved cost survives source TTL. Self export includes
  own posted balance, holds, availability, turn facts and signed credit entries,
  paged and charged against the existing export size budget, without provider IDs.
- Bounded metrics declared and documented in infrastructure §3b; unresolved/oldest
  gauges and account/hold/free-funding violation checks are collected by the worker.

## Remaining activation evidence and justified limitations

OpenRouter's generation metadata/usage-accounting references support retrieval
and component mapping; they do not establish a whole-turn guaranteed cap, a
monotone correction version or a finality SLA. Responses are revision 1,
generation metadata revision 2, both correctable. A changed receipt at the same
version quarantines instead of inventing ordering. Trusted final receipts are
used only in deterministic fixtures. Generic settlement supports provider-proven
final revisions, but the production OpenRouter reader intentionally never marks
its metadata final. Paid admission must remain off until real per-turn
correlation/recovery, reviewed bound/finality evidence and any needed provider
capability work are accepted. Missing generation identity retains pending cost;
no account-cost allocator, TTL-zero or inference replay is substituted.

This follows the shape's implementable pending/quarantine default (§10); it does
not claim the provider activation blocker is solved. Bound artifact digests are
reviewed evidence references, not self-certifying approval. Artifact installation,
incident resolution and policy switching require the audited operational review
path and are not performed here. Existing calibrated 0.003904 is never used as B.

No public OpenAPI change: `UserExportDocument` explicitly permits unpinned sections
(`additionalProperties:true`); `assistantCreditFacts` is an allowlisted export
section. No contract bump beyond D1 10.0.0-alpha.1 is required.

RTK.md was absent from the worktree and GoGo workspace search. The shape, brief,
D1 sources/ADR/validation and requested workspace rules were read. The lean-build
skill was used to reuse the adapters/outbox/lease/account infrastructure.

## Validation commands/results

| Command                                                           | Result                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm -s typecheck`                                               | PASS: final run all 8 packages, 58.587 seconds. Earlier audit-writer/test import/mock typing errors were corrected. Turbo emits sandbox cache-write warnings; compilation proceeds.                                      |
| Focused unit command below                                        | PASS: 673 tests / 41 files. Earlier run found two telemetry emitter/documentation omissions, corrected; subsequent runs passed. Includes exact decimal/generated revision properties and existing assistant regressions. |
| Final changed-service/worker/schema/metric follow-up              | PASS: final widened follow-up 80 tests / 11 files, including provider, artifact readiness, worker, settlement and index checks.                                                                                          |
| `pnpm exec prettier --write --ignore-unknown <changed files>`     | PASS; SQL has no configured parser and is skipped.                                                                                                                                                                       |
| `pnpm exec eslint <changed .ts files>`                            | PASS, no diagnostics after correcting an unnecessary quote escape in a test.                                                                                                                                             |
| `pnpm -s vitest list --project integration <three D specs below>` | PASS, 35 scenarios collected (19 new D2, 16 D1). Hooks and PostgreSQL scenarios NOT RUN.                                                                                                                                 |
| `api:check`                                                       | Not applicable: no contract files changed.                                                                                                                                                                               |

Focused unit invocation:

```sh
pnpm -s vitest run --project unit --maxWorkers=2 libs/providers/src/assistant-billing.spec.ts libs/providers/src/openrouter-assistant-llm.adapter.spec.ts libs/providers/src/openrouter-decisions.adapter.spec.ts libs/modules/assistant libs/modules/shared/assistant-credit-bound.spec.ts libs/modules/shared/assistant-credit-readiness.spec.ts libs/modules/shared/credit-erasure.spec.ts libs/observability/src/metric-labels.spec.ts libs/database/src/assistant-credit-spend-migration.spec.ts apps/api/src/config/env.spec.ts libs/modules/notifications/application/outbox-dispatcher.spec.ts apps/worker/src/privacy-export.spec.ts apps/worker/src/assistant-credit-settlement.spec.ts
```

Post-edit focused follow-up:

```sh
pnpm -s vitest run --project unit --maxWorkers=2 libs/providers/src/assistant-billing.spec.ts libs/providers/src/openrouter-assistant-llm.adapter.spec.ts libs/providers/src/openrouter-decisions.adapter.spec.ts libs/modules/assistant/application/assistant-credit-settlement.service.spec.ts apps/worker/src/assistant-credit-settlement.spec.ts libs/database/src/assistant-credit-spend-migration.spec.ts libs/observability/src/metric-labels.spec.ts libs/modules/shared/assistant-credit-readiness.spec.ts libs/modules/assistant/infrastructure/assistant-credit-spend.repository.spec.ts libs/modules/shared/assistant-credit-bound.spec.ts libs/modules/assistant/application/assistant-credit-admission.spec.ts
```

No FAIL-before billing/provenance run against the base, exact-head CI, independent
review, migration execution or DEV acceptance is claimed. Financial tests on fakes
prove deterministic behavior only; PG crash/concurrency evidence remains for DEV.

DEV execution required (NOT RUN here):

```sh
pnpm -s vitest run --project integration apps/api/test/assistant-credit-settlement.int.spec.ts apps/api/test/assistant-credit-spend-admission.int.spec.ts apps/api/test/assistant-credit-spend-migration.int.spec.ts
```

D06 tests cover R20→12→14→10, duplicates/reordering, zero↔positive and return to an
earlier target, refund-to-zero then positive, final release/late refund, pre-commit
rollback and post-commit/no-ACK replay, bound/finality/invalid/overflow/conflict
quarantine, pause and lost-wakeup sweep. D07 uses the existing adapter with fakes
for pre-claim and ambiguous dispatch, stopped fencing, billable failures/retries,
receipt-before-write crash and retrieval failure/recovery, on free and paid paths.
D11 covers erasure racing settlement, late receipt/no resurrection, incident
retention, conversation deletion, unresolved >400-day retention and own export.
No fake result is live billing provenance or provider-finality acceptance.

## Changed files

- `apps/api/src/config/env.ts`
- `apps/api/test/assistant-credit-spend-admission.int.spec.ts`
- `apps/api/test/assistant-credit-settlement.int.spec.ts`
- `apps/worker/src/assistant-credit-settlement.ts`
- `apps/worker/src/assistant-credit-settlement.spec.ts`
- `apps/worker/src/main.ts`
- `libs/database/src/schema/assistant.ts`
- `libs/database/src/schema/platform.ts`
- `libs/database/src/assistant-credit-spend-migration.spec.ts`
- `scripts/ops/index-assistant-credit-spend.sql`
- `libs/modules/assistant/application/assistant.config.ts`
- `libs/modules/assistant/application/assistant-availability.service.ts`
- `libs/modules/assistant/application/assistant-credit-admission.spec.ts`
- `libs/modules/assistant/application/assistant-credit-settlement.service.ts`
- `libs/modules/assistant/application/assistant-credit-settlement.service.spec.ts`
- `libs/modules/assistant/application/assistant-orchestrator.service.ts`
- `libs/modules/assistant/application/assistant-turn-runner.service.ts`
- `libs/modules/assistant/application/assistant-privacy.ts`
- `libs/modules/assistant/application/turn-state.ts`
- `libs/modules/assistant/infrastructure/assistant-credit-spend.repository.ts`
- `libs/modules/assistant/infrastructure/assistant-usage-evidence.repository.ts`
- `libs/modules/assistant/infrastructure/assistant.repository.ts`
- `libs/modules/assistant/presentation/assistant.module.ts`
- `libs/modules/notifications/application/outbox-dispatcher.ts`
- `libs/modules/reviews/application/user-export.ts`
- `libs/modules/shared/assistant-credit-bound.ts`
- `libs/modules/shared/assistant-credit-bound.spec.ts`
- `libs/modules/shared/assistant-credit-readiness.ts`
- `libs/modules/src/index.ts`
- `libs/observability/src/metric-labels.ts`
- `libs/providers/src/assistant-billing.ts`
- `libs/providers/src/assistant-billing.spec.ts`
- `libs/providers/src/assistant-llm.port.ts`
- `libs/providers/src/openrouter-assistant-llm.adapter.ts`
- `libs/providers/src/openrouter-decisions.adapter.ts`
- `libs/providers/src/index.ts`
- `migrations/0100_assistant-credit-settlement.sql`
- `migrations/meta/_journal.json`
- `docs/adr/0054-assistant-actual-cost-credit-funding.md`
- `docs/infrastructure.md`
- `docs/plans/853-D2-validation.md`
