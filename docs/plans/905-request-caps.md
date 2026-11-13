# #905 — bounded assistant provider requests

Owner decision: 2026-11-13, “Thêm trần cứng rồi tính lại”. Implementation scope is
request caps and proof inputs for Astra. This document does **not** certify B,
create a credit-bound artifact, activate paid admission, or establish DEV acceptance.
Daily free sends, burst limits, budgets, model routing, retry count and the existing
configured output limit are preserved. Pricing below uses the owner's supplied rates.

## Complete request envelopes

All sizes are **UTF-8 bytes of the exact JSON HTTP body**, including model ID,
JSON escaping, state, questions, messages/system prompt and adapter parameters.
Headers and transport framing are outside this JSON envelope. They are not model
input under the assumption below; any provider-added prompt framing must be covered
separately. Equality with a cap is allowed; one byte above it is rejected.

| Call                                                                     | Max body bytes/call | Max calls/turn | Existing largest fixture body | Headroom |
| ------------------------------------------------------------------------ | ------------------: | -------------: | ----------------------------: | -------: |
| Jev assistant decision (initial and optional new-request classification) |              32,768 |              2 |                        12,651 |    2.59× |
| Jev relevance                                                            |              16,384 |              1 |                         9,497 |    1.73× |
| Haiku grounded answer                                                    |              49,152 |              1 |                        28,434 |    1.73× |

The call sites in `assistant-orchestrator.service.ts` are the initial `decide`,
the single `new_request` reclassification in `settleRelation`, `rankByRelevance`
and `compose`. They are awaited; no inference retry is added. Relevance is not
mutually exclusive with reclassification. Count every dispatched call, including
an aborted, timed-out, rejected or discarded response. Generation receipt recovery
is metadata GET, not another inference call. Place QA returns before these stages.

The orchestrator preflights complete bodies before invoking an adapter or counting
a model call. Overflow takes the existing deterministic fallback: decision uses
`invalid_response`, relevance preserves deterministic search order, composition
uses `invalid_output`. Trace `requestBytes={step,reason:'request_bytes'}` and
`assistant_fallbacks_total{reason='request_bytes'}` contain only closed labels.
Each real adapter serializes **once**, checks that exact string before billing
`start`, then hands the same string to `fetch`. Jev's per-call option can tighten
but cannot enlarge its adapter ceiling; relevance passes the smaller ceiling.
This second check also covers actual adapter model IDs/temperature and future body
fields that differ from preflight. Adapter-side rejections use the same closed
reason and undo the tentative in-memory call count without creating an unknown
paid attempt. No over-cap HTTP body leaves either adapter.

## Deterministic truncation

Normal data stays in its original order. Size-triggered truncation has an explicit
stable priority and retains only existing data; authoritative application data is
never mutated or replaced with model output.

- Intent base request: 24,576 JSON bytes for state plus questions. On overflow,
  prioritize category, suitability, mood, setting; within each kind sort by stable
  key, then label using code-unit lexical ordering. Drop the lowest-priority tail
  of whole terms. State and corresponding criteria/questions are rebuilt together.
  Stable keys are never shortened or remapped. Synonyms stay local to fallback.
- Resolved payload: 4,096 JSON bytes, enforced both when constructing it in
  `reconcile.ts` and at both decision builders. Retain settled before assumed,
  then open, then labels; lexical ties. Objects retain whole keys and fitting
  value prefixes; overflowing string arrays retain whole lexically ordered items.
  Strings retain a prefix within the JSON-escaped byte allowance. Empty containers
  represent omitted data, never newly inferred facts.
- Relevance: six candidates maximum, search order retained. Candidate descriptions
  retain a prefix of at most 1,024 JSON bytes including quotes, with the name first.
  Candidate tag labels use the 1,024-byte list budget below before concatenation.
- Grounding: constraints have a 4,096-byte JSON-list budget; explicit precedes
  assumed, then unknown, with name/value lexical ties. Each preference/tag list
  has a 1,024-byte JSON-list budget and lexical overflow order. Whole items are
  dropped. Occasion and plan text fields use the existing 200-code-unit context
  name cap. Keep the first three ranked places and guide sections.
- Existing message/history/name/excerpt UTF-16 caps retain their values; slicing
  avoids splitting a surrogate pair. History keeps the newest four turns of at
  most 400 code units, message 2,000, guide excerpt 1,200, context name 200.

These subfield allowances help preserve useful requests. They are not added up as
a proof: escaping/rendering can expand bytes, and an irreducible field or future
prompt change can exceed the final envelope. The complete-body guard remains the
last authority and refuses dispatch after truncation if necessary.

Every new numeric cap and per-turn call maximum is exposed as a flat field in
`billingConfiguration()`. Revision is `assistant-905-request-bytes-v2`; its hash
changes, invalidating old descriptions. Byte limits/topology live in providers;
builders own the subfield budgets. The fingerprint remains configuration evidence,
not a certificate or provider billing guarantee.

## Measurement and regression basis

`request-caps.regression.spec.ts` reads the actual `TAXONOMY` literal from
`libs/database/src/seed.ts`, passes rows through `AssistantTaxonomyService.taxonomy()`
and exercises production builders. It does not read credentials or call a model.
The fixture has **21 terms: 8 category, 5 mood, 4 setting, 4 suitability**.
The mapped taxonomy object is **1,360 JSON bytes**. This is a reproducible seed
measurement, **not a live DEV taxonomy snapshot**; live size is UNVERIFIED.

Measured complete bodies:

| Fixture                                                                                                                  | Decision bytes | Relevance bytes | Haiku bytes |
| ------------------------------------------------------------------------------------------------------------------------ | -------------: | --------------: | ----------: |
| Ordinary Vietnamese request, pending question/resolved state; six relevance candidates; three guides/places plus history |          7,442 |           2,030 |      12,949 |
| Existing `worstCases(seedTaxonomy, 600)` fixture, using all existing character caps                                      |         12,651 |           9,497 |      28,434 |

Vietnamese system prompt alone is **2,046 UTF-8 bytes**. Existing search-eval
`SEED_TAXONOMY` has 20 terms (omits `work_reading`) and its simple assistant decision
body is **5,813 bytes**. The larger database seed and worst-case fixture determined
the caps, with headroom. Neither fixture size is substituted for a hard cap.

The ordinary decision/relevance/Haiku JSON SHA-256 snapshots were compared with
GitHub `namnh92/GoGo-BE` branch `re-design`; all three are byte-identical:

```text
decision f10d09979e91e7aebcbd0fc8f821198da44597bfa71478683c05ae9a2a105af0
relevance ea127835ac63e9118c537b6f99bc5d18872b62600a58f6d623b1000d11d4231c
haiku 403495106fd6832a82c0bfff78d481ad31ec82c9db8d082be5de1de9fd803905
```

No git command was used. Baseline source was fetched read-only through the GitHub
connector and installed in `/tmp/be-905-baseline`; existing dependencies were reused.
The five pre-change source files matched the remote Git blob IDs exactly:

| Path                                              | Remote blob ID                           |
| ------------------------------------------------- | ---------------------------------------- |
| assistant/domain/decision.ts                      | 130475641c1ef515c2b8a4a3a1d13068fd345f19 |
| assistant/domain/grounding.ts                     | 526b69c164fef97dcb475f6bec324d84b22a3a88 |
| search/domain/intent.ts                           | b551be43f23b1837996c09cbd89d800b48c44154 |
| providers/src/openrouter-decisions.adapter.ts     | 4f6da56b7142897c93108b3c8fcdafb2277a7e2a |
| providers/src/openrouter-assistant-llm.adapter.ts | 486c47523e2b846b752f968022f1c7906e6459e8 |

Eight unchanged overflow regressions failed on that baseline for the intended reason:

| Case                                 | Before                                  | After                                  |
| ------------------------------------ | --------------------------------------- | -------------------------------------- |
| Large taxonomy                       | 168,895-byte decision exceeds 32,768    | bounded, deterministic state/questions |
| Large resolved data                  | 403,620-byte decision exceeds 32,768    | bounded in decision and relevance      |
| Candidate labels                     | 1,141,607-byte relevance exceeds 16,384 | bounded descriptions                   |
| Constraints/preferences/tags/history | 815,042-byte Haiku body exceeds 49,152  | bounded composition                    |
| Irreducible Jev HTTP body            | HTTP dispatch occurred                  | no billing start or HTTP dispatch      |
| Irreducible Haiku HTTP body          | HTTP dispatch occurred                  | no billing start or HTTP dispatch      |

## Formula for Astra

Let `D=32768`, `R=16384`, `H=49152` be complete body byte caps. Let `F_D`, `F_R`
and `F_H` be certified upper bounds on additional billable input framing tokens
per call (including provider-side serialization/instructions/expansion).

**UNVERIFIED framing/tokenizer assumption:** for each configured provider/tokenizer,
`maxInputTokens <= UTF-8 bytes of the exact sent JSON body + F_call`. In particular,
Jev consumes `state + questions` through its own prompt construction; a JSON byte
cap alone does not prove its billed token expansion. Astra must establish finite
framing bounds and that hidden attempts, reasoning, cache writes, route tariffs,
errors and aborts introduce no billable component outside this envelope.

Using owner pricing, Jev input is `42 / 1e9 = 4.2e-8 USD/token`, output free.
Haiku input/output are `1e-7 / 5e-7 USD/token` **below 100,000 input tokens**.
Use the unchanged DEV output cap `O=600`; other configurations must use their
fingerprinted `maxOutputTokens`. Charge the full cap even on abort/error.

```text
B = Σ_calls(maxInputTokens × inPrice + maxOutputTokens × outPrice) + BYOK fee

B <= 2 × (D + F_D) × 4.2e-8
     + (R + F_R) × 4.2e-8
     + [(H + F_H) × 1e-7 + O × 5e-7] × 1.05

For O=600:
B <= 0.0089166 + 8.4e-8 × F_D + 4.2e-8 × F_R + 1.05e-7 × F_H USD
```

The 5% fee applies to comparable list-price Haiku inference (assume no remaining
free BYOK allowance), not to Jev or to credit purchases. The formula assumes that
the supplied Haiku tariff is also the fee's comparable list price; Astra must
verify this and the absence of cache-write/surcharge charges. Require
`49152 + F_H < 100000`; otherwise this low-tier formula is invalid and Astra must
use the appropriate higher tariff. Do not replace `F` by zero without evidence.
`0.0089166` is an algebraic constant, **not a certified B or configured hold**.
After certification, required credits remain `ceil(B / 0.00001)`.

## Validation and limits

Local evidence is under `/tmp/be-905-evidence/` (command logs; no prompt/PII capture).
Gate results are recorded in the table below. Public OpenAPI/event shapes
are unchanged; no schema, database, deployment or live-provider write is required.
The serial database integration attempt is BLOCKED: Testcontainers reports
`Could not find a working container runtime strategy`. Do not treat its 910 skipped
tests as passing. Live inference, DEV deployment and financial acceptance remain
UNVERIFIED.

Rollback uses the existing assistant kill switch; retain compatible accounting
and evidence code. Restoring old code does not make an old B certificate valid;
re-certify against the exact configuration fingerprint before paid activation.

| Check                                                   | Result                                                                                       | Evidence log                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm lint`                                             | PASS after fixing test diagnostic lint                                                       | `lint-last.log`                                      |
| `pnpm format:check`                                     | PASS, including documentation                                                                | `format-complete.log`                                |
| `pnpm typecheck`                                        | PASS, all 8 packages                                                                         | `typecheck-complete.log`                             |
| `pnpm api:check`                                        | PASS                                                                                         | `api-check.log`                                      |
| `pnpm api:routes`                                       | PASS                                                                                         | `api-routes.log`                                     |
| `pnpm check:boundaries`                                 | PASS                                                                                         | `boundaries-final.log`                               |
| `pnpm test`                                             | Initial run: 5,353 passed, 2 timing failures, 1 Sentry socket setup blocked                  | `unit.log`                                           |
| Final `pnpm test --maxWorkers=2`                        | 5,361 passed; timing failures cleared; Sentry setup still BLOCKED (`listen EPERM 127.0.0.1`) | `unit-final.log`                                     |
| Focused assistant/provider unit suites                  | PASS, 1,514 tests; additional final taxonomy/resolved cases PASS (9 regression cases total)  | `assistant-unit-final.log`, `measurements-final.log` |
| Serial request-cap integration                          | PASS, 10 tests, including actual-body drift and QA zero calls                                | `integration-caps-last.log`                          |
| Serial DB assistant / QA S3 / S3 fence / S4 integration | BLOCKED: no working container runtime; 910 tests skipped during fixture setup                | `integration-assistant.log`                          |
| `pnpm build`                                            | PASS, API + worker                                                                           | `build-final.log`                                    |
| FAIL-before on remote `re-design` source                | 8 intended failures; normal shape snapshot PASS                                              | `fail-before-final.log`                              |

The focused request-cap integration command is:

```sh
pnpm exec vitest run --project integration libs/modules/assistant/application/request-caps.int.spec.ts --no-file-parallelism
```

The database integration command was:

```sh
pnpm exec vitest run --project integration apps/api/test/assistant.int.spec.ts apps/api/test/assistant-place-qa-s3.int.spec.ts apps/api/test/assistant-place-qa-s3-fence.int.spec.ts apps/api/test/assistant-place-qa-s4.int.spec.ts --no-file-parallelism
```

The two timing failures in the first unit run were the existing grounding name-chain
performance threshold and realtime property-test timeout. Both passed in the full
rerun with two workers; assertions/timeouts were not changed. The final full run had 368 passing files and one blocked suite (369 files total).
The Sentry socket
restriction and unavailable container runtime remain environment blockers; no
permissions were escalated and no tests were deleted, weakened or marked passed.

## Tóm tắt tiếng Việt

Đã bổ sung trần cứng theo byte UTF-8 của toàn bộ JSON gửi ra provider: Jev decision
32 KiB × tối đa 2, relevance 16 KiB × 1, Haiku 48 KiB × 1. Dữ liệu quá lớn được cắt
có thứ tự, giữ nguyên khóa; còn vượt trần thì không dispatch và dùng fallback tất
định. Test tích hợp `place_qa` xác nhận 0 lời gọi model. Không nới lượt miễn phí,
budget hay output cap. Revision/hash cấu hình đã đổi. Astra còn phải xác minh
framing/tokenizer, tariff và các thành phần phí trước khi chứng nhận B nhỏ và bật
trả phí; phép đo fixture không thay thế nghiệm thu DEV. Lint, format, typecheck,
API, boundaries và build PASS; 5.361 unit test PASS, còn suite Sentry bị chặn
bởi quyền mở socket. 10 test tích hợp request-cap PASS; 910 test DB chưa chạy
vì không có container runtime.
