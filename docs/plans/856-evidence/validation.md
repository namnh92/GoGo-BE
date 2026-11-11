# PR #860 round-3 validation (escalation fix)

Source snapshot: `c98432f8ccb2aec9a91a56b708b2e0268659a6dd7c54f8f411027acb967f55e3`

Basis: committed head `1dc9ac11f8e97fa3e64b7dbe49c8c856f36fef68` (the round-3
fixes, rebased after #858) on base `origin/re-design`
`09b865417949701c7793f53ce0feccbf21c7f6b9`, plus the uncommitted F-04 working
tree. The working tree is identified by content: `files.sha256` hashes every
manifest entry except itself, and the source snapshot above hashes the sorted
`sha256  path` lines of every manifest entry outside this evidence directory.
`changed-files.txt` is `git diff --name-only origin/re-design` plus untracked
files. The commit that lands this tree gets a new SHA;
`python3 docs/plans/856-evidence/verify-evidence.py` proves the committed
content is the content these results were measured on.

Every PASS below comes from one gate pass on the frozen tree, 2026-11-11. The
source snapshot was computed before and after that pass and did not move. Only
files in this evidence directory were written afterwards.

That pass was the second attempt on the same snapshot. The first attempt, run
while the machine's load average was about 200, had two failures: the
pre-existing timing budget in `grounding.spec.ts` ("S2-F-03 … stays cheap",
1351 ms against a 1000 ms limit) and a Testcontainers "ports not bound within
10000ms" start-up timeout in `assistant-frame-buffer-redis.int.spec.ts`
(4 tests skipped). Neither touches code changed here; both passed on the
second attempt with no source change in between.

The four items in the table were measured on the pre-rebase tree (head
`56df5af34bf33dcd756e3f1e0c0c4e06fb5f0acd`, base `66ff0ddc`); their FAIL-before
logs are from that tree. The F-04 section and every gate result are from this tree.

## Round-3 items

| Item                | Change                                                                                                                                                                                                                                                                                                                                                                                                                  | FAIL-before → PASS-after                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol confirm F-01 P1 | One validator, `answerMessageValidity`, behind every read surface. Search snippet and export now read the row's `trace` and apply the full grammar (`parseReferenceGroup`); the stored, truncated preview applies the text half (`referenceOnlyText`). An invalid message is one neutral label, `unknown_token`, no identity or fact read. `finalizeMessage` writes no preview for an invalid answer (`storedPreview`). | Unit: 24 failed / 9 passed before, 33 passed after. Integration (real DB, list, search, export): 2 failed before, both pass after. See the breakdown below.                                               |
| CI build TS6059     | `apps/api/src/assistant/assistant-stream-http.spec.ts` imported six lib files by relative path; `tsconfig.build.json` compiles specs under `src`, so the lib sources fell outside `rootDir`. The spec now imports from `@gogo/modules`, which exports those six symbols.                                                                                                                                                | `turbo run build --filter @gogo/api` on the clean head: exit 2, 122 × TS6059, no other error code (`round-3-fail-before-build.txt`, trimmed). After: `turbo run build --force` exit 0, 2 tasks, 0 cached. |
| CI contract-compat  | `dependentRequired` removed from `AssistantMessageSend`. Both-or-neither is stated in the schema and both field descriptions and enforced by the server. `openapi/gogo.v1.d.ts` regenerated; CHANGELOG and the plan corrected. Version stays `10.1.0-alpha.1`.                                                                                                                                                          | Contract test asserted the keyword's absence: failed before (`expected … to not have property "dependentRequired"`), passes after.                                                                        |
| Sol confirm F-02 P2 | This directory regenerated: manifest, hashes, this report, `review-basis.json`, verifier.                                                                                                                                                                                                                                                                                                                               | `verify-evidence.py` PASS on the final tree.                                                                                                                                                              |

### Sol confirm F-04 P2 (added after the rebase)

A direct price question, or one side of a price comparison, with no eligible
verified price now renders the permitted wording plus the generic card pointer
(`templates.ts`, rev3 §3.5 / owner Q-2), in vi and en. Cards and every other
surface still omit an unknown price. Four new tests (direct vi/en in
`templates.spec.ts`; one-missing-side comparison vi/en in
`place-answer-reader.spec.ts`) failed on the wording assertion with
`templates.ts` reverse-applied and pass after: `round-3-fail-before-f04.txt`
(4 failed / 58 passed → 62 passed).

Two leftovers of the rebase conflict resolution failed gates on `1dc9ac11` and
are fixed here: an unused `flagEnvironmentOf` import in
`assistant-turn-runner.service.ts` (eslint; the base had removed its only use)
and four unformatted table rows in `docs/infrastructure.md` (prettier).

### How FAIL-before was measured

The new tests were kept and the eight fixed source files were reverse-applied
from a patch (`git apply -R`), the tests run, and the patch applied again. Logs:
`round-3-fail-before-unit.txt`, `round-3-fail-before-integration.txt`.

- Failed on a behavioural assertion (the defect itself): the stored-preview
  mixed-prose test (prose survived, identity read made); the five export cases
  (prose or a query label exported instead of one neutral label); both
  integration cases (malformed text copied to the stored preview); the contract
  keyword test.
- Failed because the fix's API did not exist yet (`answerMessageValidity`,
  `storedPreview`, or a row object passed to `renderPlaceTexts`): the five
  preview-write cases, the five snippet cases, the five agreement cases and the
  two positive controls. These prove the tests exercise the new code, not that
  the old code misbehaved in that exact way; the integration cases cover the
  same snippet and preview-write behaviour through the real paths.
- Passed before and after (pins, not regressions): the three "server refuses"
  cases. The strict send DTO already answered `400 VALIDATION_FAILED` for either
  reserved field, alone or paired. S1 keeps refusing the pair: accepting and
  ignoring it would run an ordinary turn. S3 owns acceptance.

## Gates on the final tree

| Command                                                                                                                                                                       | Result                                | Log                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------- |
| `pnpm -s turbo run build --force`                                                                                                                                             | PASS: 2 tasks, 0 cached               | `round-3-build.txt`                 |
| `pnpm -s turbo run typecheck --force`                                                                                                                                         | PASS: 8 packages, 0 cached            | `round-3-typecheck.txt`             |
| `pnpm -s vitest run --project unit`                                                                                                                                           | PASS: 4303 tests, 332 files           | `round-3-unit-full.txt`             |
| `pnpm -s vitest run --project integration --no-file-parallelism` on `assistant-place-answer.int.spec.ts`, `assistant.int.spec.ts`, `assistant-frame-buffer-redis.int.spec.ts` | PASS: 50 tests, 3 files               | `round-3-integration-assistant.txt` |
| same command on `privacy-export.int.spec.ts`, `privacy-export-round2.int.spec.ts`                                                                                             | PASS: 53 tests, 2 files               | `round-3-integration-export.txt`    |
| `pnpm -s api:check`                                                                                                                                                           | PASS                                  | `round-3-api-check.txt`             |
| `pnpm -s api:version <origin/re-design contract> openapi/gogo.v1.yaml`                                                                                                        | PASS: bumped to `10.1.0-alpha.1`      | `round-3-api-version.txt`           |
| `pnpm -s api:routes`                                                                                                                                                          | PASS, exit 0                          | `round-3-api-routes.txt`            |
| `pnpm -s check:boundaries`                                                                                                                                                    | PASS, exit 0                          | `round-3-boundaries.txt`            |
| `pnpm exec eslint <manifest TypeScript except generated d.ts>`                                                                                                                | PASS, exit 0                          | `round-3-eslint.txt`                |
| `pnpm exec prettier --check <manifest TS/MD/JSON/YAML except generated d.ts and this directory>`                                                                              | PASS, exit 0                          | `round-3-prettier.txt`              |
| oasdiff breaking report + `scripts/check-contract-compat.ts`                                                                                                                  | NOT RUN locally (oasdiff unavailable) | none                                |
| Full integration suite; CI on the committed head                                                                                                                              | NOT RUN                               | none                                |

Integration ran on local Docker (Testcontainers). The unit and integration logs
are condensed to their result lines; the logs say so in their second line.

The contract-compat gate needs an oasdiff report, and oasdiff is not installed
here, so that gate has no local result. What is known: CI run 42999657219 on
`56df5af` reported exactly two findings, both
`request-body-dependent-required-added` on
`POST /assistant/conversations/{id}/messages`. This tree removes that keyword
and otherwise changes only descriptions in the contract. That is a reason to
expect the gate to pass, not a measurement; CI on the committed head decides.

## Not covered by this round

- Sol proposed an `.github/oasdiff-exceptions.json` entry for the dependency
  keyword. The escalation instead removed the keyword, so no exception and no
  MAJOR are needed. This changes the contract Astra reviewed; the earlier
  `clean` verdict does not cover it.
- A stored preview has no trace, so a zero-query answer made only of prose
  cannot be recognized at read time. It is closed at write time:
  `finalizeMessage` keeps the previous preview for an invalid answer.

## Earlier rounds (historical, not results for this tree)

Files named `round-1-*` and the unprefixed logs are evidence for earlier
snapshots (round-1 fixes on the rebased tree; reviewed head
`89483f359cb173f6f574fe1c532c8fd2aba81abd` before that). Round 1 fixed Sol
F-01/F-02 and Astra F-01/F-02/F-03 with 11 failing-before assertions
(`round-1-fail-before.txt`). The 4227-unit and 48-integration totals quoted in
the round-2 reviews were reported by DEV for `56df5af` and were not produced in
this session. The first round-3 pass on the pre-rebase tree measured 4253 unit,
50 + 53 integration; this tree's results replace it.

## Integration files and what they cover

- `assistant-place-answer.int.spec.ts`: authorization, storage, SSE, history,
  CMS, export, retention, timeout/cancellation, deletion envelope parity,
  per-interval hours, route persistence, and the two round-3 malformed-answer
  cases (finalize → stored preview, list, search snippet, export).
- `assistant.int.spec.ts`: ordinary send/stream/stop, lifecycle, admission,
  conversation list and search.
- `assistant-frame-buffer-redis.int.spec.ts`: Redis sequencing and tombstones.
- `privacy-export*.int.spec.ts`: the sealed export that embeds assistant text.

## S2 integration boundary

Unchanged from round 1: S1's `PlaceFactsReader` is canonical; S2 adapts to
`{signal, deadlineAt}`, `ReadonlyMap`, per-interval evidence and rejection on
error or cancellation, binds `PLACE_FACTS_READER`, and emits no second duration
observation with `surface=projection`.
