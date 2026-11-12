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

## Review round 1 fixes (Opus review + Fable 5.2 advisor; Astra decisions 2026-11-12)

Basis: findings on `6b24a966`; fixes on `e070bcfd`. Astra decision text:
`dev/test-evidence/be-874/astra-referent-decision.txt`; amendment section "S4
referents, ordinals and names" appended (both copies).

| ID      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                      | Regression cell (`place-qa-s4.service.spec.ts`, "S4 review round 1")                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-01 P1 | Area refinement with retained slots re-runs the original compare question (`resolveCompare`), even when the active slot's name came from a reply                                                                                                                                                                                                                                                                                         | not_found → name reply → choice → area → cards `[A, C]`                                                                                          |
| F-02 P1 | Referents over QA clarification cards never answer: ordinal → singleton confirm; otherwise re-ask the same candidates; new topic replaces the old; a valid pending's lineage (question, referent, name sources) is re-checked this turn (`sourcesOf`, round 2 F-04), then it keeps compare slots, expiry and its own referent lineage; expired pending seeds a fresh clarification with no partner; invalid ordinal → `clarify_referent` | ordinal over choice; non-ordinal re-ask; compare partner + confirmation answers `[A, C]` on the new topic; expired → fresh confirm; out-of-range |
| M-01 P1 | `cardOrdinal()` (classifier, shared by the service): the ordinal must be the whole referent; a whole exact venue name wins over an ordinal reading (even over a context id)                                                                                                                                                                                                                                                              | `Quán 2`, `Quán 3 Miền` answer the named venue                                                                                                   |
| M-02 P2 | "Quán thứ N" consumes "thứ N"; hours default to today; an external weekday clause still applies                                                                                                                                                                                                                                                                                                                                          | card 2, `day: date` today                                                                                                                        |
| F-03 P3 | `selectTopic` recomputes the local date of a default-today hours chip                                                                                                                                                                                                                                                                                                                                                                    | chip at 23:50 local, selected 00:05 → next date                                                                                                  |
| M-03 P3 | Duplicate compare unresolves the active slot before `referent` pending                                                                                                                                                                                                                                                                                                                                                                   | slot 1 unresolved                                                                                                                                |
| M-04 P3 | Compare topic read from text outside both spans when there is no "về …" tail                                                                                                                                                                                                                                                                                                                                                             | "Cafe Đánh Giá" → `overview`                                                                                                                     |

FAIL-before (product files from `6b24a966`, new spec): 10 FAIL / 2 PASS (the
non-ordinal re-ask and out-of-range cells were already base behaviour and stay as
preservation) — `opus-r3/fail-before-6b24a966.log`; PASS-after 43/43.

Gates on `e070bcfd`: lint, format:check, typecheck, api:check, api:routes,
check:boundaries, test (5110), build, artifacts — all exit 0. Integration serial:
s2 25, s2-wiring 2, 875 5, 877 7, s3 417, s3-fence 45, place-answer 11, assistant
35, search 33. S4 Layer A head 412/412 (preservation 355, incident 1, capability
55); base `13701a66` preservation 355 PASS, incident FAIL, capability 42 FAIL / 13
PASS. Evidence `dev/test-evidence/be-874/opus-r3/`.

## Confirm round fixes (owner: "Opus sửa tiếp", 2026-11-12)

Confirm round (Opus) on `d4acca12`: F-01…M-04 closed; new F-04 P2 (resumed
pending not re-checked; reply-sourced single-slot name binding lost), F-05 P2
(missing FAIL-before cells for F-02's main row and other Astra rows), F-06 P3
(this doc's F-02 row).

- **F-04:** the clarification branch runs `sourcesOf(p)` before `resume`; a broken
  lineage → `clarify_referent`, no recovered candidates or partner; `sourcesOf`
  restores the reply-sourced `nameSourceId`.
- **F-05:** cells in "S4 review round 2": singleton confirm then "Quán này giá bao
  nhiêu?" / "giá bao nhiêu?" → confirm; legacy-district confirm keeps
  `legacyArea`; unavailable referenced card → `clarify_referent`; broken lineage;
  reply-sourced single slot (asked "giá bao nhiêu?" with no cards → name reply →
  choice → ordinal → confirm keeps the reply as name source; area re-runs that
  name); exact family "Quán 2" → choice; exact "Quán thứ 2" + legacy area →
  confirm; "Quán thứ 2 vào thứ 3" → Tuesday; "Quán thứ 2 mở cửa" → today (ordinary
  cards answer, clarification cards confirm); "Quán này thứ 2" → Monday.
- FAIL-before (product files from `6b24a966`): 9 FAIL / 3 PASS (unavailable card,
  "vào thứ 3", "Quán này thứ 2" were already base behaviour: preservation). From
  `d4acca12`: both F-04 cells FAIL for the intended reason, the rest PASS.
  PASS-after 55/55. Logs `dev/test-evidence/be-874/opus-r4/`.

## DEV review closure (2026-11-12)

Opus confirm review on `9a8085af`: **clean** (F-04, F-05, F-06 closed). Fable 5.2
advisor additionally raised M-05 (a venue literally named "Quán 2" asked with a
non-S2 clause) and M-06 (a compared venue name containing "về"). Owner decision
2026-11-12: "Không có trường hợp tên quán là quán 2 đâu. Đừng làm những case vô
nghĩa nữa" → both **won't-fix**; no code or cells added for implausible names.
