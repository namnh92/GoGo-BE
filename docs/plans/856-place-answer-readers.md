# BE#856 — S1 place-answer compatibility floor

Authority: Astra rev3 (`dev/handoffs/sa-shape-be-844-ai-place-qa.rev3.astra.md`),
particularly §§3.3–3.5, 7–11 and S1 in §9. Owner decisions dated 2026-11-11:
Q-1a and Q-1b apply to S6/S7; Q-2 permits direct missing-price wording only and
never changes eligibility. Base supplied by the owner: `origin/re-design`
`8ee29556`. No git commands were used, so no live branch/head attestation is made.

## Implemented scope

- Closed version-1 semantic grammar, locale and stable day semantics; pure
  `renderPlaceAnswer`; typed immutable `PlaceFactContext` and `PlaceFactsReader`.
- Complete reference-group rendering at live/replay, history and CMS boundaries;
  bounded identity-only previews/search snippets; ID/query-only export; atomic
  stored preview/truncation. Existing ownership/deletion checks remain the entry
  points. Facts never flow back into the row, Redis buffer, trace or export.
- Per-group fixed error delivery, read cancellation, absolute deadlines,
  token-ready versus first-delivered-text observability. No source aggregate
  date substituted for field evidence. Cards/chips/prose share eligibility.
- ADR-0055 amends ADR-0036. MINOR OpenAPI `10.1.0-alpha.1`, generated d.ts,
  changelog and all five current contract-version pins.

S1 does **not** implement S2's SQL projection, a production emitter, classifier,
hook, new QA state/selection validation, recommendation-history exclusion,
resolution, aliases or feature enablement. Those remain S2–S5 as §9 assigns.
The trace marker and complete-group writer obligations below are S3 prerequisites;
this slice never makes an existing QA route operational.

## Private grammar v1

Actual U+E000 / U+E001 delimiters surround
`a1:<lowercase-uuid>:<vi|en>:<topic>[:key=value…]`. Never send the delimiters to a
client or use untrusted text as a token. Strip delimiters from user/model text.
Supported topics: hours, price, address, directions, parking, amenity,
suitability, rating, contact, overview, out_of_data. Compare uses two independently
rendered topic queries; no comparison verdict token exists.

- Hours requires `day=weekday,d=0..6` (Sunday=0), or
  `day=date,date=YYYY-MM-DD,d=0..6,tz=Asia/Ho_Chi_Minh`. Validate the calendar date
  and its weekday. Relative/default dates must resolve once at admission in S3;
  the renderer never recomputes them. Concrete dates always show regular weekly
  hours plus a warning about unavailable holiday/special-day exceptions.
- Amenity requires `k`; parking optionally uses `k` (default parking). Suitability
  accepts `s` and/or `n`. Out-of-data optionally accepts `n`. Keys use
  `[a-z][a-z0-9_-]{0,63}`; S2's eligible taxonomy projection is the value allowlist.
  Capacity `n=1..99` is always unsupported data, never inferred from suitability.
  Invalid capacity becomes fixed unsupported wording without a lookup/clamp.
- Other arguments, duplicate keys, unknown versions/topics, invalid dates,
  incomplete references and tokens above 512 UTF-8 bytes are invalid. Max eight
  answer tokens/message and two distinct fact-answer IDs. Clarification can use
  three existing `place:<uuid>` identity references independently.
- Export replaces queries with public ID/topic/day/key labels, without facts or
  a DB read. Invalid private runs become neutral labels. Token-safe truncation
  discards the entire token when its end would exceed the cut.
- One whole-message validator (`answerMessageValidity`, built on
  `parseReferenceGroup` and `referenceOnlyText`) serves every read surface. SSE,
  history, CMS, the search snippet and the export read the complete row with
  its trace and apply the full grammar: reference-only text, kind-specific
  coverage, no zero-query answer/compare group, no source query absent from the
  text. The stored conversation preview is truncated and has no trace, so it
  applies the text half (references and separators only, limits). An invalid
  message is neutralized whole (one neutral label, `unknown_token`, no identity
  or fact read), and finalization leaves no preview for it (`storedPreview`).

## Reference-only group and S3 writer obligations

The runner persists `trace.streamRoute` (`place_qa` or `ordinary`) under its streaming lease **before** the first buffer append, and preserves it through finalization. QA writers set `trace.route='place_qa'` before emitting any frames (including steps/cards). The marker write is shared by all append batches; a failed/refused write prevents pre-commit buffer publication. Its `trace.placeAnswerGroup` is a strict, versioned object:

```ts
{
  v: 1,
  kind: 'answer' | 'compare' | 'clarification',
  prompt?: 'place_choice' | 'place_confirm', // clarification only
  cards: string[], // lower-case UUIDs; answer <=1, compare =2, clarification <=3
  sources: string[], // semantic tokens for queries actually in the answer text
  options: (
    {id: string, query: string} | // eligible topic query, <=3
    {id: string, placeId: string} | {id: string, none: true} // clarification
  )[]
}
```

Query references contain semantic intent, never outcomes/facts or old labels.
Card IDs must cover all text/source/option references. Answers require a text query; compares require a text query for each of their two distinct places. Clarifications require identity references for every candidate and no answer queries. Text contains only references separated by ASCII spaces, tabs, CR/LF, commas, semicolons or pipes; residual prose is invalid. Every source query must occur semantically in the text. Invalid groups are neutralized before any fact lookup.
Clarifications have <=3 candidates plus one “none” option. Store option keys/IDs;
render labels from the current snapshot. S1 emits label/text only; optional wire
option IDs stay reserved until S3/S4. Candidate labels use stable card ordinals plus current names and remain within the public 40/200-character bounds; typed ordinal text does not prove a historical chip source. S3 must validate the latest pending context and require confirmation for unbound ambiguous replies (§4.5).

Persist the complete token text, card reference frames, empty source/follow-up
placeholder frames, and terminal frame atomically with the group. Source values
must exist only in the reader result; `assistant_message_sources` must not store
rendered QA sources. Readers replace placeholders, never append facts to stored
frames. Frames keep committed sequence IDs; replay loads the entire group before
selecting `seq > Last-Event-ID`. Invalid groups cannot widen lookups. Unknown
private syntax produces neutral text plus `unknown_token` metrics.

The writer must preserve semantic/config versions, route and question association
through stop/finalization/reaper paths in S3. It must implement authorized source
binding/history filtering before it can emit. S1 does not claim those S3 behaviors.

## Projection contract for S2

`placeFacts(ids, {signal, deadlineAt})` resolves all requested IDs in **one batched
statement**. IDs come only from already authorized stored rows. Missing IDs mean
unavailable. DB failure, timeout and cancellation reject; an adapter must never
return an empty successful map for those conditions. It must bound statement and
pool work by the absolute deadline and propagate cancellation; no provider call,
new provider-content snapshot/cache or per-card query is permitted.

Return current publication/provider-closure verdict and canonical identity with
field-specific typed values, verified-current/reference tiers, actual verification
and collection dates, and source kind. `PlaceFacts` defines the exact interface.
Hours contain one complete schedule per weekday: `{day, intervals: VerifiedFact<ScheduleInterval>[]}`. Each interval keeps its actual verification date, collection date, source and tier. Validate the combined weekday (including overlap/overnight/closed/24h consistency); if any interval lacks eligible evidence, suppress the entire weekday rather than display an incomplete schedule. Independently dated price rows and taxonomy assignments retain their own bundles and adjacent dates. Only fields passing rev3 §3.4 may be present; no evidence path means suppression. S1’s `PlaceFactsReader` is canonical: S2 adapts its internal projection to `{signal, deadlineAt}`, `ReadonlyMap`, these value/evidence shapes, unavailable omissions, error rejection and cancellation. No casts or invented dates/labels/policy; suppress fields without evidence. Only this reader records `assistant_place_facts_duration_seconds`; S2 must not emit a second observation with `surface=projection`. Bind the adapter to `PLACE_FACTS_READER`.
Ownership/publication/active vocabulary alone never establish verification.
No invented TTL. Provider ratings have a separate current-source projection and
render only on the existing attributed Google card contract, never as GoGo-verified
prose. GoGo community ratings retain their independent count/threshold.

The reader clones/freezes projection values before rendering. It rejects a map
entry whose place ID differs from its key. At most 3 IDs per SSE group; at most
30 per history/CMS page. Whole overflow messages get generic labels/minimal label
cards and no further lookup. Preview reads <=30 identities under its own 2-second
response and transaction-local statement budget. Export reads no facts.

## Failure and time semantics

- Gone/unpublished/provider-closed: no facts, unavailable sentence/minimal card.
- Projection missing, DB error or renderer failure: localized load-error text;
  no affected cards, sources or options. History/CMS retain persisted producer
  status (not a false catalogue verdict). Live/replay use the existing error frame
  and omit a successful done. A complete producer is not successful delivery.
- Timeout: same fixed text and omissions; SSE code `ASSISTANT_RENDER_TIMEOUT`.
  Read error code `ASSISTANT_RENDER_FAILED`. Both are retryable.
- Live reads use `min(2s, acceptedAt + firstTextAllowance - now)`; expired means
  zero new read. Finished initial attachment is replay. Reconnect/history/CMS use
  their own 2s. All rendering work counts toward that absolute deadline.
- Disconnect cancels reader work only. Explicit stop/delete retain existing
  lifecycle and funding semantics. No reader retries a timed-out fact call.

Metrics with closed surface/result labels and no name/text/ID:
`assistant_place_answer_render_total{mode,result}` (including unknown-token preview/export diagnostics),
`assistant_place_facts_duration_seconds{surface}`,
`assistant_place_answer_token_ready_seconds` (producer),
`assistant_place_answer_first_visible_text_seconds{mode=live}` (actual SSE delivery).
First nonempty text is observed separately, including fixed error text; successful
fact delivery is determined by the render-result metric, never token readiness.
No classifier/resolution/QA-route turn metric is fabricated in S1.

## Contract activation and rollback

10.1 adds optional option `id` plus paired optional send `replyToMessageId` /
`followUpOptionId`. Both or neither is documented on the fields and enforced by
the server with `400 VALIDATION_FAILED`; the schema has no `dependentRequired`,
which oasdiff counts as a breaking request constraint and a MINOR cannot add.
They carry `x-gogo-planned`: S1 specifies/generates them; the current strict
send DTO still refuses these fields, alone or paired, until S3 implements
validation/state (accepting and ignoring a pair would fall through to an
ordinary turn). S1 never emits option IDs. S4 must
provide the generated-client consumer, omit metadata on manually typed text and
prove compatibility before enablement. Existing text clients keep their contract.
Source-bound validation must check latest accessible source, expiry, kind and
config; stale/disabled choices never resume recommendations.

Once any answer reference is written, no binary older than S1 may be deployed.
Flag-off stops new emission, not compatible reads. S3 stays dark; #844's complete
acceptance requires S4 + S5 and DEV's five-step acceptance chain. Q-1a/Q-1b are
separate S6/S7. S1 does not enable a flag or change admission/model/cost bounds.

## Validation and evidence

`856-evidence/fail-before.txt`: the same existing-boundary test failed on the
initial worktree for two intended assertions: private-token export leak and
unrendered identity preview. Truncation already passed. This is unit-level
FAIL-before, **not** Layer A incident regression proof or a SHA-verified baseline.
No git commands were used. The owner-supplied base above identifies the intended
baseline; the final changed-file hashes bind local artifacts.

Focused unit/property tests cover strict grammar and malformed/injected runs,
weekdays/dates, count/ID limits, every template topic, price currency/minor units,
zero/invalid units, verified-reference warnings, open-world amenities, capacity,
ratings, whole snapshot consistency, changed eligibility, source/topic suppression,
page overflow, all read errors, cancellation, deadline expiry, producer completion
followed by reader failure, and Last-Event-ID sequence preservation. Existing
sanitizer, stream, runner and assistant contract specs are regression checks.

`apps/api/test/assistant-place-answer.int.spec.ts` is **written, NOT RUN locally**
(owner requested DEV execution). It uses the existing Testcontainers/PostGIS API
fixture and a test-only server-authored projection, not an S2 implementation:
live/reconnect, history, CMS, preview/search, export, storage/buffer privacy,
ownership, changed/unavailable facts, error after producer completion, timeout/cancellation, deletion and retention purge.
Timeout/cancel and retention-purge cells are also written for the real reader/DB boundary, with deterministic unit coverage. DEV must run this
suite and obtain independent review; local checks do not establish acceptance.

## Shape dispositions

No scope expansion into S2/S3. OpenAPI follow-up fields are intentionally
specified/generated/planned rather than accepted by the send DTO in S1: §8
assigns BE validation/state to S3 and consumer submission to S4. This is an
activation boundary, not an emitted but ignored control.

A reader-only timeout before producer commit has no SSE `id`, so it cannot move
`Last-Event-ID` past future committed frames. Its body uses the existing delta
and error envelope. Committed-group errors preserve their committed sequence.
The shape does not prescribe reader-only sequence IDs; this choice protects
its reconnect and cancellation rules. A QA marker written after attachment is
rechecked before any buffered card/fact is released.

CMS now excludes expired conversation rows before hydrating them, even before
retention purge; this applies the normal retention boundary to the moderation
read rather than relying on purge timing. No factual content is persisted.

FAIL-before is local unit evidence on the initial supplied worktree, not a
Layer A integration/head assertion. Integration execution and acceptance are
explicitly left to DEV, as requested. No independent review, CI, merge, deploy,
provider calls, feature enablement or git commands were performed.

## Final local result and file inventory

253 focused unit/property/contract/regression tests passed (17 files); the final
reader-only label refinement passed its 24-test rerun. Typecheck passed all eight
packages. API generation, `api:version`, `api:check`, changed-file ESLint and
Prettier checks passed. Testcontainers integration is written and deliberately
NOT RUN locally; DEV executes it. No acceptance or independent review claim.

[Exact commands/results](856-evidence/validation.md),
[complete source and evidence manifest](856-evidence/changed-files.txt),
[content hashes](856-evidence/files.sha256).

The inventory includes the small metrics-only plumbing through both self-service
and sealed export paths, the observability registry/operator table, five contract
version pins, OpenAPI and generated d.ts, the ADR amendment, S1 implementation and
server-authored tests. No production emitter, classifier, hook or SQL fact
projection was added.

## Round-1 stream corrections

An attachment retains its ordinary route classification after admission or one
classification refresh before releasing its first buffered batch. The periodic
2-second lifecycle/deletion check remains. QA token/route detection still diverts
late QA groups into atomic committed rendering. An independent absolute live
deadline covers buffer reads, metadata reads, buffer waits and rendering from the
accepted-turn timestamp; expiry sends the unnumbered reader-only timeout, aborts
reader work and closes the attachment without settling the producer. Ordinary
classification clears that deadline; established ordinary batches add no reads.
