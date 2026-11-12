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
The old setup-only result is superseded. DEV ran both sides with Docker on 2026-11-11 and re-ran them on the Fable fix-round commits `5b14af7e`, `68988c24` and the Astra round `3fa56ecf` on 2026-11-12 (same counts each time); logs live in the GoGo workspace (not this repo) under `dev/test-evidence/be-864/`.

| Evidence                                      | Base                                                                                                    | Head                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Tested source SHA / dirty snapshot digest     | `d2d41184` + overlay of 9 test files (clean otherwise; script refuses non-test changes)                 | `3fa56ecf` clean (diff sha256 `e3b0c442…` = empty)                      |
| Harness/overlay hashes                        | spec `9c504fcd`, cases `c8a3d100`, fixtures `789eee8c`, intents `48c1cc33`, support ×5 (`overlay.json`) | identical hashes (verified per file)                                    |
| Vitest command exit                           | 1 (expected: incident + capability failures)                                                            | 0                                                                       |
| Four incident IDs, symptom FAIL / PASS counts | 4 / 4 FAIL at symptom (reply asks for an area "Bạn muốn đi ở khu vực nào?" instead of the fact)         | 4 / 4 PASS                                                              |
| Preservation PASS / FAIL counts               | 187 / 0                                                                                                 | 187 / 0                                                                 |
| Capability PASS / FAIL counts                 | 0 / 205                                                                                                 | 205 / 0                                                                 |
| qa-vi-065-on: calls / attempts                | Capability measurement                                                                                  | 0 / 0 (jev_calls 0, haiku_calls 0, attempts 0)                          |
| Full Layer A tests passed / failed / skipped  | 187 / 209 / 21 (21 = S3-only state/history/control tests, skipped by baseline mode)                     | 417 / 0 / 0                                                             |
| JSON and log paths                            | `dev/test-evidence/be-864/r5/base/` (cases.json, vitest.json, test.log, overlay.json)                   | `dev/test-evidence/be-864/r5/head/` (cases.json, vitest.json, test.log) |

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

## Fable fix round (2026-11-11, after the confirm round)

Starting head: `1c2dc953775c6a9c2d83452adc660cc82e6c799b`, clean. Authority: the
confirm-round outputs of Sol and Astra, shape rev3 §§3.1, 3.2, 4.3–4.5, and the
owner's "Fable sửa" decision. Worktree changes only; no commit. Every regression
test below was written and run against the unchanged `1c2dc953` production code
first (FAIL), then against the fix (PASS). vi-065 stays named-place QA.

| Finding                           | Root cause                                                                                                                                                                                              | Change                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol F-01 (P1)                     | The `place_qa` fence was first written inside `PlaceQaService.handle`, after funding, the kill switch and an abortable flag read. A stop or orphan finalization before that left the pair unfenced.     | `PlaceQaService.admit` makes the same fence decisions (structured control; enabled + classified QA; typed reply to the latest QA turn) and writes the durable route with no abort signal. `AssistantTurnRunner` awaits it before `runnableFunding`. `handle` reuses the flag and latest-turn reads from `admit`, so the two cannot disagree. Send/admission (`insertTurn`) unchanged. |
| Sol F-02 (P2)                     | A typed ordinal or name always produced another `confirm`, including when the pending state already was a one-candidate `confirm` whose emitted option text is that ordinal.                            | For `kind: confirm` with exactly one candidate, the ordinal or the exact name is the confirmation. `answer` re-reads publication and fact eligibility first. A singleton `choice`, and any other ordinal, still go to `confirm`/retry.                                                                                                                                                |
| Astra F-01 (P2)                   | After a referent clarification the name arrived in a later message, but pending state kept only the question's id; area refinement re-parsed the question, which has no name.                           | `slots[0].sourceMessageId` (shape §4.5) now holds the name-bearing message, separate from `questionMessageId`. Both are re-read under user + conversation on the typed and structured paths; a missing one is `stale_choice` before any lookup. Area refinement reruns the name from the name source with the question's topic, arguments and `createdAt`/`expiresAt`.                |
| S1 reader race (owner-authorized) | The allowance timer called `controller.abort()` before rejecting `RenderTimeout`; the cancellation branch rejected first and the result depended on whether `Date.now()` had reached the allowance yet. | The timer records `timedOut` and rejects `RenderTimeout` before it aborts; classification reads that flag. A caller cancellation is still `read_error`.                                                                                                                                                                                                                               |

Changed expectation (one): `pending.spec.ts` no longer treats
`slots[0].sourceMessageId !== questionMessageId` as an invalid state. Shape rev3
§4.5 defines the slot source as its own reference; authorization is the scoped
re-read of both ids in the service, covered by "an inaccessible question/name
source invalidates the continuation before any lookup". The mutation case now
uses a non-UUID id (still rejected) and a positive case was added. No Layer A
expectation and no other existing assertion changed.

### Regression tests, fail-before / pass-after

| Finding    | Test (file → name)                                                                                                                                                                                                                                                                                         | FAIL on `1c2dc953`                                                                                                                                                                                              | After |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Sol F-01   | `assistant-place-qa-s3-fence.int.spec.ts` → "public stop during funding resolution: both rows stay out of recommendation history and model requests"; "another writer (stop fallback / reaper) finalizing during funding resolution keeps the association"                                                 | Stored trace has no `route`; the user row id is in `repo.history`; history text contains `Quán Sao Lạ`; the captured Jev/Haiku requests match `/Quán Sao Lạ/` and differ from the clean conversation's requests | PASS  |
| Sol F-02   | `place-qa.service.spec.ts` → "two-turn confirmation…", "the exact place name confirms a singleton confirm…", "legacy-district confirm (§4.4)…", "a confirmed candidate that became unavailable…"; int → "choice → emitted ordinal → singleton confirm → emitted text → answer", "legacy-district confirm…" | outcome `confirm` again instead of `answer` / `unavailable`                                                                                                                                                     | PASS  |
| Astra F-01 | `place-qa.service.spec.ts` → "choice → area / typed none → area / structured none → area resolves the supplied name…", "a branch choice inside the area keeps question, name source, topic and the original expiry", "an inaccessible name source invalidates…"; int → "choice → area", "none → area"      | `resolvePlaceName` never called with `Song Ngọc`; outcome `retry` instead of `answer`/`choice`/`stale_choice`                                                                                                   | PASS  |
| S1 race    | `place-answer-reader.spec.ts` → "S1 race: the allowance timer decides timeout before it aborts (rejects on cancel / ignores cancel), whatever the wall clock reads" (fake `setTimeout` only, `Date.now` pinned)                                                                                            | `expected 'read_error' to be 'timeout'`                                                                                                                                                                         | PASS  |

Fail-before logs (local scratchpad, not in the repo): `/private/tmp/claude-501/-Users-maxnguyen-MyWorks-GoGo/3887d62f-9086-42b1-acb1-ae3d94169004/scratchpad/be873/f4-before.log`,
`/private/tmp/claude-501/-Users-maxnguyen-MyWorks-GoGo/3887d62f-9086-42b1-acb1-ae3d94169004/scratchpad/be873/f23-before.log`, `/private/tmp/claude-501/-Users-maxnguyen-MyWorks-GoGo/3887d62f-9086-42b1-acb1-ae3d94169004/scratchpad/be873/int-fence-before.log` (the integration log is the
second run: the first was overwritten when the leak assertions were made
`expect.soft` so all of them report). The spec files were prettier-formatted
after these runs; no assertion changed.

Fail-before runs (unchanged production code): reader spec 2 failed / 35 passed,
exit 1; service spec 9 failed / 24 passed, exit 1; new integration spec 6 failed
/ 1 passed, exit 1 (the passing cell is the non-QA control "a recommendation
stopped at the same point is not fenced"). Supplementary cells added with the
fix (not fail-before evidence): admission-fence unit tests in
`place-qa.service.spec.ts` and `assistant-turn-runner.spec.ts`.

The new public regressions live in their own spec because
`assistant-place-qa-s3.int.spec.ts` is byte-bound to the base/head Layer A
evidence (`place-qa-layer-a-base.sh` overlay hash); that file is unchanged. The
recorded head evidence above is for `e320db61` and is **not** relabeled: Layer A
on this revision is the integration row below, and the base/head pair must be
re-recorded by DEV on the commit that carries this round.

### Gates on the fix-round worktree

Run on the dirty worktree over `1c2dc953` (2026-11-11/12, local, Docker 29.7.2). All
rows ran serially on one frozen tree: SHA-256 of `git diff --binary HEAD`
(excluding this document) followed by the untracked fence spec was
`b5bd111c95a6ffb08b78d40f9674735f3506767bed445268da45c0a205fb94ce` before and
after the runs.

| Command                                                                                                                                                           | Exit  | Result                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `pnpm -s typecheck`                                                                                                                                               | 0     | all packages                                                                                           |
| `pnpm -s vitest run --project unit`                                                                                                                               | 0     | 343 files, 4,861 tests passed                                                                          |
| `pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/assistant-place-qa-s3.int.spec.ts apps/api/test/assistant-place-answer.int.spec.ts` | 0     | 2 files, 428 tests passed (Layer A spec bytes unchanged)                                               |
| `pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/assistant-place-qa-s3-fence.int.spec.ts` (extra)                                    | 0     | 8 passed (one earlier attempt was BLOCKED by a Testcontainers reaper port timeout before any test ran) |
| `prettier --check` / `eslint` on the nine touched `.ts` files and this document                                                                                   | 0 / 0 |                                                                                                        |
| `pnpm -s api:check`                                                                                                                                               | 0     | generated declarations match; no contract change in this round                                         |

NOT RUN: base-side Layer A (`place-qa-layer-a-base.sh`), remote CI, any DEV
deployment or flag change.

### Residuals for the owner / SA

- **Flag-on behaviour change for bare text (pinned by a test).** With the flag
  on, any short topicless text is a name-only probe. At `1c2dc953` it was fenced
  only while the resolver probe ran; it is now fenced from admission. A bare
  non-QA reply (e.g. "Cầu Giấy" answering a recommendation's area question)
  that is stopped, or fails funding/kill switch, before the probe can clear it
  stays `place_qa`: it is absent from recommendation history, reads as the
  load-error notice, and a repeated bare reply is then answered as QA control
  (`stale_choice`, zero model calls). An explicit request recovers. Flag off is
  unaffected. Narrowing it either re-opens Sol F-01 for genuine name-only QA or
  moves the probe into admission; both are shape decisions.

- A process that dies between the send's commit and the end of `admit` (a few
  DB reads) still leaves that one turn unfenced when the reaper ends it.
  Closing it needs the fence inside the admission transaction, which shape
  §3.1 keeps unchanged ("Admission stays outside and unchanged").
- Sol F-02 as instructed accepts the bare ordinal for a singleton confirm. An
  old client that taps a chip of an **earlier** choice message ("1") after a
  confirm for another candidate is read as confirming the shown candidate
  (§4.5 "never silently choose a different latest branch"). The alternative is
  an explicit emitted confirm text; that changes the S1 reader output.

## Fable fix round 2 (2026-11-12, after the round-3 confirm reviews)

Starting head: `0dd18c5e960eaba931224eb71a762f5cb6ddb8cb` (round 1 = `5b14af7e`,
docs only after). Authority: the round-3 outputs of Sol and Astra, shape rev3
§§3.1, 3.2, 4.3, 4.5, and the owner's "Fable sửa thêm lượt". Worktree changes
only; no commit. Every regression below ran first against unchanged `0dd18c5e`
production code (FAIL) and then against the fix (PASS). The round-1 section
above is left as written; where this round replaces a round-1 mechanism or
residual, this section says so.

### Shape of the fix

Round 1 wrote the fence in a pre-funding `admit` step. That step is **removed**.
The association now has three parts:

1. **Marker at the send's commit.** `qaProbeOf(text, context, locale,
structured)` is a pure function (no read). The send passes its result to
   `insertTurn`, which writes it into the assistant row's trace in the same
   INSERT of the same admission transaction: `control` → `route: place_qa`
   immediately (a structured follow-up is QA control in every flag state);
   `question` / `name` / `reply` → provisional `qaProbe`; an explicit
   recommendation/action/guide → nothing. Admission checks, funding, limits,
   locks and the number of statements are unchanged.
2. **Decision inside the guarded producer.** `PlaceQaService.handle` reads the
   flag and the latest turn exactly where `1c2dc953` did, inside the first-text
   guard and under the turn's signal. A bare name is a probe: no fence write
   and no in-memory route until the whole text equals an exact canonical name.
3. **Settlement in the one terminal write.** `finalizeMessage` always strips
   `qaProbe`. When the producer never reached its decision (stop, kill switch,
   funding failure, crash + reaper, stop fallback) the same UPDATE decides from
   durable facts: `question` + flag on → `place_qa`; `name`/`reply` → `place_qa`
   only when the previous assistant turn is `place_qa` (typed QA control);
   everything else → ordinary. It never promotes a row whose producer already
   published ordinary frames (`streamRoute: ordinary`) or dispatched a model
   call. The history and episode filters also exclude a terminal row that still
   carries a marker, so a pair is excluded until resolved; a marker on a
   streaming row hides nothing (its own turn needs its question).
4. **Settlement before the ordinary timeout reply.** When the first-text
   deadline passes with the decision still open (a stalled flag, latest-turn or
   probe read), the orchestrator settles the marker with the same durable-fact
   rule (`settleQaProbe`, one UPDATE; one flag read bounded at 1.5 s for a
   `question` only) before it publishes anything. A QA turn then fails through
   the QA error path; only an ordinary turn gets the ordinary timeout reply.
   Without this step the timeout reply published ordinary frames and the pair
   stayed in history (measured on the intermediate worktree, below).

| Round-3 finding                                          | Change                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol F-02 / Astra F-01 (P1) crash window send → fence     | Parts 1 and 3. No instant exists after the commit at which a QA turn is unmarked. The reaper and the stop fallback settle the marker in their own terminal statement.                                                                                                                                                                                                       |
| Sol F-03 / Astra F-02 (P2) name probe captures replies   | Part 2. `clearPlaceQa` and the mark-then-clear path are gone. An interrupted or unqualified probe ends ordinary: in history, and the next reply is an ordinary continuation. The round-1 residual test now asserts preservation.                                                                                                                                            |
| Sol F-01 / Astra F-03 (P1/P2) stale ordinal confirms     | A bare ordinal is never terminal. A one-candidate `place_confirm` option now emits `Xác nhận <name> (<6 digits>)` / `Confirm <name> (…)`; the code is derived from the confirmation message id and the place id, so only that message's chip matches. The exact candidate name still confirms (no loop). A present-but-wrong code is rejected outright, never name-matched. |
| Sol F-04 / Astra F-04 (P2) reads outside deadline/cancel | `admit` removed: the runner awaits nothing QA-related before `runnableFunding`. Flag and latest-turn reads are back under the first-text guard. The only remaining QA read outside it is the terminal write's flag read for an undecided `question` marker: bounded at 1.5 s, cannot fail the write, unknown reads as enabled.                                              |

### Changed expectations in this round

- `place-qa.service.spec.ts`, round-1 describe "Sol F-01: admission fence before
  cancellable work" (4 cells on `admit`): replaced by "fence decisions stay
  inside the guarded producer". `admit` no longer exists (Sol F-04 / Astra F-04).
- `assistant-turn-runner.spec.ts`, round-1 describe "QA admission precedes
  cancellable work": replaced by "no QA await before funding; the terminal
  write settles the marker". Existing A-R-11 reaper cell: the options object
  now also carries `qa: { decided: false, enabled: false }`.
- `assistant-place-qa-s3-fence.int.spec.ts`: the round-1 residual cell "a bare
  non-QA reply … stays fenced (known flag-on residual)" is flipped to "… keeps
  ordinary history and continuation" (Sol F-03 / Astra F-02).
- Reader output: the `text` of a one-candidate `place_confirm` option (was the
  ordinal). Labels, ids and every multi-candidate option are unchanged. No
  existing reader assertion changed.
- Removed repository method `clearPlaceQa` (no caller left: nothing is fenced
  before qualification, so nothing is cleared).
- The fence spec's fixture sets `ASSISTANT_FIRST_TEXT_TIMEOUT_MS=4000` so the
  deadline cells are affordable; no existing cell depended on the default.
- No Layer A expectation, corpus or fixture changed; the Layer A spec bytes
  are unchanged.

### Regression tests, fail-before on `0dd18c5e` / pass-after

| Finding       | Test (`assistant-place-qa-s3-fence.int.spec.ts` unless noted)                                                                                                                                           | FAIL on `0dd18c5e`                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash window  | "a question / typed reply to the latest QA turn / structured control whose process dies before any fence write stays out of history and model requests" (runner never starts, lease lapses, `reap()`)   | trace `{ orphaned, questionMessageId }` with no `route`; user row id in `repo.history`; Jev/Haiku capture matches `/Quán Sao Lạ\|Không phải các quán/` and differs from clean |
| Name probe    | "a bare non-QA reply stopped before the name-only probe keeps ordinary history and continuation"                                                                                                        | `expected 'place_qa' to be undefined`; user row missing from history; repeat reply is QA control with zero model calls                                                        |
| Stale ordinal | "a stale ordinal from the earlier choice never confirms the other branch (round 2)"; unit `place-qa.service.spec.ts` → "round 2: a stale ordinal of the earlier choice never confirms the other branch" | `expected 'answer' not to be 'answer'` (branch B answered on A's chip "1")                                                                                                    |
| Stalled reads | "flag off, recommendation / flag on, QA question: a stalled placeQaEnabled / latestAssistant read cannot hold a Stop" (4 cells)                                                                         | Stop returned after the 5 s wait (`expected 5022 to be less than 4000`), row still `streaming` in the flag-off `placeQaEnabled` cell                                          |

Fail-before runs: fence spec 9 failed / 11 passed, exit 1; service spec 1
failed / 39 passed, exit 1. Logs (local scratchpad, not in the repo):
`/private/tmp/claude-501/-Users-maxnguyen-MyWorks-GoGo/3887d62f-9086-42b1-acb1-ae3d94169004/scratchpad/be873/r2-int-before.log`
and `…/be873/r2-unit-before.log`. Spec files were prettier-formatted after
those runs; no assertion changed.

Deadline cells ("first-text deadline with the QA decision still open", 4
cells) were added after the first round-2 implementation and were **not run on
`0dd18c5e`** (there `admit` awaits the stalled read outside every deadline, so
the turn never ends). On the intermediate worktree, before part 4, the two QA
cells failed: status `fallback`, trace `{ deadline: 'first_text', … }` without
`route`, user row in `repo.history`, capture matching `/Quán Sao Lạ|Không phải
các quán/`; log `…/be873/r2-deadline-intermediate.log`. After part 4: 4 passed.
The confirm-text lexicon cell was mutation-checked: without the `isTypedConfirm`
override in `continuesQa`, 2 of its 3 names fail.

Cells added with the fix (not fail-before evidence): preservation after the
same death for a flag-off question, flag-off and flag-on bare replies and an
explicit recommendation (all end unmarked and in history); a flag read that
never returns cannot hold a Stop and fails closed; a flag-off question that
already ran the ordinary path is not promoted when the flag flips; unit cells
for `qaProbeOf`, the unqualified/failed probe, the single first-text deadline
over stalled reads (both read kinds), `confirmCode`, and the runner's terminal
options.

### Gates on the round-2 worktree

Dirty worktree over `0dd18c5e` (2026-11-12, local, Docker 29.7.2). All rows ran
serially on one frozen tree: SHA-256 of `git diff --binary HEAD` (excluding
this document) was
`7da94fecd0436603534fff74447c253aa0faa16319e4392bb584743d805403a5` before and
after.

| Command                                                                                                                                                                                                                                                                                   | Exit  | Result                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------ |
| `pnpm -s typecheck`                                                                                                                                                                                                                                                                       | 0     | all packages                                                                   |
| `pnpm -s vitest run --project unit`                                                                                                                                                                                                                                                       | 0     | 343 files, 4,890 tests passed                                                  |
| `pnpm -s vitest run --project integration --no-file-parallelism` on `assistant-place-qa-s3`, `assistant-place-qa-s3-fence`, `assistant-place-answer`, `assistant`, `assistant-credit-settlement`, `assistant-credit-spend-admission`, `assistant-credit-spend-migration` (`.int.spec.ts`) | 0     | 7 files, 538 tests passed; fence spec = 26 cells; Layer A spec bytes unchanged |
| `prettier --check` / `eslint` on the 14 touched `.ts` files; `prettier --check` on this document                                                                                                                                                                                          | 0 / 0 |                                                                                |
| `pnpm -s api:check`                                                                                                                                                                                                                                                                       | 0     | no contract change in this round                                               |

NOT RUN: `assistant-frame-buffer-redis.int.spec.ts` (needs Redis) and
`assistant.live.int.spec.ts` (needs live provider keys; it does exercise Stop),
base-side Layer A, remote CI, any DEV deployment or flag
change. The recorded Layer A head evidence is for `5b14af7e` and is not
relabeled; the base/head pair must be re-recorded on the commit that carries
this round.

### Residuals for the owner / SA (round 2)

- **Fail-closed corner.** A QA-shaped question sent while the flag is off ends
  `place_qa` only if all three hold: the turn ends before the producer decides,
  and the terminal write's flag read fails or exceeds 1.5 s. The alternative
  (fail open) re-opens the leak for a real QA question during a flag-read
  outage.
- **Flag flip inside one turn.** An undecided `question` turn is settled with
  the flag value at its terminal write, not at its send. A turn that already
  published ordinary frames or dispatched a model is never promoted.
- **Confirm text is new user-visible copy.** An old client's bubble shows
  e.g. `Xác nhận Song Ngọc (482913)`. The code makes the text unique to one
  confirmation message; an unrelated confirm text matches with probability
  1e-6. Wording and the visible code are an owner copy decision; structured
  clients are unaffected.
- **Deadline settlement and the fail-closed corner.** With the flag off, a
  QA-shaped question whose flag read stalls past the first-text deadline AND
  past the 1.5 s settlement bound ends `failed` and fenced instead of getting
  the timeout reply. Every other flag-off turn keeps the timeout reply.
- **Probe read error.** A resolver error during a bare-name probe fails the
  turn (as before) but the failed turn is now ordinary, not QA (§3.1: nothing
  qualified the name; §4.3 row 1: never "not found"). Pinned by a unit test.
- The stricter typed fallback means repeating a bare ordinal at a one-candidate
  confirmation re-asks instead of answering.
- **Mixed-version window / rollback.** Only this revision's terminal write
  strips `qaProbe`. If an instance on an older build ends a turn that a newer
  instance admitted (its reaper or stop fallback), the terminal row keeps the
  marker and that pair stays out of recommendation history even when it was an
  ordinary bare reply. Over-exclusion only, never a leak; DEV is one instance.
  No migration; rollback is the previous build.

## Astra fix round (2026-11-12, owner-authorized shape amendment + implementation)

BASIS: clean `00f691f14630f3bafebf5c151017a9a4009a5514`; all four DEV/SA
review rounds, rev3, this document's Fable rounds, owner decisions 2026-11-11/12.
No commit, push, merge, deploy, GitHub write or flag enablement. S3 stays dark.

The normative amendment is
[sa-shape-be-844-ai-place-qa.rev3-amend-s3.astra.md](sa-shape-be-844-ai-place-qa.rev3-amend-s3.astra.md).
It was written before implementation. The requested parent-workspace destination
`dev/handoffs/sa-shape-be-844-ai-place-qa.rev3-amend-s3.astra.md` is outside this
session's writable roots, so this worktree copy is the deliverable awaiting
placement there. No attempt was made to bypass that filesystem restriction.
The later amendment supersedes the conflicting Fable residuals above; their
historical evidence is not relabeled as current.

### Decisions, implementation and per-finding proof

| Round-4 finding          | Amendment and implementation                                                                                                                                                                                                                                                                                                                                                                           | Regression proof / DEV cell                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEV F-01 P1              | Protect the grammatical name span before interior recommendation matches; actual imperative heads and outside command clauses still win. `qaProbeOf` uses the same rule.                                                                                                                                                                                                                               | A1 classifier: Vietnamese name-prefix/suffix examples, English name with `Suggest and Find`, action-word preservation and external-command negatives. Four intended symptom failures on base; all nine cells pass after. Public A1 cells (two names) await DEV.                                                                                                                                                                                                                                                                 |
| DEV F-02 P1              | Remove FNV/modulo codes. Render full name + area, validate against the latest singleton and a complete canonical-name family, re-ask on duplicate/overflow/missing/oversized identity. Bare names/ordinals only re-confirm. Recognize stale full/legacy confirmation text as control; never send it to a model.                                                                                        | A2 copy, duplicate-label and concrete collision regressions fail before/pass after. Old `(0000018d-0000-4000-8000-00000000000b, FIXTURE_A)` and latest `(000009f8-0000-4000-8000-00000000000b, FIXTURE_B)` both produce **574568** on base: A's chip incorrectly answers B. After: retry, no answer. Additional unit coverage: other-area stale text, missing/long labels, stale source, and command words inside names. DEV: existing old-client/legacy-district/structured cells, with identical labels now requiring re-ask. |
| DEV F-03 P2 + SA F-04 P2 | Explicit new ordinary commands bypass flag/latest/source/catalogue/taxonomy reads in both states. Fresh factual questions skip latest; disabled flag takes the ordinary path. Structured/full typed control precedence is retained.                                                                                                                                                                    | A3: four failed-dependency bypass cells plus two fresh-question flag states fail before/pass after. Request-shape equality and all 156 intent preservation cases pass in the full unit run; vi-065 remains QA only while enabled. Public A3 flag-off/on cells await DEV.                                                                                                                                                                                                                                                        |
| SA F-01 P1               | Raise deployment/rollback floor to marker-aware readers/recovery. Pause sends, drain old instances, deploy/verify the floor everywhere, then resume. No pre-floor mixed deployment or previous-build rollback, even with flag off. Updated runbook and ADR-0055.                                                                                                                                       | **A4 integration NOT RUN.** New admission → legacy-style finalization → old predicate demonstrably includes the question, whereas floor history/episode readers and following model requests exclude it. This is a deployment-policy correction: no claim that the already marker-aware `00f691f1` predicate newly fails. DEV must execute A4 and provide instance/floor evidence; an old-reader combination remains prohibited, not made safe by this code.                                                                    |
| SA F-02 P2               | One absolute 1.5-second cleanup budget includes flag, pool, UPDATE and commit; unknown recovery flag gets at most half the budget so settlement has time left. Stop/ceiling propagates abort. Reuse the bounded DB transaction/connection-destruction mechanism, preserving read-only behavior for S1/S2 callers. On interruption retain provisional exclusion, never set a QA route from uncertainty. | A5 stalled UPDATE, both flag states: pending forever on base, bounded rejection after. Supplementary unit cases cover Stop/ceiling signals, late completion, uncertain terminal options, pool wait and no late commit. DEV A5: four flag × Stop/ceiling cells and actual row-lock timeout/cancellation.                                                                                                                                                                                                                         |
| SA F-03 P2               | Unknown/rejected/timed-out flag means disabled, not enabled; latch that decision through producer failure/Stop/deadline. Recovery samples only without a producer observation. No QA await before funding.                                                                                                                                                                                             | A6 producer rejection and recovery rejection fail before/pass after. Additional units cover 1.5-second stall, late true, observed false, runner failure, and orphan recovery. DEV A6: failed flag during crash/reaper; existing stalled-flag Stop cells now require ordinary history.                                                                                                                                                                                                                                           |

The existing first-text guard was moved unchanged to `first-text-guard.ts`
and re-exported from the orchestrator, avoiding a service/orchestrator runtime
import cycle when QA and terminal recovery reuse it. No admission statement,
funding policy, fact eligibility rule, resolver threshold, wire field, contract
version or model request shape changed. Contract remains `10.2.0-alpha.1`.

Changed old expectations are intentional and limited to the amendment: coded
confirm copy and bare-name confirmation, identical-label ambiguity, stale text
for the same uniquely identified branch, disabled default on flag errors, and
QA reads that the new fast path no longer invokes. The per-turn service fixture
now gives each turn its own deadline (its prior constant deadline expired when
TTL tests advanced the clock); source/topic/expiry assertions remain intact.
Only the fence spec's local setup/expectations changed, never Layer A data.

### Identical regression specs on base and fixed production

Command: `pnpm -s vitest run --project unit
libs/modules/assistant/domain/place-qa/classifier.spec.ts
libs/modules/assistant/application/place-qa.service.spec.ts
-t 'Astra A1|Astra amendment regressions'`.

The final specs were retained unchanged while each modified tracked production
TypeScript file was temporarily restored from `git show 00f691f1:<path>`.
A `finally` block restored every saved worktree byte before the after run; no
checkout/index/commit was changed. Manifest checks both restoration and identical
test hashes. New extracted guard files are unused by the original production.

- Base: **17 failed / 5 passed**, exit **1**, at behavioral assertions (not setup/import errors).
- Fixed: **22 passed**, exit **0**. Five base passes are preservation controls.
- Before/after logs: `/private/tmp/be873-astra-final-before.log`, `/private/tmp/be873-astra-final-after.log`.
- Manifest: `/private/tmp/be873-astra-regression-manifest.json`.
- Supplementary lifecycle/reader/runner units pass in the full run below; they are not relabeled as this 22-cell fail-before comparison.

### Gates on the final worktree

| Command                                                                        | Exit | Actual result / log                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -s typecheck`                                                            | 0    | All 8 packages pass. Shared-cache write warnings from the sandbox only. `/private/tmp/be873-astra-typecheck.log`                                                                                                                 |
| `pnpm -s vitest run --project unit`                                            | 1    | **4,920 passed, 1 skipped; 342 suites passed.** `apps/api/src/sentry-request.spec.ts` cannot set up its listener: `listen EPERM 127.0.0.1`. Environment-blocked suite, not a green full run. `/private/tmp/be873-astra-unit.log` |
| ESLint on all touched TypeScript                                               | 0    | `/private/tmp/be873-astra-eslint.log`                                                                                                                                                                                            |
| Prettier on all touched TypeScript/Markdown                                    | 0    | `/private/tmp/be873-astra-prettier.log`; appendix checked after insertion                                                                                                                                                        |
| `pnpm -s api:check`                                                            | 0    | Generated declarations match. `/private/tmp/be873-astra-api-check.log`                                                                                                                                                           |
| `git diff --check`                                                             | 0    | No whitespace errors                                                                                                                                                                                                             |
| `vitest list --project integration ...assistant-place-qa-s3-fence.int.spec.ts` | 0    | **37 cells collected**, not executed. `/private/tmp/be873-astra-integration-cells.log`                                                                                                                                           |
| `docker info`                                                                  | 1    | Permission denied at `/Users/maxnguyen/.docker/run/docker.sock`. `/private/tmp/be873-astra-docker.log`                                                                                                                           |

Protected SHA-256 values match `00f691f1` byte for byte:

- Layer A spec: `9c504fcd4f14502e84dd24b6a4a41bb9ce04d3ea12ac1f08be41dde96d59f5a3`.
- QA cases: `c8a3d1005830e8df53e46be7964f72fdea0e6c4b8d400a23038728a588cbb39f`.
- QA fixtures: `789eee8cd81519e179b22499ef28908fa142edf7eae0f89b1f3dff87aa4fb634`.
- Intent cases: `48c1cc3317309907d43235f6f5425252d8eca83cca1799fd3b562204217ba6a6`.

### DEV handoff and NOT RUN

Run on this dirty source snapshot (bind a source manifest), or the later commit
that includes it, then repeat the existing hash-bound Layer A base/head procedure:

```sh
pnpm -s vitest run --project integration --no-file-parallelism \
  apps/api/test/assistant-place-qa-s3-fence.int.spec.ts \
  apps/api/test/assistant-place-qa-s3.int.spec.ts \
  apps/api/test/assistant-place-answer.int.spec.ts \
  apps/api/test/assistant.int.spec.ts \
  apps/api/test/assistant-credit-settlement.int.spec.ts \
  apps/api/test/assistant-credit-spend-admission.int.spec.ts \
  apps/api/test/assistant-credit-spend-migration.int.spec.ts
```

Every fence cell must pass; prioritize A4 (unsafe old-reader predicate versus
supported floor), A5 (actual row lock and flag × Stop/ceiling), A1 public routing,
A3 failure-path bypass, A6 orphan recovery, and text-only confirmation including
duplicate labels. The prior 417/417 Layer A evidence is historical, not acceptance
of this worktree. Unit preservation/request equality is green; rendered/public
preservation on this source snapshot remains NOT RUN.

NOT RUN: all Docker integration execution, new Layer A base/head reports,
Redis/live-provider suites, remote CI, deployed-instance reader-floor inventory,
DEV/simulator acceptance, S4/S5 acceptance, deployment or flag changes. No external
agent or provider was started. Source manifest and diff digest:
`/private/tmp/be873-astra-source-manifest.json`.

Open questions: none requiring a new owner product decision. Outstanding work is
DEV integration/release-floor evidence and independent review, plus placing the
amendment at its requested parent-workspace handoff path. This report is not a
clean review verdict, merge instruction or DEV acceptance.

### DEV run of the Astra round (2026-11-12, `3fa56ecf`)

| Check                                                                                               | Result                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Fence spec `assistant-place-qa-s3-fence.int.spec.ts` on `00f691f1` production code (spec copied in) | 15 failed / 22 passed, exit 1 (A1 ×2, A3 ×2, A5 ×5, A6, stale-ordinal and typed-confirm cells, stalled-flag cells) |
| Same spec on `3fa56ecf`                                                                             | 37 / 37 PASS                                                                                                       |
| Integration, 13 assistant/place/privacy-export files                                                | 615 PASS, 21 skipped (pre-existing conditional suite)                                                              |
| Layer A head / base `d2d41184`                                                                      | 417/417; base incidents 4/4 FAIL at symptom, preservation 187/187 both                                             |
| Build, full unit, api:check                                                                         | PASS (unit 343 files / 4921)                                                                                       |

Logs: GoGo workspace `dev/test-evidence/be-864/r5/` (incl. `fence-before-00f691f1.log`). NOT RUN: frame-buffer Redis and live-provider suites.

## Sol fix round (r5)

2026-11-12. Owner authorized “Sol sửa”; basis: clean `df134cf0` (production
`3fa56ecf`), DEV r5 findings F-01/F-02 and the Astra S3 amendment, especially A6.
Edits only; no commit, push, deployment or flag enablement.

- **F-01:** persist the producer's boolean flag observation as immutable
  `trace.qaEnabled` immediately after the read, before further QA work or ordinary
  dispatch. The write uses the existing cancellable transaction with one bounded
  pool/lock/UPDATE/commit allowance, capped by the turn deadline. Orphan recovery
  consumes the recorded observation without a new flag read; terminal and deadline
  SQL settlement also prefer the stored boolean over a stale caller's value.
  Missing observations retain the existing bounded, disabled-default recovery.
  Unequivocal ordinary commands still bypass flag/latch/latest/catalogue reads.
- **F-02:** rebuild both singleton and canonical-family confirmation identities
  with the emitting message's `latest.locale` (default `vi`), preserving the exact
  emitted text across an omitted or changed follow-up locale. Response rendering
  still uses the current request locale.
- Unit regressions cover both observed values, ordering before route/frames,
  deadline/Stop during a stalled latch, the ordinary fast path, orphan recovery
  without resampling, and English confirmation followed by default/changed locale.
  The conversation fixture now retains each emitting message's locale.
- Eight new fence integration cells cover both crash/reaper flip directions
  before route/frame/provider dispatch; durable SQL precedence with stale terminal
  and deadline recovery values (including rejected latch overwrites); and both
  English chip locale round trips. These cells are collected, **NOT RUN** locally.

### Regression proof and checks

New focused regressions were run before production edits and after the fix with
the same assertions. Command:

```sh
pnpm -s vitest run --project unit \
  libs/modules/assistant/application/place-qa.service.spec.ts \
  libs/modules/assistant/application/assistant-turn-runner.spec.ts \
  -t 'Sol fix round \(r5\)|r5 orphan'
```

Before: **8 failed / 1 passed**, exit **1**, at the missing-latch/cancellation,
orphan-resampling and confirmation-retry assertions. After: **9 passed**, exit
**0**. The passing base cell preserves the unequivocal ordinary fast path.
Logs: `/private/tmp/be873-sol-r5-before.log`,
`/private/tmp/be873-sol-r5-after.log`.

| Check                                                              | Exit | Result / evidence                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -s typecheck`                                                | 0    | All 8 packages pass; sandbox shared-cache write warnings only. `/private/tmp/be873-sol-r5-typecheck.log`                                                                                                                   |
| `pnpm -s vitest run --project unit`                                | 1    | **4,929 passed, 1 skipped; 342 suites passed, 1 failed.** `apps/api/src/sentry-request.spec.ts` cannot bind `127.0.0.1`: `listen EPERM`. Full unit is environment-blocked, not green. `/private/tmp/be873-sol-r5-unit.log` |
| Focused service, runner, request-shape and classifier suites       | 0    | **391 passed.** `/private/tmp/be873-sol-r5-focused.log`                                                                                                                                                                    |
| ESLint on all 6 touched TypeScript files                           | 0    | `/private/tmp/be873-sol-r5-eslint.log`                                                                                                                                                                                     |
| Prettier check on all 7 touched TypeScript/Markdown files          | 0    | `/private/tmp/be873-sol-r5-prettier.log`                                                                                                                                                                                   |
| `pnpm -s api:check`                                                | 0    | Generated declarations match. `/private/tmp/be873-sol-r5-api-check.log`                                                                                                                                                    |
| Fence integration collection (`vitest list --project integration`) | 0    | **45 cells collected**; no execution. `/private/tmp/be873-sol-r5-integration-cells.log`                                                                                                                                    |
| `rtk docker info`                                                  | 1    | Permission denied at `/Users/maxnguyen/.docker/run/docker.sock`. `/private/tmp/be873-sol-r5-docker.log`                                                                                                                    |
| Protected-file byte/hash comparison with `HEAD`                    | 0    | Layer A spec, QA cases/fixtures and intent corpus unchanged, including the four recorded hashes above. `/private/tmp/be873-sol-r5-protected.json`                                                                          |
| `git diff --check`, source snapshot verification                   | 0    | No whitespace errors; source snapshot matches.                                                                                                                                                                             |

The full unit run includes all **156 preserved intent cases**, the approved
**vi-065** classification/flag-state checks and complete Jev/Haiku request-byte
equality. Those unit checks pass; public Layer A acceptance is **NOT RUN** on this
snapshot. `apps/api/test/assistant-place-qa-s3.int.spec.ts` and all Layer A
corpus/fixture files remain byte-identical to `HEAD`.

Final source snapshot: `rs-e861ead2cf27`, manifest and retrievable diff at
`/private/tmp/be873-sol-r5-snapshots/be873-sol-r5-rs-e861ead2cf27/MANIFEST.txt`.
Scope: `apps`, `libs`, `openapi`; this validation appendix is outside that source
scope. Production and unit bytes are unchanged since their checks; the subsequent
changes only add fence integration assertions. Integration collection/lint/format
are checked on the final source snapshot.

**NOT RUN:** Docker integration execution (including all 45 fence cells and
hash-bound Layer A base/head comparison), Redis/live-provider suites, remote CI,
DEV acceptance, deployed-instance reader-floor verification, S4/S5 acceptance,
deployment and flag changes. DEV must execute the existing integration handoff
command above on this snapshot or the later commit containing it. The blocked
Sentry listener suite also needs execution in an environment permitting localhost
binds. S3 stays dark; these results do not establish release acceptance.

## Sol r5 continuation — English confirm fixture repair (2026-11-12)

Basis: `e8da1e33`; owner authorized edits without a commit for BE #873.
DEV's `dev/handoffs/be873f-int.log` reports both English cells failing at the
first-turn QA assertion. This is a test setup defect: Vietnamese question grammar
with `locale: en` selects the English lexicon, finds no price topic, and becomes a
`name_only` probe. Its extracted name differs from the whole question, so it cannot
qualify as exact canonical-name-only QA and falls through to ordinary handling.

The two cells now ask `Price of Quán Sao Lạ in Quận 1?` with `locale: en`.
The real classifier produces `named_place_question`, topic `price`, name
`Quán Sao Lạ`, stated area `in Quận 1`. The legacy-district rule in rev3 §4.4
forces a singleton confirm even for the exact name. The catalogue and current
commune/province facts already support the complete English identity chip; no
product change or protected Layer A fixture change is needed. First-turn checks
also require the expected singleton id, stored English locale, a nonempty area in
the English chip and zero model calls. Turn two still submits only that emitted
text with omitted or changed locale and requires `answer`, original price topic,
the same place id, stored Vietnamese locale, actual price text and zero model
calls. The service unit cells now exercise the same two-turn legacy-area setup
with the real classifier and resolution truth table.

**Before-code reasoning (`df134cf0`, not integration execution):** classifier,
span, resolution and send-default code are unchanged between that base and
`e8da1e33`, so the corrected first turn reaches the same English singleton
confirm. On turn two, omitted locale defaults to `vi`; explicit changed locale is
also `vi`. The base's two `confirmText(input.locale, ...)` calls reconstruct
`Xác nhận …` rather than the emitted `Confirm …`. The first identity comparison
fails, leading to retry instead of answer. Thus the unchanged F-02 answer
assertion fails for the intended locale reason. The fixed code uses the emitting
message's `latest.locale` at both identity checks.

| Check                                              | Exit | Result                                                                                                 |
| -------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `pnpm -s typecheck`                                | 0    | All 8 packages pass; sandbox cache-write warnings only. `/private/tmp/be873-sol-r5-cont-typecheck.log` |
| Unit service + classifier suites                   | 0    | 357 passed. `/private/tmp/be873-sol-r5-cont-unit.log`                                                  |
| Prettier + ESLint on both touched TypeScript files | 0    | Pass                                                                                                   |
| Fence integration collection                       | 0    | Both English cells collected. `/private/tmp/be873-sol-r5-cont-collection.log`                          |

Docker integration execution and base-code F-02 execution are **NOT RUN** here;
DEV will run them. These checks do not establish integration or DEV acceptance.
