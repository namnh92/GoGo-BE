# BE #874 — S4 validation

Role: Sol drafted on base `586944a5`; Opus (DEV, owner's temporary role map for
this session, 2026-11-12) took over, rebased onto `13701a66` (#876, #880) and
owns the results in **Opus round** below. Sol's sections are kept as written
and describe the pre-rebase tree; they are not results of the current head.
Authority: Astra rev3 §§3.1, 3.3, 4.3, 4.5, 7–9 and the
[S3 amendment](sa-shape-be-844-ai-place-qa.rev3-amend-s3.astra.md), plus owner
Q-2 / vi-065 / name + area decisions dated 2026-11-11/12. The task's referenced
`RTK.md` was not present in the checkout or the searched parent GoGo directories.

## Files by purpose

| Purpose                                | Files                                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production routing/state               | `libs/modules/assistant/application/place-qa.service.ts`; `libs/modules/assistant/domain/place-qa/classifier.ts`, `pending.ts`, `span.ts`                                                                |
| Topic eligibility and localized labels | New `libs/modules/assistant/domain/place-qa/topics.ts`; `libs/modules/assistant/application/place-answer-reader.ts` imports the shared labels                                                            |
| Diagnostics                            | New `libs/modules/assistant/application/place-qa-s4.service.spec.ts`; new `libs/modules/assistant/domain/place-qa/s4-corpus.spec.ts`; one S3 unit assertion now expects topic pending after confirmation |
| Public integration oracle              | New `apps/api/test/assistant-place-qa-s4.int.spec.ts`; new `libs/modules/assistant/eval/place-qa-cases.s4.vi.json`; new `scripts/eval/place-qa-s4-layer-a-base.sh`                                       |
| Documentation                          | `docs/assistant.md`; this report                                                                                                                                                                         |

The S3 integration spec, S3 corpus, S3 fixtures and original Layer A script are
unchanged. Their prior hash-bound evidence has not been relabelled as S4 proof.

## Design and acceptance mapping

- **Compare:** reuse S2's positional comparison/name grammar and S1's atomic
  `compare` reference group. Preserve whole-name alternatives at the right topic
  boundary, protecting accented name tokens and words that resemble commands.
  Each side follows the resolution truth table. Pending stores at most two
  slots, active slot, resolved partner, source message IDs, topic/arguments and
  original 30-minute expiry. Choice, singleton confirmation, none, narrowing,
  name and area refinements keep those references. Both identified sides are
  read together; templates show independent facts without a verdict. Equal IDs
  ask for another referent and emit no duplicate cards. Q-2 missing-price prose
  applies only to a directly requested price topic.
- **Previous cards:** explicit context wins, then ordinal in the latest accessible
  card order, then a sole accessible card. Multiple cards show a choice (first
  three with none/narrow); no referent asks for the place. Unavailable ordinals
  are not renumbered to another place. Sources are scoped to user/conversation;
  a retained assistant source reference invalidates later choices if deleted.
- **Topics:** one group, up to three other eligible topics, using the same pure
  template policy and immutable fact snapshot as prose/cards/sources. Store
  semantic query tokens and resolved IDs in `kind:topic`. Paired public IDs or
  the exact normalized emitted localized label retain the referent(s). Re-read
  sources and current eligibility before answering; changed/expired/superseded
  selections are neutral stale, flag-off controls are disabled. One ambiguous
  reply retains topic references and expiry; the next ambiguity clears pending.
- **S3 preservation:** admission/marker recovery/flag latch/cleanup deadlines,
  ordinary fast paths, funding and model request builders were not changed.
  Name + area confirmation still re-reads the complete canonical family, rejects
  duplicate identities and never persists hydrated identity text. QA remains
  zero-model. The flag remains default off.
- **Contract/telemetry:** no wire change. Existing optional option IDs and paired
  `replyToMessageId` + `followUpOptionId` support the public consumer tests;
  S1 already supports two-card comparisons and query options. No version bump,
  CHANGELOG or generated pins needed under this task's wire-change rule. No new
  metric labels: comparison class, existing topics/outcomes/tiers and control
  labels remain closed. No names, text or IDs are metric labels.

## Corpus and Layer A

The S4 manifest selects **193 immutable S3 rows + 41 S4 rows = 234 core**:
11 non-compare topics × 12, resolution 40, branch 12, not-found 12, hard negatives
30, compare 8. Each topic retains four unaccented/two typo cases and adds explicit
context, sole-card and ordinal sources. Buckets are disjoint and checked by a
unit manifest invariant. Seven additional corpus rows exercise previous-card
choices and typed/structured topic consumers. Public lifecycle scenarios add
compare continuation, deletion, changed fact eligibility, supersession, expiry
and both disabled topic submission forms. The same spec also carries 156 intent
preservation cases, vi-065 on/off and serialized request equality for the four
resume modes and flag on/off.

S4 incident: `s4-compare-01` must fail on base at its missing-price symptom
assertion (S3 returns unsupported comparison), then pass on head. Inherited S3
core/intent/request-byte rows are **preservation**; other S4 rows are
**capability**, with their actual baseline result reported. Setup/import/admission
failures do not establish FAIL-before. Per-case partitions and outcomes remain
in the report; held-out rates and zero-gates require an actual Layer A run.

The sibling baseline script extracts an isolated Git archive under `/tmp`,
hashes every base production file before/after an explicit test-only overlay,
records identical overlay hashes and installs dependencies inside base. It does
not write shared Git worktree metadata or link head production dependencies.

## Commands and observed results

| Command                                                                                                                                                                                                                                                                   | Exit | Result / evidence                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                                                                                                                          | 0    | All eight packages; `/tmp/874-check-typecheck.log`                                                                                                         |
| `pnpm test`                                                                                                                                                                                                                                                               | 1    | 5,010 tests passed, one skipped; one suite blocked by sandbox `listen EPERM 127.0.0.1` in `apps/api/src/sentry-request.spec.ts`; `/tmp/874-check-unit.log` |
| `pnpm exec vitest run --project unit libs/modules/assistant/domain/place-qa libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/application/place-qa-s4.service.spec.ts libs/modules/assistant/application/place-qa-request-shape.spec.ts` | 0    | 712 passed, including 28 new S4 service cells, core manifest, 156 negatives, vi-065 and request-byte diagnostics; `/tmp/874-qa-final.log`                  |
| `pnpm exec eslint <all touched TypeScript files>`                                                                                                                                                                                                                         | 0    | `/tmp/874-check-eslint.log`                                                                                                                                |
| `pnpm exec prettier --check <all touched TS/JSON/Markdown files>`                                                                                                                                                                                                         | 0    | `/tmp/874-prettier.log`; report formatting checked separately                                                                                              |
| `pnpm api:check`                                                                                                                                                                                                                                                          | 0    | Generated declarations match; `/tmp/874-check-api.log`                                                                                                     |
| `bash -n scripts/eval/place-qa-s4-layer-a-base.sh`                                                                                                                                                                                                                        | 0    | Shell syntax                                                                                                                                               |
| `git diff --check`                                                                                                                                                                                                                                                        | 0    | Whitespace                                                                                                                                                 |
| Head Layer A command below                                                                                                                                                                                                                                                | 1    | BLOCKED_SETUP: no working container runtime; no behavioral case executed                                                                                   |
| Base Layer A command below                                                                                                                                                                                                                                                | 1    | INSTALL_FAILED: missing offline `@eslint/js@10.0.1` tarball; harness NOT RUN                                                                               |

Reproduce the blocked base/head attempts (test-only fixture adapters; no paid
provider calls):

```sh
scripts/eval/place-qa-s4-layer-a-base.sh 586944a5 /tmp/be874-base-final-layer-a

PLACE_QA_BASE_SHA=586944a5 \
PLACE_QA_HEAD_SHA=worktree:586944a5 \
PLACE_QA_REPORT=/tmp/be874-head-final-layer-a/cases.json \
pnpm exec vitest run --project integration --no-file-parallelism \
  apps/api/test/assistant-place-qa-s4.int.spec.ts \
  --reporter=default --reporter=json \
  --outputFile=/tmp/be874-head-final-layer-a/vitest.json
```

Base `run.json`/`overlay.json`/`install.log` and head `cases.json`/`vitest.json`/
`test.log` record infrastructure refusal. They are **not** a 234-case pass,
FAIL-before proof, SQL validation, Mobile compatibility, independent review or
DEV acceptance. Earlier attempted runs under `/tmp/be874-*-layer-a` are
superseded by the final attempt paths above.

## NOT RUN, pending and open questions

- **NOT RUN:** actual Layer A base/head behavioral assertions and zero-gates,
  SQL/lifecycle integration assertions, real Mobile generated-client compatibility,
  live Jev/Haiku and owner DEV acceptance. Needs offline dependencies and a
  working Docker/PostGIS environment, then the authorized acceptance chain.
- **Pending feature list: S5 curated aliases only.** Combined S4 + S5 proof and
  consumer compatibility remain prerequisites to enabling DEV. No alias scope
  reduction or live acceptance is claimed.
- **Open questions:** none needed for this implementation. S6/S7 district policy
  and any rollout order remain separate scope. No new owner policy was inferred.

## Opus round (2026-11-12, base `13701a66`)

**Rebase.** One conflict (`place-qa.service.ts`, three hunks): the S4 topic-label
branch runs first, then #880's emitted-identity-first block now reads the
**active slot** (`p.slots[p.activeSlot]`), and #876's exact-wins outcome
(`fresh.kind`) is kept with `selected()` so a compare continuation keeps its
retained slot. New unit cells (`place-qa-s4.service.spec.ts`): slot-2 typed
emitted text confirms only that branch; slot-2 venues named `Quán 2` re-ask the
whole choice; a topic label typed during a slot-2 choice selects nothing.
Mutation `p.slots[p.activeSlot]` → `p.slots[0]`: 4 FAIL; restored: 31/31 PASS.

**Test fixes.** Money assertions follow #880 grouping (`12.000`); every absence
guard matches raw and grouped forms and runs behind `stripVolatile` (integration)
or a UUID/timestamp-safe pattern (unit). `s4-state-topic-expired` aged the
stored pending instead of jumping the clock (a clock jump past the access-token
lifetime gave 401, never a proof); moving `expiresAt` into the future makes it
FAIL, restored PASS.

**Reader compatibility.** S3's `readQaPending` (`13701a66`) is a strict schema
(`kind` without `topic`, `activeSlot: literal(0)`): S4 pending degrades to
`null` (stale), it never throws. Rollback floor stays S3 (flag off).

**Layer A transition (Astra decision, shape amendment appended).** Corpus row
`compare-s3-neutral` moved to the S4 contract (outcome `answer`, places
`lantern`+`no_price`, contains `GoGo chưa có giá đã xác minh`, slice `S4`,
`pendingSlice` removed); ID, input, fixture, clock and partition unchanged. It
maps to `s4-compare-01` (same scenario, counted once in the 234 core). Every
other S3 row and harness byte is unchanged.
`place-qa-cases.vi.json` SHA-256: `c8a3d100…cbb39f` (origin/re-design) →
`f694547b…08e0cc1`. On S3-only code the revised row FAILS ("GoGo chưa hỗ trợ so
sánh"), on S4 it PASSES. Historical S3 proof: `dev/test-evidence/be-864`.

**Metadata discrepancy.** The first Opus head run (`opus-r1/layer-a/head`) wrote
`baseSha: 586944a5` because `PLACE_QA_BASE_SHA` was unset (spec default); its
base run used `13701a66`. Originals kept; `opus-r2` sets both SHAs.

**Results on head `08896685` (overlay SHA-256 in `opus-r2/layer-a/overlay-sha256.txt`).**

| Gate                                                        | Result                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| typecheck / eslint / prettier / api:check (no OpenAPI diff) | 0 / 0 / 0 / 0                                                                                   |
| unit (full)                                                 | 5098 PASS (before corpus edit); assistant+search 1723 PASS after                                |
| S4 Layer A head                                             | 412/412 PASS — preservation 355, incident 1, capability 55                                      |
| S4 Layer A base `13701a66`                                  | preservation 355 PASS, incident FAIL, capability 42 FAIL / 13 PASS                              |
| integration serial                                          | s3 417, s3-fence 45, s2 25, s2-wiring 2, 875 5, 877 7, place-answer 11, assistant 35, search 33 |

Evidence: `dev/test-evidence/be-874/opus-r1/`, `opus-r2/`. S4 stays behind the
S4+S5 gate; `place_qa` is ON in DEV by owner order, so a DEV deploy makes
compare, referent and topic chips live there before the Mobile S4 consumer.
