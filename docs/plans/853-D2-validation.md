# #853 — #832 D2 validation

Authority: `dev/handoffs/sa-shape-be-832-credit-spend-D.rev2.astra.md` §3/5/6/8/9
and owner implementation brief, both 2026-11-11. Configured daily allowance is
`ASSISTANT_USER_DAILY_MAX_MESSAGES`, never a literal 3. D1 base supplied by owner:
origin/re-design 8ee29556, containing #852. No git command used to inspect/change it.

Policy A edits are local; no git commands were used. No policy switch, flag/remote state
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
  Policy A replaces repeated lookups with at most five GETs total per paid usage,
  shared by all its unknown calls, with durable claims and the named backoff/window
  constants. Known-cost and free turns never GET. Receipt failures consume a
  claim; no inference redispatch. Cost capture continues under financial pause.
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

Owner decision 2026-11-11 “phương án A” supersedes the shape's no-finality
fallback for inline receipts and accepts post-final upward losses. Inline receipts
are final at ingestion (`inline_receipt_v1`); recovered missing cost is final
under `recovered_receipt_v1`. Existing complete evidence is promoted per usage
(`recorded_receipt_v1`) without GET. All calls final plus closed dispatch permits
atomic latest debit/refund and residual hold release through existing settlement.
Full provider components/receipt history remain independent of billable cost,
which can only decrease after finality. Upward observations emit a Cost Center
counter and audit record; normal-path downward revisions can refund.

Missing paid cost alone can GET: five attempts total per usage, initially at 5m
then 15m/1h/4h/12h delays after prior claims, within 24h of acceptance. Counts
survive failures, aborts, redelivery, overlap and restarts. At 24h unknown cost
(including no generation ID) retains the hold, quarantines, records an incident,
blocks new paid admission and emits metric plus static Sentry error. Free cost
uses inline/normal-path evidence only, never GET or credit retries. Finished,
free and quarantined turns receive `next_reconcile_at=null`.

Additive migration 0101 adds finality/billable-cost and usage recovery fields plus
`receipt_missing`; 0099/0100 remain unchanged. Apply it before compatible writers,
then run the existing ops validation phase. There is no historical table-wide
UPDATE. Rollback keeps these fields and recovery counters, disables paid
admission and drains accepted work with compatible code; never resume infinite
polling or clear holds. Bound certification, activation and DEV acceptance remain
separate. No artifact is certified, no paid policy enabled, no live provider GET
or inference performed. Existing calibrated 0.003904 is never used as B.

No public OpenAPI change: `UserExportDocument` explicitly permits unpinned sections
(`additionalProperties:true`); `assistantCreditFacts` is an allowlisted export
section. No contract bump beyond D1 10.0.0-alpha.1 is required.

RTK.md was absent from the worktree and GoGo workspace search. The shape, brief,
D1 sources/ADR/validation and requested workspace rules were read. The lean-build
skill was used to reuse the adapters/outbox/lease/account infrastructure.

## Earlier D2 validation (before this policy A patch)

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

## Policy A validation — 2026-11-11 (current patch)

- FAIL before: the added complete-call regression observed **12 GETs in 12
  reconciliations** for each tested funding source. Worker regression retained
  `interval '1 hour'` in its completion update. Three assertions failed for the
  intended old behavior before implementation.
- PASS after: zero GETs for known inline cost; unknown paid usage stays within
  five GETs across repeated eligible ticks; final results below.
- Unit proof includes service/claim orchestration with mocked SQL and 1/7/31/123 extra
  eligible ticks and multiple call indexes (exactly five GETs), generated policy
  sequences (100 seeds, 300 ticks plus restart/due-time resets each), inline and
  recovered finality, immutable finality on correction, expiry incident/metric,
  capped billable cost, post-final debit suppression and Sentry scope isolation.
- PostgreSQL integration scenarios cover concurrent claims across nine unknown
  calls, free missing cost, 24h expiry with/without identity, inline finality,
  finished scheduling, corrections before/after first settlement and refunds.
  **NOT RUN**: Docker socket access is denied in this sandbox. Collection alone
  is not PostgreSQL/transaction/concurrency validation or migration execution.
- Remote alert routing/delivery and DEV acceptance: **NOT RUN**.

| Current patch check                              | Result                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -s typecheck`                              | PASS: 8/8 packages, 30.057s. Turbo cache-write warnings are sandbox restrictions; compilation succeeds.                          |
| Focused unit command below                       | PASS: 600 tests / 42 files, 24.18s. Includes generated budget sequences and the same-version post-final upward observation case. |
| ESLint on all 21 changed TypeScript files        | PASS, no diagnostics.                                                                                                            |
| Prettier check on all 25 supported changed files | PASS. SQL has no configured formatter/parser.                                                                                    |
| Integration spec collection                      | PASS: 29 cases collected in `assistant-credit-settlement.int.spec.ts`; hooks/SQL/concurrency NOT RUN.                            |
| PostgreSQL migrations and integration execution  | NOT RUN: `docker info` fails with permission denied on the Docker socket.                                                        |
| Live provider/alert/DEV acceptance               | NOT RUN.                                                                                                                         |

```sh
pnpm -s vitest run --project unit --maxWorkers=2 libs/modules/assistant libs/modules/shared/assistant-credit-bound.spec.ts libs/modules/shared/assistant-credit-readiness.spec.ts libs/modules/shared/credit-erasure.spec.ts libs/providers/src/assistant-billing.spec.ts libs/providers/src/openrouter-assistant-llm.adapter.spec.ts libs/providers/src/openrouter-decisions.adapter.spec.ts libs/database/src/assistant-credit-spend-migration.spec.ts libs/observability/src/metric-labels.spec.ts libs/observability/src/sentry.spec.ts apps/api/src/sentry-usage.spec.ts apps/worker/src/assistant-credit-settlement.spec.ts
```

Policy A adds `migrations/0101_assistant-receipt-finality.sql`,
`libs/modules/assistant/domain/receipt-recovery.ts` and its property spec,
`assistant-usage-evidence.repository.spec.ts`, Sentry alert and boundary tests,
and updates the schema/readiness/ops validation and existing settlement tests.
Deferred CHECK validation stays outside the short additive migration. No git
command, deployment, migration execution, remote write or policy switch was used.

## PR #858 — Astra round 1 repairs (2026-11-11)

Scope: the five supplied findings on owner-identified head
`8c72b276d9854e03d7c2fc291e267f046ded4b42`. No git commands were used to
verify or change that identity. Production files were copied to
`/tmp/be858-astra-r1-before/` before editing. The final F-03/F-05 pre-fix run
restored those original files temporarily with the final unit regressions,
then restored the fixes in a `finally` block. No dependencies were installed.
Policy A remains as decided on 2026-11-11: final known receipts, bounded
missing-paid-cost recovery, no free GET, no post-final upward user debit,
and normal-path downward refunds. No OpenAPI/schema/migration change.

| Finding | Change and regression                                                                                                                                                                                                                                                                                                                                                                                                              | FAIL-before evidence                                                                                                                                                                                            | After-fix evidence                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| F-01 P1 | Retention excludes settled paid usages with unapplied revisions. Recheck eligibility and ownership, scrub correlations and delete in one transaction under the ingestion account lock. Test retains a 401-day-old 12→10 correction until refund application, then permits purge; a second Testcontainers test probes the account lock while scrub is held before delete.                                                           | DB assertions **BLOCKED**: Testcontainers setup failed before any scenario. Code inspection showed the old state-only predicate and separate autocommit scrub/delete. This is not a reproduced product failure. | DB execution required in DEV; collection/typecheck only here.                                                    |
| F-02 P2 | Worker completion takes account → turn → outbox locks and rechecks the subject; erasure captures turn usage IDs before clearing linkage and scrubs outbox after turn update. Barrier test pauses worker after its turn write, starts erasure, observes its PG lock wait, then releases completion. Both must commit and queued linkage must stay scrubbed.                                                                         | DB assertions **BLOCKED** by container setup. On the original code the arranged turn/outbox overlap is expected to deadlock; that expectation has not been executed here.                                       | DB execution required in DEV; existing worker ACK/backoff/lease unit cases pass with account identity discovery. |
| F-03 P2 | Remember successfully persisted generation IDs per streaming attempt. First ID still commits before text; 80 text chunks plus final receipt share one ID, then a second call persists again.                                                                                                                                                                                                                                       | **FAIL**: expected one generation persistence, received **81**.                                                                                                                                                 | **PASS**: one write per attempt, first-ID gate and final receipt both checked.                                   |
| F-04 P2 | Split pending/reconciling discovery from settled due-marker scanning using the existing `(state,next_reconcile_at)` index; settled NULL history never enters the usage check. No correlated usage checks remain. Test seeds 5,000 finished usage/turn pairs, checks EXPLAIN ANALYZE rows examined across both tables <100, discovers a reservation without enqueue, and refunds a settled revision after losing its outbox wakeup. | DB assertions **BLOCKED** by container setup. The original sweep included settled NULL schedules and per-row usage probes; its plan has not been measured here.                                                 | DB execution required in DEV; worker unit checks cover the new query and existing recovery scheduling.           |
| F-05 P2 | Release amount and latency emit only when financial finality changes from false to true. A post-final 12→10 correction emits two refunded credits, no released credits, no new latency sample; initial finalization still releases eight and samples once.                                                                                                                                                                         | **FAIL**: late refund also emitted `assistant_credit_released_total({},2)` and one `assistant_credit_settlement_latency_seconds` sample.                                                                        | **PASS** for both late correction and initial-finality cases.                                                    |

Pre-fix evidence logs (local, not committed):

- `/tmp/be858-astra-r1-unit-before-final.log`: 2 failing tests / 19 passing;
  F-05 reports both release and latency failures.
- `/tmp/be858-astra-r1-integration-before.log`: selected F-01/F-02/F-04
  Testcontainers run stopped in `creditDatabase()` with
  `Could not find a working container runtime strategy`; all 33 cases skipped.
- `docker info --format '{{.ServerVersion}}'`: permission denied connecting to
  `/Users/maxnguyen/.docker/run/docker.sock`.

Current local gates: focused unit **31/31 PASS**, typecheck **8/8 packages PASS**
(26.733s; sandbox Turbo cache warnings), ESLint **PASS** on all 10 changed TS files.

| Final gate                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused units (adapter, spend repository, worker, erasure seam) | PASS: 31/31 across four files.                                                                                                                                                                                                                                                                                                                                                               |
| Full `pnpm -s vitest run --project unit --maxWorkers=2`         | 4,155 PASS, one test skipped because its unchanged suite setup failed with `listen EPERM: operation not permitted 127.0.0.1` (`apps/api/src/sentry-request.spec.ts`). 323 files PASS, one suite BLOCKED by the sandbox; 102.19s. The supplied 4,153-test baseline plus three new unit cases totals 4,156. Full green baseline is not claimed. Log: `/tmp/be858-astra-r1-unit-all-final.log`. |
| Typecheck                                                       | PASS: all eight packages (26.733s); API typecheck also passed after final restoration of the integration spec.                                                                                                                                                                                                                                                                               |
| ESLint / Prettier                                               | PASS on the ten changed TS / thirteen supported changed files.                                                                                                                                                                                                                                                                                                                               |
| Integration collection                                          | PASS: 33 settlement + 10 admission + 6 migration = 49 D1/D2 cases, including all four new DB regressions. Whole project inventory: 2,387 cases. No integration hooks or SQL assertions ran during collection.                                                                                                                                                                                |
| Integration execution                                           | BLOCKED by Docker socket permission/runtime setup. The supplied 315-case integration baseline cannot be verified here; DEV must run its original scope and the new regressions.                                                                                                                                                                                                              |

The existing erasure seam test also checks that multiple preserved usage IDs
become separate SQL parameters and are scrubbed after the turn update. This
checks Drizzle parameter construction; it does not replace the DB overlap test.

DEV must obtain actual FAIL-before/PASS-after for the DB cases, using the same
new tests with the original and repaired production files. Collection is not
SQL, retention, locking, migration or performance acceptance. In the original
production version, the F-01 refund case should lose its source usage, the F-01
lock probe should acquire the unheld account lock, F-02 should reject one of the
overlapping transactions, and F-04 should examine the seeded settled history.

```sh
# Focus the four new DB regressions (F-01 has two cases).
pnpm -s vitest run --project integration apps/api/test/assistant-credit-settlement.int.spec.ts -t '#858 Astra round 1 DB regressions'
# Run all D1/D2 funding, settlement, privacy, policy-A, and migration regressions.
pnpm -s vitest run --project integration apps/api/test/assistant-credit-settlement.int.spec.ts apps/api/test/assistant-credit-spend-admission.int.spec.ts apps/api/test/assistant-credit-spend-migration.int.spec.ts
# Recheck the sandbox-blocked real-HTTP unit test with listen permission.
pnpm -s vitest run --project unit apps/api/src/sentry-request.spec.ts
# Recheck the supplied 315-integration baseline in the DEV role's baseline scope.
pnpm -s test:integration
```

The new tests reside in `assistant-credit-settlement.int.spec.ts` under
`#858 Astra round 1 DB regressions`, with IDs F-01/F-02/F-04 in their names.
The integration baseline remains **unverified here** and is not waived. DEV acceptance and exact-head CI/review remain separate.

Collection-command recovery: `vitest list --json <spec>` consumed the spec
path as the JSON output destination. The overwritten spec was restored from the
provided commit using the read-only GitHub file API (blob
`8dfc5d5d661207d8295a3882362c07350e64a8a2`), then the four regressions were
reapplied. A prefix comparison confirms that all original test source is
unchanged except the added imports. Final API typecheck, ESLint and formatting
passed. Corrected collection uses
`--json=/tmp/be858-astra-r1-d2-collected.json`, collected all 49 cases including
the four regressions, and verifies the source SHA-256 before/after. Final suite
backup: `/tmp/be858-astra-r1-integration-final.ts`. No git command was used.
