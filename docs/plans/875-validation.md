# GoGo-BE#875 validation — uncommitted worktree

Basis: `586944a5`, branch `bugfix/GOGO-875-place-qa-exact-match`.
Product edits cover the QA name variants, Vietnamese topic/span grammar and
exact-candidate precedence over fuzzy overflow (owner decision 2026-11-12).
No commit, deployment, feature-flag update or external write was made.

## Diagnosis and change

1. **Dash-name exact lookup.** `normalizeVietnamese` preserves the en dash, while
   PostgreSQL `f_unaccent` stores it as ASCII `-`. `placeNameKey` only collapses
   whitespace; it cannot repair a query-side dash. `placeNameVariants` now folds
   en/em dashes to ASCII before all indexed exact and fuzzy reads, including
   alternate readings. No column expression/index migration is needed. Dashes
   are retained, not deleted, so a name with no dash stays a different identity.
   PostgreSQL 16's [unaccent rules](https://github.com/postgres/postgres/blob/REL_16_STABLE/contrib/unaccent/unaccent.rules)
   explicitly map both characters to `-`.
2. **Ticket-price span.** On the base classifier, `Giá vé … bao nhiêu?` produces
   the span `… bao nhiêu`: `vé` is already consumed by the generalized prefix's
   optional folded `ve`, but `bao nhiêu` has no suffix rule. The S2 extractor
   additionally does not recognize accented `vé` as grammar. Both grammars now
   recognize the whole `Giá vé [của]` head and `[là] bao nhiêu` tail. Longer
   whole-name readings remain exact probes, preserving topic words in names.
3. **Duplicate-name narrow: owner decision applied.** The 2026-11-12 BE#875
   entry in `dev/policy/decisions-log.md` amends rev3 §4.3: the complete exact
   lookup (§4.2, aliases included when available) takes precedence over fuzzy/FTS
   overflow. One exact candidate uses row 3, subject to §4.4; two or three use
   row 4 with only those exact cards; more than three narrow for an area.
   Overflow alone narrows only with no exact candidate. Ambiguous parsing and
   unresolved stated areas still narrow; legacy areas confirm; area mismatch
   offers a choice elsewhere without silently answering. S3 has no curated
   aliases. The indexed exact SQL channel stays separate from fuzzy retrieval;
   even a smaller caller fuzzy limit retains up to four exact rows (enough to
   distinguish a one-to-three candidate result from the narrowing boundary).
   The verbatim case 3 now has a service unit regression and an independent
   integration cell: two `The Workshop Coffee` rows plus ten non-exact
   `The Workshop Coffee Garden N` names. The cell asserts that all ten non-exact
   rows satisfy the actual fuzzy/FTS predicates at production thresholds and
   that the real resolver reports overflow before checking row 4, exact card
   identities in SSE/history and `place_choice`. It also checks a fuzzy limit
   of one cannot hide the second exact row. No live DEV candidate set was read.
4. **Typed confirmation retry.** The full emitted name + `·` + area phrase
   reconstructs correctly. Reader and service both use `PlaceFacts.areaLabel`,
   projected from the published current area summary plus province name, rather
   than the card's address or a mobile label. After phrase equality succeeds,
   the canonical-name family re-read uses the same broken dash variants, so no
   candidate is marked exact and confirmation retries. Fix (1) repairs this
   revalidation without weakening whole-phrase, expiry, publication, uniqueness,
   missing/long-area, duplicate-label or structured-source checks. A real reader
   chip round trip is covered by a unit service test and the new integration spec.

## Earlier cases 1/2/4 evidence (prior continuation)

- Tests were added before production edits. The initial four-spec unit run on
  unchanged `586944a5` product code exited **1**: **6 symptom failures, 432 passes**
  (three ticket-price classifier spellings, dash variants, S2 ticket span, typed
  confirmation retry). The pending-copy and two-exact-duplicate checks passed
  on base. Two additional service answer checks were added afterwards. A final replay
  of all nine focused specs against the three unchanged baseline product files
  exited **1** with **8 symptom failures and 678 passes**; production edits were
  restored in a `finally` block. Request-shape and intent preservation remained
  green on both versions.
- Focused final unit command: `pnpm exec vitest run --project unit
libs/modules/assistant/domain/place-qa
libs/modules/assistant/application/place-qa.service.spec.ts
libs/modules/assistant/application/place-qa-request-shape.spec.ts
libs/modules/assistant/domain/grounding.spec.ts` — exit **0**, **686 passed**.
  Includes request-shape equality, 156 intent preservation cases plus vi-065,
  pending guards, whole-name alternate readings and overflow preservation.
- Full unit: `pnpm exec vitest run --project unit` — exit **1**: 342 files passed,
  one socket-denied suite and one unrelated grounding timing failure at 1157 ms.
  Repeat with `--maxWorkers=2` — exit **1**: **343 files / 4944 tests passed**,
  one skipped test; only `apps/api/src/sentry-request.spec.ts` is blocked by
  `listen EPERM: operation not permitted 127.0.0.1`. Grounding timing passes.
  The later two service additions also pass in the final focused run above.
- `pnpm typecheck` — exit **0**, all eight packages. An earlier integration-test
  type error (missing required placeFacts read budget) was corrected before this pass.
- ESLint on touched TypeScript files — exit **0**.
- Prettier on all touched files — exit **0**.
- `pnpm api:check` — exit **0**.
- `git diff --check` — exit **0**.
- Integration before and after: `pnpm exec vitest run --project integration
apps/api/test/place-qa-875.int.spec.ts` — exit **1**, setup blocked with
  `Could not find a working container runtime strategy`; all four tests unexecuted.
  No FAIL-before/PASS-after integration claim is made. DEV must execute it with
  real PostGIS using the existing fixture's dedicated-database mechanism.

`assistant-place-qa-s3.int.spec.ts`, the Layer A corpus and its fixtures are
untouched. The new spec uses separate fictional dash, sibling and duplicate
fixtures and sends the singleton chip text without follow-up ids. It asserts
SQL normalization, row/outcome/card identity, SSE/history chip equality and zero
model calls. Integration and real DEV chat acceptance remain outstanding.

## Case 3 continuation — 2026-11-12

- Source: owner decision `dev/policy/decisions-log.md`, 2026-11-12,
  “BE#875: khớp đúng được ưu tiên hơn overflow (sửa shape rev3 §4.3)”.
- Baseline replay: restored `resolution.ts`, `span.ts` and `lexicon.vi.json`
  from **586944a5**, ran the new unit cells, then restored all three preserved
  worktree files byte-for-byte in `finally`. Command: `pnpm exec vitest run
--project unit libs/modules/assistant/domain/place-qa/resolution.spec.ts
libs/modules/assistant/application/place-qa.service.spec.ts -t
'GoGo-BE#875.*exact before|The Workshop Coffee'`.
  Exit **1**, **7 failed / 148 skipped**, including the verbatim question
  returning `narrow` instead of `choice`. Log: `/tmp/be-875-case3-baseline.log`.
- After patch: both full affected unit specs exited **0**, **155 passed**.
  Log: `/tmp/be-875-case3-after.log`. Coverage includes exact counts 1/2/3/4/8,
  fuzzy-only overflow, ambiguous parsing, unresolved/legacy/mismatched areas,
  and only the two exact cards for the verbatim case 3 question.
- Layer A expectation audit (read-only): no contradictory expectation found in
  `apps/api/test/assistant-place-qa-s3.int.spec.ts` or its corpus/fixtures.
  `overflow-narrow` asks about `Bát Diệp`; its fixture has **nine identical
  exact names**, so it still narrows under the >3-exact rule. `Song Ngọc`
  has two exact rows and still chooses; typo cases have no exact candidate.
  These files remain untouched. This audit does not claim a Layer A runtime pass.
- Integration before/after: exit **1**, setup blocked by
  `Could not find a working container runtime strategy`; all **five** cells
  unexecuted after patch. No accessible Docker socket or configured dedicated
  test database is available in this sandbox. The new integration cell carries
  assertions for genuine fuzzy overflow, but **integration FAIL-before/PASS-after
  remains unverified**. Logs: `/tmp/be-875-case3-int-before.log`,
  `/tmp/be-875-integration-final.log`.

Final checks for this continuation:

| Command                                                                                           | Exit  | Result                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                  | **0** | All eight packages pass; `/tmp/be-875-typecheck-final.log`.                                                                                                       |
| `pnpm exec vitest run --project unit --maxWorkers=2`                                              | **1** | 343 files / 4953 tests pass, one skipped; only `apps/api/src/sentry-request.spec.ts` cannot bind `127.0.0.1` (`listen EPERM`). `/tmp/be-875-unit-full-final.log`. |
| Focused final unit (QA domain, service, request shape, grounding, search application and QA read) | **0** | 14 files / 737 tests pass; `/tmp/be-875-focused-final.log`.                                                                                                       |
| `pnpm exec eslint .`                                                                              | **0** | Whole repository; `/tmp/be-875-eslint.log`.                                                                                                                       |
| `pnpm exec prettier --check .`                                                                    | **0** | Whole repository; `/tmp/be-875-prettier.log`.                                                                                                                     |
| `pnpm api:check`                                                                                  | **0** | Generated declarations match; `/tmp/be-875-api-check.log`.                                                                                                        |
| `git diff --check`                                                                                | **0** | No whitespace errors.                                                                                                                                             |

The initial continuation typecheck exited **2** because the new integration
assertion accessed an untyped trace property. The assertion now uses the same
object matching as the surrounding tests; the final typecheck above passes.
No test expectation or gate was suppressed to bypass an environment failure.
Changes remain uncommitted; existing cases 1/2/4 edits are preserved. Runtime
integration and live DEV chat acceptance remain outstanding.

The full unit suite was repeated after the final production edits: the same
343 files / 4953 tests pass, with only the socket-denied Sentry suite blocked
(exit **1**). The local PostgreSQL fallback also has no server listening on
`/tmp/.s.PGSQL.5432`. Final integration assertion ordering was linted again
(exit **0**); formatting and `git diff --check` remain clean.
