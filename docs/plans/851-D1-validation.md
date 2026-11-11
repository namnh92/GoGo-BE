# #851 / #832 D1 implementation and validation

Date: 2026-11-11. Local implementation only; not committed, deployed or activated.
No git commands were executed. No provider was called for this task.
The initial worktree OpenAPI (9.5.0-alpha.1) was saved before editing at
`/tmp/be851-base-openapi.yaml` for the version gate, without invoking git.

## Completed scope

- Successor 0099, Drizzle metadata/journal: legacy/epoch-zero spend control,
  immutable turn funding and holds, nullable usage billing metadata, lossless
  per-call storage for D2, revised NOT VALID ledger CHECK, reserved catalogue keys.
  Migration 0098 is unchanged. Concurrent ledger index and definition/readiness
  checks are separate from the migration. API readiness, worker startup and send
  admission check compatible storage. Test bootstraps include the ops index phase.
- Replay-first admission, control -> account -> budget -> user/conversation locks,
  one DB acceptance timestamp after locks, configured VN daily free allowance,
  atomic free record or paid reservation. Free never creates a wallet/debit.
  Legacy still uses daily then exactly one credit until an audited switch.
  Exhausted D free allowance fails 503 when paid funding is unavailable and 409
  with exact typed details when verified required funding exceeds available credit.
- Exact string-decimal sum-before-ceil, checked int32 arithmetic, reservation,
  complete revision/refund/final release primitives under the shared account lock,
  revision deduplication, zero-diff advancement, same-revision final release,
  no-debt quarantine, financial audit, settlement pause and no-dispatch release.
  Refund rejects an upward target. No worker/outbox or provider cost producer.
  Runner checks frozen funding, fences later call attempts and releases only
  proven no-dispatch funding; ambiguous/orphaned work does not release by TTL.
- Required status, held/available wallet facts, assistant-message credit facts and
  full-conversation projections across create/get/list/rename/accept/replay/pages.
  Unknown historical attribution stays null/unavailable. Safe JSON quantities.
  Typed allowlisted insufficient-credit error details; signed/open CMS history.
- MAJOR 10.0.0-alpha.1, generated types, changelog, every current version-pin spec;
  independent spend=false and settlement=true flags and exact bound configuration
  validation. ADR-0054, predecessor pointers, S3 release ownership correction,
  admission metric registration and infrastructure documentation.
- Audited ops-only policy switch supplied, not executed. It requires an active
  super-admin and audit evidence, records only an actual transition and leaves
  bound_version NULL. Flags/configuration alone cannot enable paid admission.

## Deliberately left to DEV / D2

DEV must run the named Testcontainers specs (Docker is unavailable here), review
migration SQL on PostgreSQL, reconcile/validate deployment state and perform any
later rollout/consumer acceptance. Collection is not PostgreSQL execution.
No baseline FAIL-before execution or exact-head CI/DEV acceptance is claimed.

D2 supplies real recoverable per-call cost capture, the settlement service/worker,
outbox/sweep, provider finality, artifact/config-drift verification, erasure/export
and retention handling. No D2 producer/worker was implemented. D1 exposes the
primitives and requires an audited matching bound version; its supplied switch
never installs that binding. Paid activation remains blocked until D2 evidence
and the compatible fleet/consumer gates are met. Do not manually bind an arbitrary
configured bound to bypass those gates.

## Shape interpretation and limitations

- The owner correction overrides every literal daily 3 in the shape: use
  ASSISTANT_USER_DAILY_MAX_MESSAGES (DEV configured to 5), with no new default.
- D2 portions of the broad shape are deferred exactly as the owner D1/D2 split
  requests. The only runner/orchestrator changes are D1 funding/no-dispatch proof;
  no provider cost capture or call-evidence population was added.
- RTK.md was not present in the worktree, ancestor paths or the workspace/skill
  searches. The requested handoffs, five workspace rule files, ADRs, S2 migration,
  ops patterns and slice plan were read; no RTK guidance could be loaded.
- The billing readiness boundary uses a matching audited control-row bound version.
  D1 does not certify a real provider bound/finality artifact or enable paid sends.
- Turbo reports sandbox cache-write warnings (`Operation not permitted`); these do
  not prevent TypeScript execution. One concurrent unit run exceeded an existing
  wall-clock performance assertion; the assertion was preserved and passed when
  rerun with two test workers and without a competing compiler run.

## Commands and results

All implementation commands were local reads/edits, type generation or the checks
below. SQL migration/index/validation/cutover scripts were not executed against
any database. No integration test or live provider test was run.

| Command                                                                                                                                                           | Result / attempts                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm api:types`                                                                                                                                                  | PASS twice; generated openapi/gogo.v1.d.ts from the source YAML.                                                                                                                                                                                                                                                                                                                          |
| `pnpm api:version /tmp/be851-base-openapi.yaml openapi/gogo.v1.yaml`                                                                                              | PASS twice; reports version bumped to 10.0.0-alpha.1.                                                                                                                                                                                                                                                                                                                                     |
| `pnpm api:check`                                                                                                                                                  | PASS twice; generated client matches the source spec.                                                                                                                                                                                                                                                                                                                                     |
| `pnpm -s typecheck`                                                                                                                                               | Initial unsupported transaction readOnly option fixed to accessMode. One later fixture never[] / dynamic-import extension failure fixed. Subsequent runs passed all 8 packages. Final post-edit run: PASS, all 8 packages, 46.521 seconds.                                                                                                                                                |
| Focused unit command below, initially without maxWorkers                                                                                                          | First 31-file run: 585 passed / 5 stale contract/fixture assertions failed, corrected. Second 34-file run: 616 passed / 4 decimal-validation/test assertions failed, corrected. Third: 620 passed / 34 files. Expanded 40-file run: 649 passed / 1 stale CMS delta assertion failed, corrected. Next: 649 passed / 1 existing wall-clock assertion failed under concurrent compiler load. |
| Focused unit command below with `--maxWorkers=2`                                                                                                                  | PASS: 651 tests, 40 files, 47.98 seconds. Includes unchanged assistant regression suites and every changed contract-version spec.                                                                                                                                                                                                                                                         |
| `pnpm -s vitest run --project unit --maxWorkers=2 apps/api/src/config/env.spec.ts`                                                                                | Final follow-up after conditional-bound metadata correction: PASS, 86 tests in 1 file.                                                                                                                                                                                                                                                                                                    |
| `pnpm -s vitest list --project integration apps/api/test/assistant-credit-spend-admission.int.spec.ts apps/api/test/assistant-credit-spend-migration.int.spec.ts` | PASS: final collection finds 16 scenarios. No hooks/tests/database operations executed. Earlier collection found 15 before adding invalid-index-remnant recovery.                                                                                                                                                                                                                         |
| `pnpm exec prettier --write --ignore-unknown <changed files below>`                                                                                               | PASS after each implementation batch; SQL files have no configured Prettier parser and are skipped.                                                                                                                                                                                                                                                                                       |
| `pnpm exec prettier --check --ignore-unknown <changed files below>`                                                                                               | Earlier PASS; final full manifest including this report: PASS, all matched files.                                                                                                                                                                                                                                                                                                         |
| `pnpm exec eslint <changed .ts files below, excluding generated .d.ts>`                                                                                           | Earlier runs PASS with no output; final post-edit run: PASS, no lint diagnostics.                                                                                                                                                                                                                                                                                                         |

The full focused unit invocation was:

```sh
pnpm -s vitest run --project unit --maxWorkers=2 libs/modules/assistant libs/modules/shared/feature-flags.spec.ts libs/modules/shared/credit-catalogue.spec.ts libs/modules/shared/assistant-credit-readiness.spec.ts libs/modules/cms/application/credit-history-s2.spec.ts apps/api/src/config/env.spec.ts apps/api/src/common/filters/app-exception.filter.spec.ts libs/observability/src/metric-labels.spec.ts libs/modules/ingestion/presentation/contribution-wizard.contract.spec.ts libs/modules/ingestion/presentation/submission-provider-photo.contract.spec.ts libs/modules/notifications/presentation/notifications.contract.spec.ts libs/modules/reviews/presentation/place-list-ratings.contract.spec.ts libs/modules/reviews/presentation/saved-plan-conditions.contract.spec.ts
```

DEV execution still required (not run here):

```sh
pnpm -s vitest run --project integration apps/api/test/assistant-credit-spend-admission.int.spec.ts apps/api/test/assistant-credit-spend-migration.int.spec.ts
```

The two specs cover D01 free at zero/positive balance and legacy preservation;
D03 last-free and paid-funds races; D04 exact refusal details/no acceptance or
provider dispatch/R success; D05 VN midnight, replay after reset and simultaneous
boundary admission; D09 populated 0098 and fresh DB, old-writer overlap, row shapes,
reserved-key collisions, precise numeric storage and real invalid concurrent-index
remnant detection/recovery. Deterministic admission tests stop at the runner
boundary; they do not claim live inference or billing provenance acceptance.

## Changed files

- `apps/api/src/common/filters/app-exception.filter.spec.ts`
- `apps/api/src/common/filters/app-exception.filter.ts`
- `apps/api/src/config/env.spec.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/health/health.controller.ts`
- `apps/api/test/assistant-credit-spend-admission.int.spec.ts`
- `apps/api/test/assistant-credit-spend-migration.int.spec.ts`
- `apps/api/test/credit-event-prerequisites.int.spec.ts`
- `apps/api/test/credit-events-catalogue.int.spec.ts`
- `apps/api/test/support/assistant-fixture.ts`
- `apps/api/test/support/credit-events.ts`
- `apps/api/test/support/password-recovery-fixture.ts`
- `apps/worker/src/main.ts`
- `docs/adr/0036-assistant-openrouter-jev-haiku-byok.md`
- `docs/adr/0040-discovery-contributor-credits.md`
- `docs/adr/0054-assistant-actual-cost-credit-funding.md`
- `docs/infrastructure.md`
- `docs/plans/829-slices.md`
- `docs/plans/851-D1-validation.md`
- `libs/database/src/schema/assistant.ts`
- `libs/modules/assistant/application/assistant-availability.service.ts`
- `libs/modules/assistant/application/assistant-conversations.service.ts`
- `libs/modules/assistant/application/assistant-credit-admission.spec.ts`
- `libs/modules/assistant/application/assistant-credits.service.spec.ts`
- `libs/modules/assistant/application/assistant-credits.service.ts`
- `libs/modules/assistant/application/assistant-orchestrator.service.ts`
- `libs/modules/assistant/application/assistant-turn-runner.service.ts`
- `libs/modules/assistant/application/assistant-turn-runner.spec.ts`
- `libs/modules/assistant/application/assistant-views.ts`
- `libs/modules/assistant/application/assistant.config.ts`
- `libs/modules/assistant/application/turn-state.ts`
- `libs/modules/assistant/domain/assistant.types.ts`
- `libs/modules/assistant/domain/credit-cost.spec.ts`
- `libs/modules/assistant/domain/credit-cost.ts`
- `libs/modules/assistant/infrastructure/assistant-credit-spend.repository.spec.ts`
- `libs/modules/assistant/infrastructure/assistant-credit-spend.repository.ts`
- `libs/modules/assistant/infrastructure/assistant-credit.repository.ts`
- `libs/modules/assistant/infrastructure/assistant.repository.ts`
- `libs/modules/assistant/presentation/assistant.contract.spec.ts`
- `libs/modules/assistant/presentation/assistant.module.ts`
- `libs/modules/cms/application/cms-assistant-credits.service.ts`
- `libs/modules/cms/application/credit-history-s2.spec.ts`
- `libs/modules/ingestion/presentation/contribution-wizard.contract.spec.ts`
- `libs/modules/ingestion/presentation/submission-provider-photo.contract.spec.ts`
- `libs/modules/notifications/presentation/notifications.contract.spec.ts`
- `libs/modules/reviews/presentation/place-list-ratings.contract.spec.ts`
- `libs/modules/reviews/presentation/saved-plan-conditions.contract.spec.ts`
- `libs/modules/shared/app-error.ts`
- `libs/modules/shared/assistant-credit-readiness.spec.ts`
- `libs/modules/shared/assistant-credit-readiness.ts`
- `libs/modules/shared/credit-catalogue.spec.ts`
- `libs/modules/shared/credit-catalogue.ts`
- `libs/modules/shared/feature-flags.spec.ts`
- `libs/modules/shared/feature-flags.ts`
- `libs/modules/src/index.ts`
- `libs/observability/src/metric-labels.ts`
- `migrations/0099_assistant-cost-credit-spending.sql`
- `migrations/meta/_journal.json`
- `openapi/CHANGELOG.md`
- `openapi/gogo.v1.d.ts`
- `openapi/gogo.v1.yaml`
- `scripts/ops/activate-assistant-credit-spend.sql`
- `scripts/ops/index-assistant-credit-spend.sql`
- `scripts/ops/validate-assistant-credit-spend.sql`
