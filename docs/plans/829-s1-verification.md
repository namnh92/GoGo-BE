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

## PR #830 Astra F-01 fix round (2026-11-10)

CMS `removeGuest` now acquires the room `FOR SHARE` before any membership
read, keeping completion's room `FOR UPDATE` as the serialization point.
Because share locks permit simultaneous claim/removal, CMS also locks the
guest session before re-reading/locking the member, matching claim's
session-then-member write order. A claim that wins returns `NOT_A_GUEST`
from removal without changing membership, revoking the session through CMS,
or writing a removal audit.
Host removal's room lock was already present, but its member-then-session
order would invert the corrected CMS/claim order. It now locks the session
before updating membership as well.

The matching `apps/api/test/credit-event-prerequisites.int.spec.ts` adds:

- Completion first: pause immediately after its real room `FOR UPDATE`,
  before snapshot capture. On a dedicated second PostgreSQL connection,
  prove CMS removal is blocked by that transaction using `pg_blocking_pids`
  and `pg_stat_activity`; release completion, then verify the snapshot
  includes the guest in `participantCount` and removal commits afterward.
- CMS removal first: pause after its real room `FOR SHARE`, prove completion
  waits on its room lock, then verify the committed removal is excluded
  from the completion snapshot. Both orders check subjects, session
  revocation, denylist invocation and exactly one removal audit.
- Claim overlap: pause claim after its session update but before its member
  update. Prove CMS waits on the session lock, then verify it revalidates
  the stale guest read, refuses removal, and subsequent completion includes
  the registered claimant in `subjects`.
- Concurrent CMS/host removal: pause CMS after locking the session and prove
  host removal waits on that session before taking the member lock. Both
  removals then finish without a child-row lock inversion.

The gates observe completed Drizzle SELECT/UPDATE queries as well as raw
`tx.execute`; the completion-first gate is intentionally before the snapshot
query, unlike the older repository-removal test. The new PostgreSQL cases
are **NOT RUN** here; no FAIL-before/PASS-after runtime claim is made.

Membership-writer audit (current application call paths):

| Writer                                                                      | Room serialization                                                                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Registered join (`RoomsService.joinAsUser`)                                 | `admitThroughInvite` locks room FOR SHARE before invite use/member insert; standalone `addUserMember` also takes the lock           |
| Guest join / fresh session after removal (`AuthService.createGuestSession`) | Holds room FOR SHARE across admission, session creation and `addGuestMember`                                                        |
| Guest claim / identity replacement (`IdentityRepository.claimGuestSession`) | Locks recipient account, then room FOR SHARE before session/member updates                                                          |
| Host removal (`RoomsRepository.removeMember`)                               | Discovers immutable room ID, then locks room FOR SHARE before mutation; session-before-member order aligned here with claim and CMS |
| CMS guest removal (`CmsUsersService.removeGuest`)                           | Fixed here: room FOR SHARE, session FOR UPDATE, member FOR UPDATE and identity revalidation                                         |
| Initial host member (`RoomsRepository.createRoom`)                          | New room and host membership inserted in one transaction; no concurrent completion can see the uncommitted room                     |
| Privacy / preference writers                                                | Change display name or selection status only, not cohort membership/identity                                                        |

No other missing room lock was found in these production membership-changing
paths. `addGuestMember` receives the already-locked join transaction from its
only production caller.

Checks on this fix round (logs in `/tmp/be-830-{typecheck,lint,unit}.log`):

| Command          | Result                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` | PASS: 8/8 packages; shared-cache permission warnings only                                                                                          |
| `pnpm lint`      | PASS                                                                                                                                               |
| `pnpm test`      | Exit 1: 300 files / 3924 tests PASS; `apps/api/src/sentry-request.spec.ts` setup BLOCKED by sandbox `listen EPERM ... 127.0.0.1`, one skipped test |

Claude must run the focused integration set below (including the CMS console's
remove/rejoin/refuse-registered cases), plus the broader S1 integration set
listed above before landing S1. These are pending execution, not passing gates.

```sh
pnpm exec vitest run --project integration \
  apps/api/test/credit-event-prerequisites.int.spec.ts \
  apps/api/test/cms.int.spec.ts \
  apps/api/test/rooms.int.spec.ts \
  apps/api/test/notification-event-facts.int.spec.ts
pnpm test
```

No git commands, integrations, installs, builds, commits or remote changes
were performed in this fix round. Claude must also rerun the full unit suite
where listening sockets are allowed. Source hashes for this fix are in
`829-s1-evidence/830-f01-source-sha256.json`; these identify filesystem bytes,
not a Git head or an independent review verdict.
