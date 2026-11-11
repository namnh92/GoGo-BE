# BE #857 — AI place QA, S2 of #844

Basis: Astra rev3 `dev/handoffs/sa-shape-be-844-ai-place-qa.rev3.astra.md`
(§3.4, §4, matrices 2/3, §9), both round-1 reviews, and the DEV decision of
2026-11-11. The owner states this branch is stacked on S1
`feature/GOGO-856-place-answer-tokens` (PR #860). No git commands were run;
branch/SHA identities were not independently verified.

## Confirm-round fixes (2026-11-11, escalation fixer)

Basis: uncommitted working tree on S1 head `93148283` (PR #860), S2 patch
re-applied from `40d7fc57`. Not a commit: identity is the SHA-256 list in
[source-sha256.json](857-s2-evidence/source-sha256.json). Sections below this
one that say integration was BLOCKED/NOT RUN describe earlier rounds.

Every regression was written first and observed failing on the pre-fix sources
(production files restored from the git index = restacked S2 patch; module from
`HEAD`), then passing. Summary and assertion messages:
[confirm-round-verification.json](857-s2-evidence/confirm-round-verification.json).

| Finding       | Change                                                                 | FAIL before (reason) → PASS after                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sol F-01 P1   | `SearchModule` provides/exports `PLACE_FACTS_READER` → `SearchService` | `place-qa-s2-wiring.int`: real app graph, no port override, `PlaceAnswerReader.page` returned `read_error` (expected `ok`)                                                                       |
| Sol F-02 P1   | review aggregate returns newest instants; projection gates on them     | unit: rating still `verified_current` with a future newest instant; SQL fixture (5 valid + 1 future `first_published_at` / `created_at`): rating present, expected omitted                       |
| Sol F-03 P2   | S2's `observe(..., {surface:'projection'})` removed                    | wiring test with the binding and the old service: labels `[projection, history]`, expected `[history]`                                                                                           |
| Sol F-04 P2   | only the digit-brand token varies                                      | unit: `O'Leary Pizza 4ps` variants lacked the folded name; SQL: `O'Brien Pizza 7ps` did not resolve `answer`                                                                                     |
| Astra F-01 P1 | question clause consumed once; bare noun = uncertain boundary          | unit: `Cafe Wifi mở cửa mấy giờ?`, `…ở Quận 9 mở cửa mấy giờ?`, `Cafe Wifi có wifi không?`, `Giờ mở cửa của Cafe Wifi?` all gave `Cafe`; bare `Cafe Wifi?`, `Tonkin Price` gave a shortened span |
| Astra F-02 P1 | exact channel compares the whitespace-collapsed column key             | SQL: three published whitespace spellings of `Sương Mai` resolved `answer` (one exact, twins fuzzy), expected `choice` with all exact                                                            |

Gates on this tree (macOS, Docker 29.7.2, Node v22.22.2, `postgis/postgis:16-3.4`):

| Gate                                            | Command                                                                                                                                                                                                                                  | Result                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build                                           | `pnpm -s turbo run build --force`                                                                                                                                                                                                        | PASS, 2/2 tasks                                                                                                                                      |
| Typecheck                                       | `pnpm -s turbo run typecheck --force`                                                                                                                                                                                                    | PASS, 8/8 packages                                                                                                                                   |
| Unit                                            | `pnpm -s vitest run --project unit`                                                                                                                                                                                                      | PASS, 335 files / 4353 tests                                                                                                                         |
| Integration                                     | `pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/place-qa-s2.int.spec.ts apps/api/test/place-qa-s2-wiring.int.spec.ts apps/api/test/assistant-place-answer.int.spec.ts apps/api/test/assistant.int.spec.ts` | PASS, 4 files / 71 tests                                                                                                                             |
| Integration (S2 file alone, final evidence run) | same, `apps/api/test/place-qa-s2.int.spec.ts` only                                                                                                                                                                                       | PASS, 23 tests                                                                                                                                       |
| Contract                                        | `pnpm -s api:check`                                                                                                                                                                                                                      | PASS (no OpenAPI change)                                                                                                                             |
| ESLint                                          | `pnpm -s eslint <15 changed TS files>`                                                                                                                                                                                                   | PASS                                                                                                                                                 |
| Prettier                                        | `pnpm -s prettier --check .`                                                                                                                                                                                                             | PASS after formatting the generated `sql-performance.json` (the test writes plain `JSON.stringify`; run `prettier --write` on it after regenerating) |

NOT RUN: full-repo `pnpm lint`, the remaining integration files, CI on a
committed head, any DEV/representative-corpus measurement, independent re-review.

Plan/latency evidence, regenerated by the S2 file's last test on the final
sources (20,039 synthetic rows, 30 samples): p95 exact **127 ms**, broad
**183 ms**, facts **17 ms** (the 4-file run recorded 225/363/53 ms with other
containers running). The exact channel stays a sequential scan and now applies
the whitespace key per eligible row: that node went from 2.5 ms to about 25 ms
on this corpus. Scoped retrieval still uses `places_province_code_idx`. If a
representative corpus misses the 1 s budget, the remedy is the rev3 §4.2 path:
a generated normalized column plus index, as a CODEOWNER-reviewed migration. It
is not part of this change.

Open decisions carried by this fix, for the next review:

- Bare trailing topic nouns now clarify (`Tonkin price` → `ambiguous`) instead
  of being stripped. This follows rev3 §4.1; S3's golden set should confirm it.
- `source-sha256.json` and `round1-fixes-verification.json` content from earlier
  rounds is superseded; the former was regenerated, the latter is historical.

## Canonical S1/S2 boundary

S1 owns `libs/modules/assistant/domain/place-qa/place-facts.ts`:
`PlaceFactsReader`, `PlaceFacts`, `PlaceFactContext`, and `VerifiedFact`.
`SearchService implements PlaceFactsReader` and imports these types. S2's
conflicting public `PlaceFactsReadPort`, `PlaceFacts`, `PlaceFactContext`, and
`PlaceFactReadOptions` are removed. The package barrel now exports S1's canonical
reader/context/fact types and reader token. S1's implementation files are unchanged.

- `placeFacts(ids, {signal, deadlineAt})` requires S1's options and returns
  `{places: ReadonlyMap<string, PlaceFacts>}`. Consumers use `places.get(id)`.
- Published identities are `{id, available:true, name, facts}`. Missing, closed,
  or unpublished places use `{id, available:false, name:'', facts:{}}`; no old
  identity or evidence leaks. No `loadedAt` or second renderer-facing shape.
- Ineligible fields/bundles are **omitted**, as S1 requires. Internal SQL-policy
  results may distinguish absent reasons, but they are not another public port.
- Batches deduplicate at most 30 canonical UUIDs. One SELECT reads identity,
  status/closure, field evidence, hours/prices, assignments/provider metadata,
  and the published review population in one snapshot. No provider/model calls.
- The snapshot recursively freezes values and exposes a read-only map view with
  no mutation methods; freezing a mutable `Map` alone would not suffice.
- The smaller of the absolute `deadlineAt` and a 2s fact-read budget bounds pool
  acquisition, SQL, and completion. Abort/deadline rejects and destroys the
  checked-out connection; late pool acquisition is disposed of too. Server
  `statement_timeout` is the backstop. Failures reject, never return empty data.
- `resolvePlaceName` has optional `{area, limit, signal, deadlineAt, ambiguous}`
  and a 1s total budget including all variants and the one permitted relaxation.

No classifier, route hook, emitter, feature enablement, public API, or migration
is introduced. S3 owns production integration/admission. `SearchModule` provides
and exports S1's `PLACE_FACTS_READER` token with `useExisting: SearchService`, so
S1's `PlaceAnswerReader` reaches this projection in the production graph.
`assistant_place_facts_duration_seconds` is observed only by S1's reader, with its
`live/replay/history/cms` surface; S2 neither registers nor observes it.

## Mapping SQL evidence to S1

| Data                                           | Mapping and eligibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hours                                          | Verified editor rows only; valid complete weekday schedules with no overlaps. One `ScheduleFact` per weekday, containing `VerifiedFact<ScheduleInterval>` per interval. Preserve intervals, overnight, `closed`, and `open_24h`; missing days are not closed.                                                                                                                                                                                                                                                                                                                                                   |
| Price                                          | One bundle per verified editor/bill-checkin row, with safe minor integers, known unit, valid confidence, and supported currency. True zero survives. Import S1's `validPrices` to share its complete supported-currency/value validation; `ZZZ` is absent.                                                                                                                                                                                                                                                                                                                                                      |
| Address/contact                                | Independently validate ownership, value, provenance, verification and collection dates. Preserve the actual distinct `verified_at` and `collected_at`; ownership/place freshness never counts as verification.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Community rating                               | Recompute the published population on each statement; retain community source/count and the existing 5-review score threshold. One lateral aggregate returns the oldest and the newest actual `first_published_at` and `created_at` of exactly the rows behind count/mean. The fact is dated with the oldest; it is omitted when any review lacks moderation evidence or when the newest instant is missing/invalid/future on the projection's clock, so one future-dated row suppresses the whole aggregate instead of being vouched for by older rows. An empty population also has no dated evidence bundle. |
| Provider rating, openNow, taxonomy/suitability | No safe provider prose attribution, current-open policy, or assignment-verification path exists in this slice. Omit; active assignment or place freshness never enables them.                                                                                                                                                                                                                                                                                                                                                                                                                                   |

S1's restacked canonical contract retains evidence **per interval**. Each complete
weekday contains all intervals with their own `verifiedAt`, `tier`, and source
collection date. There is no weekday-level evidence date. The projection uses
`verified_reference` for every eligible editor hours row; S1's renderer dates and
warns each interval separately. Eligibility requires every interval's evidence
to pass S1's gates. Invalid/missing interval verification suppresses the complete
day. Regression coverage checks distinct dates, tiers, rendered sources, and
rejection when either interval's evidence is invalid.

For editor/bill verification rows, `source.kind=gogo` identifies GoGo's stored
verification evidence; `source.collectedAt` dates that verification event using
its real `verified_at`, not an inferred original observation. Each hours interval
retains its own such event. Contacts retain their separate collection date; community facts use actual review dates. No snapshot/read time, place
freshness, provider collection date, or inferred original-source date substitutes
for verification. No freshness TTL is invented: hours/prices/contacts remain
`verified_reference`, with S1's adjacent dated warning. Dynamic compact-card
fields require current eligibility. Q-2 changes missing-price wording only.

`placeTopicEligible` consumes the canonical projection through S1's renderer,
so topic choices and renderability use the same evidence/value gates. There is
no eligible price topic whose only currency the renderer rejects. Weekly hours
never assert special-date/holiday availability; S1 retains its date warning.

## Name and area resolution

- Preserve original Unicode token offsets and identifying tokens. Bare
  single-word topic prefixes such as `Gia` cannot shorten `Gia Bảo` to `Bảo`.
  A terminal question supplies the topic without erasing that name token;
  otherwise an ambiguous prefix boundary clarifies. Explicit topic grammar
  (`Giờ mở cửa của…`, etc.) remains supported.
- One terminal question clause is consumed **at most once**: before a trailing
  area, or after automatic area extraction when nothing was consumed yet. So
  `Mây Lam không có wifi ở Quận 9?` yields `Mây Lam` without caller offsets, and
  `Cafe Wifi mở cửa mấy giờ?` keeps `Cafe Wifi`. A bare topic noun with no
  question grammar (`wifi`, `chỗ đậu xe`, `price`, `address`, `rating`,
  `opening hours`) is a name token when a stripped leading topic already supplies
  the question (`Giờ mở cửa của Cafe Wifi?`); otherwise the boundary is
  uncertain and the span is `ambiguous` (`Cafe Wifi?`, `Tonkin price`).
  Both name and area offsets of comparison operands refer to the original
  message; slicing reproduces each stated area exactly.
- The only spelling equivalence is the possessive of **one** digit-bearing
  brand token: `4p's`, `4ps`, `4p s` give the same three whole-name variants
  from any of them. Every other character is kept as typed (`O'Leary Pizza 4ps`
  never becomes `oleary…`), so the folded name is always in its own variant set.
  Typographic apostrophes fold to `'`, as `f_unaccent` does for the stored
  column. Two or more brand tokens apply no equivalence (one variant).
  Multiple equivalent published IDs always produce choice for every spelling.
- Whole-name equality is decided on a column-side key that collapses whitespace
  runs and trims exactly as `normalizeVietnamese` does (`placeNameKeySql`; the
  class is JavaScript's `\s`, checked code point by code point in SQL). The
  stored column only lowercases/unaccents, so `Mây Lam` and `Mây  Lam` are one
  exact family for either input. No migration, generated column or expression
  index: the exact channel already was a sequential scan over eligible rows.
- Exact lookup is complete and independent of fuzzy cutoffs. Each fuzzy channel
  retrieves k+1; merge/deduplicate all channels before overflow/uniqueness.
  Overflow and unresolved parsing/area take precedence over exact uniqueness.
- Apply current area predicates before every cutoff. For non-overflow scoped
  retrieval with **neither exact nor score >= T_weak**, perform one unscoped pass,
  even if scoped retrieval contains rows at 0.30–<0.35. Elsewhere matches are
  choices, never silent answers. Scoped overflow never relaxes.
- Retrieval uses transaction-local trigram thresholds 0.30; classification
  includes T_weak=0.35 in float4 precision. No margin authorizes fuzzy answers.
  Legacy areas force confirmation; unresolved areas narrow. Aliases remain S5.

Existing trigram/FTS and administrative indexes support the predicate forms.
No demonstrated missing migration was established by either review. LIMIT bounds
output, not DB scoring work; no performance/index-use acceptance is claimed.

## Round-1 regression evidence

All unit regressions were added before production fixes. Initial local unit run:
**20 PASS / 8 FAIL** across 28 tests. Failures were the intended assertions, not
import/setup errors. This binds to the workspace's pre-fix source, not a verified
git SHA. JSON report: `/tmp/be-857-round1-unit-before.json`.

| Finding                  | Regression / result                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sol F-01 + Astra F-03    | Canonical renderer projection failed before (no `name`/`facts`), passes after. Testcontainers cases require `PlaceFactsReader`, `.places.get`, renderer-facing evidence and expired `deadlineAt`. SQL FAIL-before/PASS-after is BLOCKED locally. |
| Sol F-02                 | Testcontainers fixture asserts a scoped score strictly between 0.30 and 0.35, then requires out-of-area exact `choice`. BLOCKED before container setup; no behavioral SQL result claimed.                                                        |
| Sol F-03                 | Unit negated wifi question without supplied area offsets failed with topic text retained; passes after.                                                                                                                                          |
| Sol F-04 + Astra F-02    | Unit symmetric variant/exact-set regression failed before; passes after. SQL single-ID case now requires `answer` and `exact:true`; multi-ID fixtures require all equivalent IDs exact for every input. SQL execution BLOCKED.                   |
| Sol F-05                 | Unit unsupported uppercase `ZZZ` returned reference/eligible before; absent/ineligible after. Real SQL malformed-price case includes `ZZZ`.                                                                                                      |
| Astra F-01               | Unit catalogue collision (`Gia Bảo`, `Bảo`) failed before by selecting shortened `Bảo`; preserves full name after. Unmarked ambiguous prefix clarifies.                                                                                          |
| Astra F-04               | Unit original-message area slicing failed before (`ánh Mây ở P`); both operands pass after.                                                                                                                                                      |
| S1 per-interval evidence | Replacement regression fails against the pre-fix projection; each interval now retains and renders its own date/tier/source. Missing verification or invalid evidence on either interval cannot enable the weekday.                              |

## Restack compatibility verification (2026-11-11)

- Resolved the infrastructure metric table conflict by retaining the union of S1
  and S2 rows, including vocabulary-preflight and place-resolution metrics.
  No duplicated metric rows in that table; no remaining repository conflict markers.
- Removed the weekday evidence aggregation from code, documentation and tests.
  Updated S2's SQL integration assertions/helpers for S1's per-interval shape.
- New interval regression before the mapping fix: **8 PASS / 2 FAIL** in the
  projection suite, at the intended schedule-shape assertions. Log:
  `/tmp/be-857-restack-unit-before.log`.
- Assistant and search unit suites, including place-QA, strict reference coverage
  and reader deadlines: **918 PASS / 0 FAIL**, 49 files. Log:
  `/tmp/be-857-restack-units.log`.
- `pnpm typecheck`: **PASS**, 8/8 packages. Only sandbox cache IO warnings.
  Log: `/tmp/be-857-restack-typecheck-final.log`.
- ESLint on changed TypeScript and Prettier on all five changed files: **PASS**.
- S1 files were not edited. No git commands were run. Integration tests were
  **NOT RUN** for this compatibility patch; prior SQL/DEV gates remain open.

## Earlier round-1 verification and DEV gates

- Focused units plus S1 token/template/reader preservation: **231 PASS / 0 FAIL**
  in 10 files. JSON: `/tmp/be-857-round1-unit-after.json`.
- `pnpm typecheck`: **PASS**, 8/8 packages, exit 0 (sandbox cache IO warnings
  only). The first run found the duplicate S2/S1 metric registration; removing
  only S2's duplicate lets the canonical S1 declaration serve both slices.
- ESLint and Prettier on every changed TypeScript/Markdown file: **PASS**.
- Testcontainers attempt: **BLOCKED**, `Could not find a working container runtime
strategy`; all 19 tests skipped before fixture setup. This is not a SQL failure
  or a SQL pass. Do not reuse supplied earlier integration results for this patch.
- No git commands, external-provider calls, S1 implementation edits, commits,
  pushes, merges, or deployment were performed.

DEV must run the complete real PostGIS Testcontainers suite:

```sh
pnpm exec vitest run --project integration apps/api/test/place-qa-s2.int.spec.ts
```

It covers scoped weak-hit relaxation; single- and multi-ID punctuation exactness;
canonical reader map/projection and absolute deadline; area-before-cutoff and
overflow; legacy/negation; rollback/timeout/abort/threshold reset; verified and
unverified facts; all units/zero/unsupported currency; community threshold and
actual evidence dates; unavailable IDs; and weekly/date rendering semantics.
DEV must also establish FAIL-before at the intended SQL assertions on the
pre-fix source; the local runtime failure cannot satisfy that requirement.

The final integration test adds 20,000 fictional rows, ANALYZEs places, EXPLAINs
the actual production query builders, and records 30 samples/p95 for exact,
broad-name, scoped and fact reads. Output:
`docs/plans/857-s2-evidence/sql-performance.json` (override
`PLACE_QA_EVIDENCE_DIR` to preserve attempts). New source hashes are required.
Earlier synthetic timings/hash evidence do not validate this changed source;
the earlier exact/broad plans used sequential scans. Representative DEV corpus,
load, EXPLAIN/latency evidence, exact-head CI and independent re-review remain
outstanding. Local unit/static results do not establish acceptance.

`RTK.md` was absent in this worktree and its ancestors. No scope reduction was
inferred from its absence.

## Reproduce local checks

```sh
pnpm typecheck
pnpm exec vitest run --project unit \
  libs/modules/assistant/domain/place-qa \
  libs/modules/assistant/application/place-answer-reader.spec.ts \
  libs/modules/search/domain/place-facts.spec.ts \
  libs/modules/search/infrastructure/place-qa-read.spec.ts \
  libs/modules/search/domain/normalize.spec.ts \
  libs/modules/shared/place-contact.spec.ts \
  libs/modules/reviews/domain/gogo-rating.spec.ts \
  libs/observability/src/metric-labels.spec.ts
```

Changed TypeScript files for `pnpm exec eslint` and `pnpm exec prettier --check`:

- `libs/modules/assistant/domain/place-qa/{span.ts,resolution.ts,resolution.spec.ts}`
- `libs/modules/search/domain/{place-facts.ts,place-facts.spec.ts}`
- `libs/modules/search/application/search.service.ts`
- `libs/modules/search/infrastructure/{place-qa-queries.ts,place-qa-read.ts,place-qa-read.spec.ts}`
- `libs/modules/src/index.ts`
- `libs/observability/src/metric-labels.ts` (remove S2's duplicate registration only)
- `apps/api/test/place-qa-s2.int.spec.ts`

Prettier also checks this document. A compact evidence manifest with final source
hashes and the observed unit FAIL-before/PASS-after assertions is saved in
`docs/plans/857-s2-evidence/round1-fixes-verification.json`. It does not replace a
review snapshot, git identity, Testcontainers execution, or exact-head CI.
