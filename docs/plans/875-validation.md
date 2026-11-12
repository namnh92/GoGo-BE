# GoGo-BE#875 validation

## Committed head and DEV execution — 2026-11-12

Basis: `5bc9b466292dc6e3b3ccdac6838656e9eb618787`, branch
`bugfix/GOGO-875-place-qa-exact-match`; baseline `586944a5`.
The earlier sandbox runs were blocked by socket/container access. The later DEV
execution below supersedes those environment-blocked results. DEV chat acceptance
is **pending**; passing suites do not establish acceptance or deployment.

| Check                                    | Result on `5bc9b466`                                                  | Evidence                                                              |
| ---------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Build                                    | PASS                                                                  | DEV handoff `dev/handoffs/codex-review-request-be-876.md`, Gates      |
| Full unit                                | 4954 PASS                                                             | Same DEV handoff                                                      |
| Integration                              | 11 files selected: 10 passed, 1 skipped; 568 tests passed, 21 skipped | `dev/test-evidence/be-875/int-head.log`                               |
| S3 Layer A                               | 417/417 PASS, included in integration                                 | DEV handoff, Gates                                                    |
| New `place-qa-875.int.spec.ts`           | All 5 cells PASS on head; 4 FAIL / 1 PASS on `586944a5`               | `dev/test-evidence/be-875/int-before-586944a5.log` and `int-head.log` |
| Typecheck, ESLint, Prettier, `api:check` | PASS                                                                  | DEV handoff, Gates                                                    |

Evidence paths above are relative to the parent GoGo workspace
(`/Users/maxnguyen/MyWorks/GoGo`), not this worktree. Build/unit/gate and Layer A
counts are reported by the DEV handoff; both saved integration logs were inspected
in this fix round. The baseline integration failures cover dash-name lookup,
ticket-price span, the exact pair with fuzzy overflow and typed confirmation
retry. The separate duplicate-name cell without overflow already passed on that
baseline.

## Implemented behavior

1. `placeNameVariants` folds en/em dashes to ASCII like PostgreSQL `unaccent`
   before indexed exact and fuzzy reads, including alternate readings. It retains
   dashes as identity; no column/index migration is needed.
2. Ticket-price parsing recognizes `Giá vé [của] … [là] bao nhiêu`. Every longer
   whole-name reading remains an exact probe, including `vé` at the grammar/name
   boundary. The #876 correction below restricts the quantity suffix to this
   ticket-price context so names ending in `Bao Nhiêu` remain complete.
3. Owner decision `dev/policy/decisions-log.md`, 2026-11-12, amends rev3 §4.3:
   exact 1 → answer; exact 2–3 → choice containing only those exact cards;
   exact >3 → narrow. Fuzzy/FTS overflow narrows only without exact candidates.
   Ambiguous parsing, unresolved areas and §4.4 area rules remain applicable.
   Exact retrieval is separate from fuzzy retrieval and retains at least four
   exact rows even with a smaller caller limit. The integration cell proves
   genuine fuzzy overflow and exact-only cards for `The Workshop Coffee`.
4. Typed confirmation re-reads the complete canonical-name family. The dash fix
   repairs equality without weakening source, expiry, publication, whole-phrase,
   area-label or branch-uniqueness checks. SSE/history chip equality and the
   text-only confirmation round trip are covered by the integration spec.

S3 Layer A spec, corpus and fixtures were not edited for #875 or this fix round.
The separate `place-qa-875.int.spec.ts` uses fictional fixtures and zero model
calls. The Layer A `Bát Diệp` overflow case has nine exact names, so it still
narrows under the owner rule.

## GoGo-BE#876 fix round — uncommitted delta on `5bc9b466`

- **F-01:** Both pending and stale-pending recovery name lookups now dispatch on
  resolver `fresh.kind`. Exact counts 1/2/3 answer or choose despite fuzzy overflow;
  counts 4/8 narrow with no cards. Regression cells cover both paths and preserve
  the original topic/question for referent replies and overview for recovered names.
- **F-02:** General Vietnamese topic/suffix grammar no longer treats bare
  `bao nhiêu` as a price question. Classifier/admission and S2 span extraction
  enable `[là] bao nhiêu` only with a `giá vé` head. Name-collision regressions
  cover bare and information-prefixed `Bao Nhiêu` names, `Vé` name tokens,
  ticket-question alternate readings and service overview answers.
- **F-03:** This record now distinguishes committed-head DEV execution from
  the current uncommitted fix. Live DEV acceptance remains pending.

Regression command:

```sh
pnpm exec vitest run --project unit \
  libs/modules/assistant/application/place-qa.service.spec.ts \
  libs/modules/assistant/domain/place-qa/classifier.spec.ts \
  libs/modules/assistant/domain/place-qa/resolution.spec.ts -t 'GoGo-BE#876'
```

- FAIL-before: restored the four affected production files from `5bc9b466` while
  retaining the final regression tests. Exit **1**, **20 failed / 9 passed /
  431 skipped**: 10 F-01 failures and 10 F-02 failures.
  Log: `/tmp/be-876-before-final.log`.
- All four production files were restored byte-for-byte in `finally`.
- PASS-after: the same three specs without the title filter exited **0**,
  **460 passed**. Log: `/tmp/be-876-focused.log`.

Final checks for this delta:

| Command                                              | Exit  | Result / log                                                                                                                                                                                 |
| ---------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                     | **0** | All 8 packages; `/tmp/be-876-typecheck.log`                                                                                                                                                  |
| `pnpm exec vitest run --project unit --maxWorkers=2` | **1** | 343 files / 4982 tests pass, 1 test skipped. Only `apps/api/src/sentry-request.spec.ts` is BLOCKED by sandbox `listen EPERM: operation not permitted 127.0.0.1`; `/tmp/be-876-unit-full.log` |
| `pnpm exec eslint .`                                 | **0** | Whole repository; `/tmp/be-876-eslint.log`                                                                                                                                                   |
| `pnpm exec prettier --check .`                       | **0** | Whole repository; `/tmp/be-876-prettier.log`                                                                                                                                                 |
| `pnpm api:check`                                     | **0** | Generated declarations match; `/tmp/be-876-api-check.log`                                                                                                                                    |
| `git diff --check`                                   | **0** | No whitespace errors                                                                                                                                                                         |

Integration/build were not rerun for this uncommitted delta; the committed-head
DEV evidence above remains scoped to `5bc9b466`. No gate or expectation was
suppressed to bypass the socket failure. S3 Layer A files remain untouched.
No commit, deployment, flag change or external write was made. DEV acceptance
is still **pending**.
