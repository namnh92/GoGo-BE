# GoGo-BE #829 S2 implementation and verification

Date: 2026-11-10. Scope: docs/plans/829-slices.md §S2 only. Authority:
`dev/handoffs/sa-shape-credit-events.fable.md`, read in full, with
Astra-CE-01/02/03 overriding historical passages. S1 migration 0097 is retained.
Migration added: **0098_credit-events-catalogue.sql**.

Implemented: catalogue/stable +50/+10/+5 seeds, additive ledger columns,
NOT VALID shape/event-key constraints, separate concurrent-index and validation
scripts; versioned trigger decoders, quarantine, payload-only predicates,
supported audiences/scopes, HMAC business entitlements, caps, atomic budgets,
all-or-none groups and grant+ack; sync rule→account→domain locks, 50+10 components
and reconciliation of legacy conflicts before payment; erasure through one
random tombstone map; resumable separately committed legacy attribution batches.
Outbox retention preserves pending/quarantined work. Worker consumption defaults
to paused; cutover is not switched from sync.

No public contract files changed: OpenAPI and generated client remain
9.1.0-alpha.1. Existing public history projects internal evidence back into its
closed reason enum until S3. No S3 endpoints/dry-run/public MAJOR or S4 activation,
fleet fence, deployment, real-data migration or enablement was performed.
Operational details and rollback: [credit-events-s2.md](../credit-events-s2.md).

## Executed local checks

| Check                                        | Result                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm format                                  | PASS                                                                                                                                                                   |
| pnpm lint                                    | PASS                                                                                                                                                                   |
| pnpm typecheck                               | PASS, all 8 packages; integration specs included in API typecheck                                                                                                      |
| Focused S2 + S1 regression unit run          | PASS, 13 files / 129 tests                                                                                                                                             |
| Full pnpm test                               | BLOCKED overall (exit 1): 309 files passed, 4012 tests passed, 1 existing skipped; only apps/api/src/sentry-request.spec.ts fails setup with listen EPERM on 127.0.0.1 |
| Migration forward/index/validation execution | NOT RUN                                                                                                                                                                |
| Testcontainers integration specs             | NOT RUN, as instructed; Claude must run the exact commands below                                                                                                       |

The socket-dependent Sentry suite was neither weakened nor skipped. No
permission escalation or git command was used. Branch/head/clean state was not
inspected. Turbo emitted cache-write permission warnings while typecheck itself
completed successfully.

FAIL-before / PASS-after regressions:

- +10 evidence: S1 returned {base:50, photoBonus:20, total:70}; the regression
  requires {base:50, photoBonus:10, total:60}. FAIL captured before changing the
  helper; PASS in focused and full runs.
- Erasure: with the exact pre-extension assistant erasure body restored
  temporarily, the regression found no entitlement rewrite (index -1). Restoring
  the extension passes and proves entitlement/ledger rewrites precede unlinking.
- Public compatibility: without the projection, internal submission_evidence
  escaped the closed public reason enum. The regression fails before the mapping
  and passes after it. Public field names and contract files are unchanged.

Additional unit proof covers distinct business entitlement keys, nullable
recipients, unsupported audiences/scopes/facts/operators/depth/leaves, versioned
backlog, quarantine/recovery, no writes while paused, locks before outbox,
active accounts, caps, group all-or-none budgets/exhaustion, reservation rollback
on entitlement/ack failure, legacy 20/50/70 mapping and one erasure tombstone map.

## Exact Testcontainers commands for Claude

Run from this worktree with Testcontainers/Docker and loopback networking
available. The new specs perform populated S1→S2 forward migration and apply the
index ops script outside DDL transactions. They do not activate a real fleet.

New specs:

```sh
pnpm test:integration \
  apps/api/test/credit-events-catalogue.int.spec.ts \
  apps/api/test/credit-events-evaluator.int.spec.ts \
  apps/api/test/credit-events-legacy-erasure.int.spec.ts
```

All affected integration regressions (includes the new specs and S1):

```sh
pnpm test:integration \
  apps/api/test/cms.int.spec.ts \
  apps/api/test/contribution-wizard.int.spec.ts \
  apps/api/test/cost-baseline.int.spec.ts \
  apps/api/test/credit-event-prerequisites.int.spec.ts \
  apps/api/test/credit-events-catalogue.int.spec.ts \
  apps/api/test/credit-events-evaluator.int.spec.ts \
  apps/api/test/credit-events-legacy-erasure.int.spec.ts \
  apps/api/test/discovery-774.int.spec.ts \
  apps/api/test/google-provenance.int.spec.ts \
  apps/api/test/identity-claim.int.spec.ts \
  apps/api/test/ingestion.int.spec.ts \
  apps/api/test/place-contact-ownership.int.spec.ts \
  apps/api/test/submission-administrative.int.spec.ts \
  apps/api/test/submission-photos.int.spec.ts \
  apps/api/test/submission-provider-photo.int.spec.ts \
  apps/api/test/submission-review.int.spec.ts
```

Also rerun `pnpm test` in that environment so the existing Sentry request
suite can execute. No successful migration/concurrency/erasure runtime result
is claimed until Claude supplies these outputs. Existing submission and credit
fixtures now apply the separate concurrent-index phase and use the production
lock tiers; component assertions have been updated to +50/+10 semantics.

New integration scenarios cover stable seeds, mismatch/misdefined indexes,
NOT VALID row-shape rejection, unchanged historical deltas, bounded committed
batches, post-drain reconciliation, source identity reuse, overlapping
sync/evaluator/backfill, late/dead-lettered events, pause/rollback, replay,
quarantine recovery, ack-failure rollback, concurrent caps/group budgets and
both evaluator/erasure commit orders with observed PostgreSQL lock waits.

## Files changed or added

- `apps/api/src/health/health.controller.ts`
- `apps/api/test/cms.int.spec.ts`
- `apps/api/test/contribution-wizard.int.spec.ts`
- `apps/api/test/cost-baseline.int.spec.ts`
- `apps/api/test/credit-event-prerequisites.int.spec.ts`
- `apps/api/test/credit-events-catalogue.int.spec.ts`
- `apps/api/test/credit-events-evaluator.int.spec.ts`
- `apps/api/test/credit-events-legacy-erasure.int.spec.ts`
- `apps/api/test/discovery-774.int.spec.ts`
- `apps/api/test/google-provenance.int.spec.ts`
- `apps/api/test/identity-claim.int.spec.ts`
- `apps/api/test/ingestion.int.spec.ts`
- `apps/api/test/place-contact-ownership.int.spec.ts`
- `apps/api/test/submission-administrative.int.spec.ts`
- `apps/api/test/submission-photos.int.spec.ts`
- `apps/api/test/submission-provider-photo.int.spec.ts`
- `apps/api/test/submission-review.int.spec.ts`
- `apps/api/test/support/credit-events.ts`
- `apps/worker/src/main.ts`
- `docs/credit-events-s2.md`
- `docs/plans/829-s2-verification.md`
- `libs/database/src/schema/assistant.ts`
- `libs/modules/assistant/application/assistant-privacy.ts`
- `libs/modules/cms/application/cms-assistant-credits.service.ts`
- `libs/modules/cms/application/credit-history-s2.spec.ts`
- `libs/modules/ingestion/application/identity-claim.spec.ts`
- `libs/modules/ingestion/application/place-submission.service.spec.ts`
- `libs/modules/ingestion/application/place-submission.service.ts`
- `libs/modules/ingestion/domain/enrichment-selection.spec.ts`
- `libs/modules/shared/assistant-credits.spec.ts`
- `libs/modules/shared/assistant-credits.ts`
- `libs/modules/shared/credit-catalogue.spec.ts`
- `libs/modules/shared/credit-catalogue.ts`
- `libs/modules/shared/credit-erasure.spec.ts`
- `libs/modules/shared/credit-erasure.ts`
- `libs/modules/shared/credit-evaluator.spec.ts`
- `libs/modules/shared/credit-evaluator.ts`
- `libs/modules/shared/credit-events-s2.spec.ts`
- `libs/modules/shared/credit-grants.ts`
- `libs/modules/shared/credit-triggers.spec.ts`
- `libs/modules/shared/credit-triggers.ts`
- `libs/modules/src/index.ts`
- `migrations/0098_credit-events-catalogue.sql`
- `migrations/meta/_journal.json`
- `scripts/ops/attribute-legacy-credit-events.ts`
- `scripts/ops/index-credit-events.sql`
- `scripts/ops/validate-credit-events.sql`

## Filesystem evidence

No git metadata was used to identify changes: the list above is based on
SHA-256 differences from an initial filesystem manifest. It does not claim a
clean or committed review basis. Test-generated artifacts absent from that
initial manifest were removed after the suite.

Logs and the final content-hash manifest are stored outside the repository at:

`/Users/maxnguyen/MyWorks/GoGo/dev/handoffs/be-829-s2-evidence-20261110T105951Z`

Independent review, CODEOWNER, migration timing/forward execution, integration
acceptance, deployed readiness and S4 activation remain unverified.

## Integration assertion follow-up (2026-11-10)

Claude reported 18 integration files: 17 passed, 601 tests passed, and two
assertion failures in `submission-photos.int.spec.ts`. This is supplied evidence,
not an integration run performed by this follow-up.

Both failures pin superseded expectations; production grants are unchanged:

- The owned-evidence approval test expected one +70 row. Shape R2-03 and Q22
  require separate `submission_approved` +50 and `submission_evidence` +10 rows,
  totalling 60. The assertion now checks both exact reasons, deltas and business
  entitlement keys, then compares the full ledger rows after a rejected retry.
- The explicit keep/drop merge test equated the pending approval preview (60)
  with the merge award. Shape R2-06 restricts the +50 seed to `decision eq
approved`; approved evidence on merge earns only +10. That supersedes #806's
  historical explicit-selection merge base. S2 retains the approval preview
  without a decision input; catalogue-derived previews belong to S3. The test
  now requires exactly +50/+10 and total 60 for approval, or exactly +10 and
  total 10 for merge. It also compares full ledger rows immediately after the
  same-key replay and after the changed-payload rejection. Existing response,
  audit, retained facts/photos and post-decision zero-preview checks remain.

Checks executed after the assertion changes:

| Check                                                               | Result                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                         | BLOCKED overall (exit 1): 309 files and 4012 tests passed, 1 skipped; only `apps/api/src/sentry-request.spec.ts` failed setup with `listen EPERM` on `127.0.0.1` |
| `pnpm typecheck`                                                    | PASS, 8 packages (including the API integration specs); Turbo cache-write permission warnings only                                                               |
| `pnpm lint`                                                         | PASS                                                                                                                                                             |
| `pnpm test:integration apps/api/test/submission-photos.int.spec.ts` | BLOCKED (exit 1): Testcontainers could not find a working container runtime strategy; all 27 tests skipped during setup                                          |

No git command was run. The original failure report was copied outside the
worktree before deleting `.s2-fail.txt`. The before-file and command logs are in
`/private/tmp/gogo-829-s2-followup-20261110/`. The corrected integration assertions
still require execution in Claude's working Testcontainers environment; no
PASS-after integration result is claimed here.
