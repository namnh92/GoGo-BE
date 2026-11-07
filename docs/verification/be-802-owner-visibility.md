# GoGo-BE #802 / #796 — final public consent and user-photo amendment

2026-11-07. Worktree `feature/GOGO-796-place-wizard`, HEAD `581c2749` plus
uncommitted changes. Existing no-DLP work continued; no install, commit or push.
This report supersedes the earlier private/public visibility results.

## Behavior

- Remove `visibility`; strict photo references reject it. Bill saves/submits require
  `billPhotoPublicConsent: true`: public display after moderation, personal information
  removed/hidden by the uploader. Vietnamese consent text: ADR-0048.
- No DLP/external receipt provider. WebP re-encoding strips metadata, not visible PII.
- Explicitly selected wizard menu/bill photos join `place_submission_photos.place_id`
  with approved status and original uploader credit. Place detail exposes read-only
  `userPhotos`; no wizard photo creates official `place_media` or becomes a cover.
- Server-owned menu/bill prefixes preserve classification through draft transfer and
  dedupe even when the original submission's enrichment is retained unchanged.
- Pending/rejected photos never appear in userPhotos. Public byte reads recheck
  approval and place visibility. Moderators may discard any pending photo.
- Approval grants +50, plus +20 when at least one original menu/bill reference is
  approved; merge grants the qualifying +20 only. Ledger remains idempotent.
- Promotion endpoint and migration/backfill of ordinary historical #794 gallery
  photos are tracked in [#804](https://github.com/namnh92/GoGo-BE/issues/804).
  Ordinary non-wizard #794 uploads retain their existing path in this patch.
- Migration 0089 adds the nullable place link and index; canonical place merge moves
  these links. Deploy schema before binary. Rollback instructions preserve links and
  disable wizard decisions on the old binary, which would insert into the gallery.

## Verification

Logs: `artifacts/be-802-public-user-photos/` (copied from `/tmp` after tests;
artifact-generation tests recreate the artifacts directory).
Source manifest excludes this report and ignored artifacts, and includes changed
source, tests, contract and other docs. SHA-256: `25ea150d8e7e84d054384058d5707a66ee55f5ddeb665f19cf128e8696e6495e`.
No DEV/HTTP/DB acceptance or independent review is claimed.

| Gate                                                     | Result                                                                          | Log                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------- |
| Focused unit: ingestion + credits + place-detail mapper  | PASS: 25 suites, 442 tests                                                      | focused.log             |
| Full unit: `pnpm test --maxWorkers=2`                    | FAIL: 265 suites passed, 3 failed; 3581 tests passed, 2 failed, 1 skipped       | unit.log                |
| Separate timing-test rerun                               | PASS: 2 suites, 55 tests                                                        | timing-rerun.log        |
| Full integration: `pnpm test:integration --maxWorkers=2` | BLOCKED: 103 suites fail initialization, 1 skipped; 15 tests pass, 2144 skipped | integration.log         |
| Changed integration suites                               | BLOCKED: 2 suites fail container initialization, 31 tests skipped               | integration-focused.log |
| `pnpm typecheck` after missing test import fix           | PASS: 8/8 tasks; cache-write warnings only                                      | typecheck-final.log     |
| `pnpm lint`                                              | PASS                                                                            | lint.log                |
| `pnpm exec prettier --check .`                           | PASS after formatting the existing domain test                                  | prettier.log            |
| `pnpm api:types`                                         | PASS                                                                            | api-types.log           |
| `pnpm api:check`                                         | PASS                                                                            | api-check.log           |
| `git diff --check`                                       | PASS                                                                            | diff-check.log          |
| Real Docker oasdiff                                      | BLOCKED, exit 1                                                                 | oasdiff.log             |
| Compatibility policy with failed measurement             | FAIL CLOSED, exit 2                                                             | oasdiff-policy.log      |

Full-unit failures: `sentry-request.spec.ts` cannot listen on 127.0.0.1 (`EPERM`).
`grounding.spec.ts` exceeded its 1000ms budget (1021ms) and
`room-subscription.spec.ts` exceeded its 5000ms test timeout. Both timing suites
passed separately without code or timeout changes; the broad gate remains failed.
Integration reports `Could not find a working container runtime strategy`.
The full integration run began before the missing `randomUUID` test import was
fixed; the focused integration rerun and final typecheck use the corrected file.

Regression evidence covers strict rejection of visibility, absent/false consent,
retained bill consent, menu/bill approval and rejection, no official gallery insert,
durable menu classification through dedupe, separate credited detail mapping and
idempotent +20/+50/+70 grants. Prior behavior was identified by source inspection:
`decide` unconditionally inserted approved photos into `place_media`; no executed
FAIL-before run is claimed. DB/HTTP regressions are written but not verified because
Docker is unavailable. An initial full-gate attempt lost its redirected logs when
artifact-generation tests rebuilt artifacts; retained broad logs are fresh runs.

## Earlier real oasdiff attempt

No image install/pull attempted:

```sh
git show origin/re-design:openapi/gogo.v1.yaml > /tmp/be-802-public-user-photos/base.yaml
docker run --rm --pull=never \
  -v /tmp/be-802-public-user-photos:/base:ro -v "$PWD:/work:ro" \
  tufin/oasdiff:latest breaking /base/base.yaml /work/openapi/gogo.v1.yaml
```

```text
permission denied while trying to connect to the docker API at unix:///Users/maxnguyen/.docker/run/docker.sock
```

No compatibility finding was measured by that earlier local attempt.

## Contract description correction (2026-11-07)

The owner-supplied real report at
`/Users/maxnguyen/MyWorks/GoGo/dev/handoffs/be-796-oasdiff-ci-shaped.txt`
contains two errors: `request-body-one-of-removed` for decide, and
`response-property-became-not-enum` for assistant-credit delta. The former comes
from description edits inside both inline `oneOf` branches.

Both request branches are now restored byte-for-byte from `origin/re-design`.
The operation description carries the new rules: every approved menu/bill photo
is public in `userPhotos` with uploader credit, never official gallery/cover;
unselected menu photos are rejected and cleaned after seven days, while rejected
bills and derivatives are queued for immediate cleanup. It explicitly overrides
the retained general cleanup wording on `approvedPhotoIds`. No uploader visibility
choice remains in the operation.

- Base YAML SHA-256: `4b744cd0994a727443292fc160992e277ea9eca14da51bac24bbcf85e3868620`
- Final YAML / exception revision SHA-256: `5945572759f10c60b6fc4d014f29a16de19ccf73445c828ffeb14634bcd20442`
- `BE-796-credit-delta-extensible` is the only exception rebound; no branch-removal exception added.
- Generated types regenerated; decide request bytes checked equal to base.
- Earlier source-manifest hash and broad test results above describe the earlier
  tree; they do not validate this final contract amendment.

Fresh measurement command (no pull/install):

```sh
git show origin/re-design:openapi/gogo.v1.yaml > /tmp/be-802-oasdiff-fix/base.yaml
docker run --rm --pull=never \
  -v /tmp/be-802-oasdiff-fix:/base:ro -v "$PWD:/work:ro" \
  tufin/oasdiff:latest breaking /base/base.yaml /work/openapi/gogo.v1.yaml
```

Result: exit 1, Docker socket permission denied as above. Final real oasdiff finding
set remains UNVERIFIED; expected remaining finding is credit delta only.

Policy-only replay uses `credit-only-replay.txt`, extracted from the owner-supplied
report by retaining only its credit-delta diagnostic (one error). It is a projected
report, **not fresh oasdiff output**. The `success` argument models CI's measurement
step completing without `--fail-on`; it does not claim the local Docker run succeeded.
Passing this replay checks the exact-byte exception and diagnostic only.

```sh
SWC_NODE_PROJECT=./tsconfig.base.json node -r @swc-node/register \
  scripts/check-contract-compat.ts \
  /tmp/be-802-oasdiff-fix/base.yaml openapi/gogo.v1.yaml \
  /tmp/be-802-oasdiff-fix/credit-only-replay.txt success \
  --expect=BE-796-credit-delta-extensible
```

Output (exit 0, after printing the retained diagnostic):

```text
✔ 1 breaking change(s), all admitted by a recorded owner decision:
  · BE-796-credit-delta-extensible (https://github.com/namnh92/GoGo-BE/issues/796, decided 2026-11-07)
```

With outcome `failure`, this same replay fails closed (exit 2), as required for a
failed measurement. A Docker-capable fresh run is still needed for acceptance.
