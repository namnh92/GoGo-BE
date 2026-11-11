# BE #864 / #873 — S3 validation and reproduction

S3 baseline: `d2d41184e9192e7fa658fc0993b8136b6ea7907f` (S0/S1/S2).
Fix-round starting head: `bc9fece7f9f9e749b424382354d4e5677164c95b`.
This round changes the worktree without a commit. Authority: Astra shape rev3
§§3–5, 7–10 plus the owner decision of 2026-11-11 in
`dev/policy/decisions-log.md` (“Theo đề xuất”). The normative
[spec amendment](864-s3-spec-amendment.md) classifies vi-065 as QA and preserves
the other 156 intent cases. Feature stays dark; S3 is not #844 acceptance.

## Findings and fixes

- **Astra F-01:** initial bare-name admission still requires whole canonical
  equality. Current-area continuation validates the complete original source
  text, retains the durable QA fence and emits an answer, narrowing or not-found
  response. A failed refinement never restores recommendation history eligibility.
- **Astra F-02:** a name supplied to `kind: referent` retains the pending topic,
  arguments, source and original lifetime. Only a genuinely new bare-name
  request resets to overview and starts a new lifetime.
- **Astra F-03:** structured “none” carries the original `createdAt` and
  `expiresAt`, just like typed continuation. It cannot extend the 30-minute TTL.
- **Sol F-01 / Astra F-04:** activation changes the published contract even
  with compatible wire fields. MINOR `10.2.0-alpha.1`, regenerated declarations,
  CHANGELOG and all six checked contract-test pins replace the unchanged-version
  claim. Historical S1 release records retain their original version.
- **Sol F-03 / Astra vi-065:** the owner-approved named-place hours case is
  explicit in the classifier and Layer A. Flag on: zero model calls/attempts;
  flag off: baseline behavior. The other 156 cases are preservation gates.
- **Sol F-02 / Astra F-05:** executable base harness overlay and SHA/hash-bound
  reports replace the old manual archive recipe. DEV supplies fresh base/head
  evidence below; prior setup-only reports are superseded, not current results.

## Regression proof at the fix-round starting head

The identical new service spec was run against the original `bc9fece7` service,
then against the fixed service, with no other production change in that run.

| Finding    | New test cells                                                       | Original symptom assertion                                             |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Astra F-01 | Bare-name narrow + current area → answer / narrow / not-found        | `clearPlaceQa` was called; durable route disappeared before a response |
| Astra F-02 | Referent continuation for price / hours with explicit date / amenity | Topic became overview, arguments cleared, source and TTL reset         |
| Astra F-03 | Structured none at 29:59.999, refinement after 30:00                 | `createdAt`/`expiresAt` advanced by almost 30 minutes                  |

Before: **7 failed / 15 passed**, exit **1**. After: **22 passed**, exit **0**,
including two flag-on/off service checks for vi-065.
Logs: `/private/tmp/be873-regression-before.log` and
`/private/tmp/be873-regression-after.log`.
The contract-version gate against the S3 baseline failed before (exit **1**,
unchanged `10.1.0-alpha.1`), log `/private/tmp/be873-version-before.log`.

## Identical Layer A harness on base and head

Requires Docker/Testcontainers, cached PostGIS image and offline pnpm packages.
DEV executes both commands and attaches JSON plus full logs. No live model
provider is called; the fixture adapters serialize the real adapter requests.
Do not report setup/import/admission errors as symptom failures.

```sh
scripts/eval/place-qa-layer-a-base.sh d2d41184 /private/tmp/be873-base-layer-a

mkdir -p /private/tmp/be873-head-layer-a
PLACE_QA_BASE_SHA="$(git rev-parse d2d41184)" \
PLACE_QA_HEAD_SHA="worktree:$(git rev-parse HEAD)" \
PLACE_QA_REPORT=/private/tmp/be873-head-layer-a/cases.json \
pnpm -s vitest run --project integration --no-file-parallelism \
  apps/api/test/assistant-place-qa-s3.int.spec.ts \
  --reporter=default --reporter=json \
  --outputFile=/private/tmp/be873-head-layer-a/vitest.json \
  > /private/tmp/be873-head-layer-a/test.log 2>&1
# Record the command's exit code immediately, before any other command.
```

The base script creates a detached temporary git worktree at the supplied SHA,
copies only its explicit test allowlist, verifies copy hashes and rejects changes
outside that allowlist before installation. It installs dependencies offline in
base, so workspace links target base production code. It never copies candidate
`node_modules`, application/library implementation, config, migrations or ops SQL.
The base uses its own index SQL via the identical test-support helper.
Cleanup removes only the script's temporary worktree. The report directory stays.

Overlay files: Layer A spec, the two QA JSON fixtures, original intent corpus,
and test support `assistant-fixture.ts`, `place-name-key.ts`, `credit-events.ts`,
`cms-access.ts`, `pg-shutdown.ts`. Production imports must resolve from base.
`--help` and shell syntax checks are safe without Docker. Worktree creation and
Docker execution are left to DEV for this fix round.

Outputs: `overlay.json` (source/destination hashes, resolved base SHA, candidate
HEAD and tracked-diff digest), `install.log`, `test.log`, `vitest.json`,
`cases.json` and `run.json` (install/test exit codes and category/result counts).
Bind head's dirty-tree evidence to the same `overlay.json` and a source snapshot
or diff manifest; HEAD alone identifies only the pre-fix commit.
The harness records the supplied base/tested SHA, clock and fixture version.
A setup status is diagnostic only; no cases executed means no behavioral proof.

### Designated incident and preservation case IDs

| Category                     | Exact IDs                                                                                      | Base requirement                                         | Head requirement                |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| Incident regressions         | `hours-01`, `price-01`, `overview-01`, `owner-quan-x`                                          | FAIL at rendered symptom assertion, `phase: symptom`     | PASS                            |
| Hard-negative preservation   | `negative-01` through `negative-30`                                                            | PASS                                                     | PASS                            |
| Intent preservation          | `preserve-vi-001` through `preserve-vi-064`, `preserve-vi-066` through `preserve-vi-157` (156) | PASS                                                     | PASS                            |
| vi-065 flag-off preservation | `preserve-vi-065-off`                                                                          | PASS on the baseline model path                          | PASS on the baseline model path |
| Formal QA activation         | `qa-vi-065-on`                                                                                 | Capability measurement, not a mandatory incident failure | PASS, zero model calls/attempts |
| Remaining QA corpus          | Every other ID in `place-qa-cases.vi.json`                                                     | Capability measurement                                   | PASS                            |

The four incident assertions check rendered text (hours, price or no-data copy)
at `phase: symptom`, then cards/follow-ups at `phase: public_contract`, **before**
any S3 trace or ledger assertion. A failure at `phase: request`, `public_contract`
or `qa_contract` does not prove FAIL-before at the rendered-text symptom. Reports label
incident, preservation and capability separately. Baseline mode skips only the
S3-specific state/history/control tests; all 187 preservation cells run on both
revisions. Head also runs those S3-specific tests; its Vitest report/log covers
them in addition to the per-case JSON. No aggregate pass count substitutes for
the four symptom failures plus every preservation pass.

### DEV evidence — pending execution of this revision

Earlier supplied head evidence was 415/415 before this round. It does not cover
these fixes or the two new vi-065 Layer A cells; it is not relabeled as current.
The old setup-only result is superseded. DEV must paste fresh results here.

| Evidence                                      | Base                                    | Head                                    |
| --------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Tested source SHA / dirty snapshot digest     | **PENDING_DEV: SHA + digest**           | **PENDING_DEV: SHA + digest**           |
| Harness/overlay hashes                        | **PENDING_DEV**                         | **PENDING_DEV: match base overlay**     |
| Vitest command exit                           | **PENDING_DEV**                         | **PENDING_DEV**                         |
| Four incident IDs, symptom FAIL / PASS counts | **PENDING_DEV: __ / 4 FAIL at symptom** | **PENDING_DEV: __ / 4 PASS**            |
| Preservation PASS / FAIL counts               | **PENDING_DEV: __ / __ (187 required)** | **PENDING_DEV: __ / __ (187 required)** |
| Capability PASS / FAIL counts                 | **PENDING_DEV: __ / __**                | **PENDING_DEV: __ / __**                |
| qa-vi-065-on: calls / attempts                | Capability measurement                  | **PENDING_DEV: __ / __ (both zero)**    |
| Full Layer A tests passed / failed / skipped  | **PENDING_DEV: __ / __ / __**           | **PENDING_DEV: __ / __ / __**           |
| JSON and log paths                            | **PENDING_DEV**                         | **PENDING_DEV**                         |

## Local fix-round checks

The full unit command is environment-blocked at a socket listener; the remaining
checks pass. This is not a DEV acceptance record.

| Command                                                                         | Exit  | Evidence                                                                                                                                                |
| ------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -s typecheck`                                                             | 0     | `/private/tmp/be873-typecheck.log` — all 8 packages pass; shared-cache permission warnings only                                                         |
| `pnpm -s vitest run --project unit`                                             | 1     | `/private/tmp/be873-unit.log` — 4,837 passed, 1 skipped; 342 suites pass, `apps/api/src/sentry-request.spec.ts` setup fails at `listen EPERM 127.0.0.1` |
| `pnpm -s api:check`                                                             | 0     | `/private/tmp/be873-api-check.log` — generated declarations match                                                                                       |
| `pnpm -s api:version /private/tmp/be873-base-openapi.yaml openapi/gogo.v1.yaml` | 0     | `/private/tmp/be873-api-version.log` — MINOR `10.2.0-alpha.1` vs S3 baseline                                                                            |
| Prettier / ESLint on touched supported files                                    | 0 / 0 | `/private/tmp/be873-{prettier,eslint}.log`                                                                                                              |
| `bash -n scripts/eval/place-qa-layer-a-base.sh`, script `--help`                | 0     | Shell syntax and usage pass; base/Docker execution belongs to DEV                                                                                       |

Focused service + intent + assistant contract: **184 passed**, exit **0**,
`/private/tmp/be873-focused.log`. Script shell/help and both embedded JavaScript
syntax checks pass. `git diff --check` exits **0**. The generated d.ts was rebuilt
with `pnpm -s api:types` (exit **0**); the version-only change leaves its bytes
unchanged. A final changed-source SHA-256 inventory is saved to
`/private/tmp/be873-source-manifest.json` for review.

No commit, push, merge, deployment, flag enablement, remote CI or full S4/S5
acceptance is part of this fix round.

## Retained round-2 behavioral decisions

The prior prefix-boundary fix starts suffix scanning after the complete recognized
prefix and skips complete nested question heads. It retains S2 whole-name
alternative readings and area spans. No resolver threshold changed.
All 22 typo cases (each topic's `-11` and `-12`) still expect confirmation of
`lantern`, `no_price`, `owner_x`, with Lantern first and UUID-tied others unordered
(shape rev3 §4.3 row 5). `unclear` still means deterministic `turn_relation`
clarification with zero Haiku calls and byte-identical adapter requests on clean
and QA-interposed histories (shape rev3 §3.2). Index setup still executes the
base/head's actual `scripts/ops/index-place-name-key.sql` in autocommit; migration
0102 remains verify-only. No production fallback or second index path was added.
