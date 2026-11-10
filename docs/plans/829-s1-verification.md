# #829 S1 verification and handoff

Scope: [slice plan](829-slices.md), S1 only; producer details and rollback in
[credit-event-prerequisites.md](../credit-event-prerequisites.md).
No git command, deployment, activation or integration execution was performed.
Public OpenAPI remains 9.1.0-alpha.1; synchronous grants retain 50/20/70.

## Regression evidence

Original production files were copied to `/tmp/829-before` before modification.
The five producer files were temporarily restored from those bytes for the
regression run, then the implementation restored in a Python `finally` block.
This is a filesystem basis, not a Git-head claim. Source hashes and retained
logs: [829-s1-evidence](829-s1-evidence/source-sha256.json).

Same five test files, same command, before and after:

```sh
pnpm exec vitest run --project unit \
  libs/modules/shared/outbox.spec.ts \
  libs/modules/cms/application/credit-review-publication.spec.ts \
  libs/modules/reviews/application/credit-review-creation.spec.ts \
  libs/modules/rooms/infrastructure/room-credit-completion.spec.ts \
  libs/modules/ingestion/application/identity-claim.spec.ts
```

| Scenario from shape               | FAIL-before observation                            | PASS-after assertion                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CE-F-04 payload version           | Explicit v2 stored as 1                            | Explicit 2 stored; omitted version remains 1                                                                                                                                |
| Astra-CE-02 / CE-F-11             | No creation epoch or publication event             | Before-activation epoch null; after first activation epoch retained, including sync rollback; publication/republication first flag and stamp                                |
| §6 atomic moderation              | No transaction; forced outbox failure never occurs | Status, stamp, audit and event roll back together                                                                                                                           |
| Astra-CE-01 deleted review author | No recipient-safe publication                      | Retained review publishes with null recipient                                                                                                                               |
| §6 submission facts               | Decision lacks v2 facts; no evidence event         | Approval and merge emit facts; zero evidence emits none; +50/+20/+70 unchanged                                                                                              |
| Astra-CE-01 erased submitter      | Legacy writer rejects an inactive recipient        | Recipient null, no grant, moderation commits                                                                                                                                |
| CE-F-05 / CE-F-13 cohort          | No completion snapshot or discovery retry          | Ordered accounts precede room; active registered cohort/facts captured under room lock; newly discovered account causes rollback/retry; event failure rolls completion back |

Before: **16 failures, 15 passes** (the intended regressions and preserved
invariants). After: **31 passes**. Extra existing submission/review fixtures
were updated for the new transactional cutover/liveness reads. The feature flag
test confirms the evaluator is paused by default and has no platform override.

## Checks executed

| Command                                        | Result                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                               | PASS, 8 packages; Turbo reports shared-cache write permission warnings, no TypeScript errors |
| `pnpm lint`                                    | PASS                                                                                         |
| Focused regression command above               | PASS, 31 tests                                                                               |
| `pnpm test` (full unit, final production code) | 300 files PASS, 3919 tests PASS; one suite BLOCKED by sandbox socket permissions             |

The full unit command exits 1 because the existing
`apps/api/src/sentry-request.spec.ts` cannot listen on `127.0.0.1`:
`listen EPERM: operation not permitted 127.0.0.1`. Its one test is reported
skipped after setup failure. No S1 test failed. This is not a clean full-unit
gate; Claude must rerun that suite/full unit in an environment allowing sockets.

## Integration specs Claude must run (NOT RUN here)

```sh
pnpm exec vitest run --project integration \
  apps/api/test/credit-event-prerequisites.int.spec.ts \
  libs/database/test/schema.int.spec.ts \
  apps/api/test/cms.int.spec.ts \
  apps/api/test/rooms.int.spec.ts \
  apps/api/test/identity-claim.int.spec.ts \
  apps/api/test/discovery-774.int.spec.ts \
  apps/api/test/submission-review.int.spec.ts \
  apps/api/test/contribution-wizard.int.spec.ts \
  apps/api/test/place-reviews.int.spec.ts \
  apps/api/test/notification-event-facts.int.spec.ts \
  apps/api/test/privacy-export.int.spec.ts \
  apps/api/test/privacy-export-review.int.spec.ts \
  apps/api/test/privacy-export-round2.int.spec.ts
```

The new spec forward-migrates a populated 0096 database, verifies unchanged
legacy credits and null old epochs, validates the S1 constraint, exercises
activation/creation locking in both orders, once-only publication, real
transaction rollback and idempotent audit-backed stamp reconciliation. It
also exercises completion/publication/approval versus erasure in both commit
orders, recipient scrubbing, cohort expansion by guest claim and removal on
either side of the room lock. These scenarios are authored and typechecked,
not runtime-verified here. Measure the shape's sub-second DDL goal on a masked
production-sized snapshot; the small Testcontainers fixture is not that proof.

S2 owns catalogue/ledger DDL, seeds, rule-first grant locking, attribution,
decoder quarantine, retention and full readiness; S3 owns MAJOR/CMS/dry-run;
S4 owns writer fencing and activation. None of those gates is established by S1.
