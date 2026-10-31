# GoGo AI assistant — module design (GoGo-BE#713)

Status: **module built (PR 3, contract 2.0.0-alpha.4 — every `/assistant/*` and
`/cms/assistant/*` operation served, `x-gogo-planned` removed).** Runtime models
and billing are ADR-0036: Jev (`typesafe/jev-1.14`, OpenRouter Decisions API,
OpenRouter-direct billing) decides; the backend executes and validates; Claude
Haiku (`anthropic/claude-haiku-5.5`, OpenRouter Chat Completions, Anthropic
BYOK) explains. See [As built](#as-built-pr-3) for where the implementation
deliberately differs from the sketch below. The SA decisions applied in
2.0.0-alpha.3 are listed under [Decisions](#decisions-sa-on-gogo-be713-owner-delegated).

Authorities: epic GoGo-MobileApp#377 (owner decisions 2026-10-26 are binding),
GoGo-CMS#249 (console),
the GoGo AI design system (conversation rules: sources, ConfirmationCard,
TaskSummary, FollowUps, StateNotice, Stop keeps partial text), and the hard
rules in `CLAUDE.md`.

## Owner decisions this design takes as given

| Topic       | Decision (MobileApp#377, 2026-10-26)                                             |
| ----------- | -------------------------------------------------------------------------------- |
| Source docs | "GoGo guide" lives in the CMS: versions, publish / unpublish, audit              |
| Guests      | Not allowed. Entry visible, API answers `403 USER_ONLY`                          |
| History     | Server-side per account, 90-day retention, deleted on account deletion / privacy |
| Attachments | Images only                                                                      |
| Deep link   | None                                                                             |

## Surface (contract summary)

App, registered users only:

- `GET /assistant/status` — `enabled | disabled | limit_reached`, remaining today.
- Conversations: `GET|POST /assistant/conversations` (cursor on
  `(lastMessageAt, id)`, `q` searches title + message text),
  `GET|PATCH|DELETE /assistant/conversations/{id}`.
- Messages: `GET …/{id}/messages` (newest first), `POST …/{id}/messages`
  (`Idempotency-Key` required → `202` with the user turn and a `streaming`
  assistant turn), `GET …/messages/{messageId}/stream` (SSE),
  `POST …/messages/{messageId}/stop`, `PUT|DELETE …/messages/{messageId}/feedback`.
- Proposals: `GET /assistant/proposals/{id}`, `POST …/confirm`
  (`Idempotency-Key` required; the only write), `POST …/dismiss`.

CMS:

- `/cms/assistant/documents` list/create, `/{id}` get/patch-draft,
  `/{id}/publish`, `/{id}/unpublish`, `/{id}/versions`, `/{id}/versions/{versionId}`.
- `/cms/assistant/feedback` — moderator queue, minimal PII, read-only;
  `moderator`, `ops_admin`, `super_admin` only (not `editor`).
- Kill switch: **no new endpoint.** Feature flag `assistant.enabled` through
  the existing `PUT /cms/feature-flags/{key}` (`ops_admin`, audited, with the
  operator's `reason` — Q7). The key is
  added to `FEATURE_FLAGS` in the PR that reads it (registry rule: a key ships
  with its reader), default **off**, `platformScoped: false`.

### Why send + stream are two calls

`POST` that answers with a stream would need a second SSE client in the app
(`EventSource` is GET-only), could not resume after a dropped connection
without re-sending the question, and makes the idempotent retry of a send
ambiguous. So `POST …/messages` is short and idempotent, and the reply is a
`GET` stream with `Last-Event-ID`, exactly like `GET /rooms/{id}/events`. Frames
are kept per message (in Redis for the live window, folded into the message row
at `done`), so a reconnect replays from the last id.

### CMS roles

| Action                    | Roles                                          | Why                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read documents / versions | `editor`, `moderator`, `ops_admin` (read rule) | BE-IMP-008 hierarchical read: controller declares `editor, ops_admin`; `moderator` (rank 1) reads as a peer.                                                                                                |
| Create / edit draft       | `editor`, `ops_admin`                          | Same as banners, plan templates and recommendations: user-visible content copy.                                                                                                                             |
| Publish / unpublish       | `ops_admin`                                    | Changes what the AI tells every user — a release decision, split from authoring like safety rules / campaigns.                                                                                              |
| Feedback queue            | `moderator`, `ops_admin`, `super_admin` only   | **Explicit exception to rank-read (Q8):** `editor` and `moderator` are both rank 1, so the read rule would admit editors. Private conversational material → narrower access. Editors get `403 ROLE_DENIED`. |
| Kill switch               | `ops_admin`                                    | Existing feature-flag endpoint; `reason` recorded in the audit entry (Q7).                                                                                                                                  |

The feedback exception needs enforcement the guard does not have today:
`RequireRole('moderator', 'ops_admin')` alone still lets an `editor` read
(BE-IMP-008, `admin.guard.ts` `ROLE_RANK`). The module PR that serves the route
adds an exact-role read for it (no rank read) and a test that an editor is
refused; document routes keep the hierarchical rule.

Every write goes through `CmsAuditService` (`resourceType = assistant_document`,
actions `created | draft_updated | published | unpublished`) with before/after.

## Module layout

```
libs/modules/assistant/
  domain/          conversation, message, proposal, guide-document (+ version) entities;
                   invariants: one streaming turn per conversation, proposal state
                   machine (pending → confirmed | dismissed | expired), allowlist type
  application/     send-message, stream-reply (orchestrator), stop, confirm-proposal,
                   conversation CRUD/search, guide-document CMS use cases,
                   retention job, privacy erasure hook
  infrastructure/  Drizzle repos (assistant_conversations, assistant_messages,
                   assistant_message_sources, assistant_proposals, assistant_feedback,
                   assistant_documents, assistant_document_versions), Redis stream
                   buffer, rate limiter, guide retrieval (Postgres FTS over published
                   versions — no vector store in v1)
  presentation/    AssistantController, AssistantCmsController (RequireRole), zod DTOs,
                   SSE writer reused from realtime, assistant.contract.spec.ts
libs/providers/src/
  assistant-llm.port.ts   AssistantLlmPort — abstract: stream(request, signal) yields text
                          chunks and structured tool outputs, then usage; typed errors
                          (timeout, unavailable, invalid output). Which provider, model
                          and credentials implement it is decided and wired separately
                          by the owner — out of scope for this design.
  fake.adapters.ts        FakeAssistantLlm for tests (scripted chunks, delays, errors)
```

`libs/providers` never imports `modules` (`check:boundaries`). The port takes
plain data; the orchestrator owns prompts. The module depends only on the port.

## Turn pipeline (one reply)

1. **Admit** (synchronous, inside `POST …/messages`): actor is a user
   (`USER_ONLY` otherwise) → kill switch and environment spending limit
   (`503 ASSISTANT_DISABLED`; an unconfigured limit refuses, never means
   unlimited) → per-minute burst and per-account daily limit (`429` with
   `Retry-After`) → no streaming turn in the conversation → context readable by the caller (existing place/plan read
   policy; `CONTEXT_NOT_FOUND` otherwise) → attachments are this actor's
   `assistant_image` keys. Store user message + `streaming` assistant message,
   enqueue the turn. Commit. No transaction is held across the model call.
2. **Ground**: retrieve top-k sections of **published** guide versions
   (pinned by `versionId` for this turn); if a context is set, load the
   place/plan facts the caller may read. Build the **allowlist**: place ids
   from context + from a deterministic search (`places/search` use case with
   the user's query and room constraints), plan/room ids the caller is a member
   of. The model never sees an id it may not return.
3. **Generate**: stream from `AssistantLlmPort`. Text deltas pass through.
   Structured outputs (cards, proposals, follow-ups, source citations) arrive
   as tool calls and are **validated server-side** before any frame is sent:
   - card / proposal ids ∉ allowlist → dropped and counted as a rejected output;
   - card facts are **never** taken from the model: the server reads them from
     verified data (`PlaceDetail` rules, `freshnessCheckedAt` → `checkedAt`);
   - source titles / descriptions come from the document version row; the
     model only cites an index;
   - proposal values are validated with the target endpoint's schema and the
     room's hard constraints (budget mode, couple ⇒ `total`, time window). The
     model may mark a value assumed; it can never mark a value the user did not
     state as `explicit` — origin is computed by the server from the user turns
     (a field is `explicit` only if it was parsed from user text or edited on
     the card).
4. **Timeout**: no first text within **15 s** (configurable, never above 15 s)
   → abort the call, emit `notice{kind: fallback, reason: timeout}`
   with the deterministic fallback (retrieved sources, if any, plus fixed
   follow-ups by i18n key), `done{status: fallback}`. Provider error / invalid
   output → same path with `reason: provider_unavailable | invalid_output`.
5. **End**: `done` (`complete | stopped | fallback | truncated`) or `error`; message row
   updated with final text, sources, card ids (not facts), proposal ids,
   status, and usage as reported by the port.

**Stop**: `POST …/stop` sets a Redis cancel flag the orchestrator polls between
chunks and aborts the port call (`AbortSignal`); the text so far is
stored, `status: stopped`. Idempotent.

**No information**: if retrieval returns nothing relevant and no tool applies,
the model is instructed to answer with the `empty` notice; the server also
emits `notice{kind: empty}` when the reply cites no source for a product
question. The assistant must never describe a feature GoGo has not defined —
the system prompt restricts product claims to cited guide sections.

## Proposal / confirm

- A proposal row stores `kind`, `values[] {field, value, origin}`, the
  conversation owner, `expiresAt` (30 min by default).
- `confirm` (Idempotency-Key required, existing `idempotency.interceptor`):
  load proposal for this owner → state `pending` and not expired → merge edited
  values (become `explicit`) → re-check ids against what the caller can reach
  **now** → call the existing application service behind
  `createRoom`, `createInvite`, `castVote` or `finalizeVotes` with the **user
  as actor**, so the existing policy decides (`HOST_ONLY` for
  member/guest finalizing, room state conflicts) → read back the saved
  resource → store `result` → answer `AssistantProposalResult.savedValues`.
- Nothing else in the module writes rooms/plans/invites/votes. A test asserts
  that the stream path never calls those services.

## Data, retention, privacy

- Tables keyed by `user_id`; message text and attachments are personal data.
  Cards store ids only — **no copy of place facts** (no new persistent Google
  content; facts are rehydrated from verified data on read).
- Attachments: `POST /uploads` `purpose: assistant_image` (jpeg/png/webp,
  HEIC converted client-side), private prefix, short-lived signed URLs, owner
  only. Image bytes are passed to the model port only for that turn; nothing
  from the model side is stored except the reply.
- **Retention 90 days** (owner decision): a daily job in the
  worker, alongside `PrivacyJobs` (DB-010), hard-deletes conversations whose
  `lastMessageAt` is older than the window, cascading messages, sources,
  proposals, feedback and attachment objects; reports
  `assistantConversationsPurged` in the run report. Dry-run supported.
- **Account deletion / privacy request**: `UserContentService.deleteForUser`
  (ADR-0023) and the privacy-ledger execute path (ADR-0011) call
  `AssistantErasure.eraseForUser(userId)` — hard delete, not pseudonymize;
  ADR-0023's retention list gains "assistant conversations: deleted".
- **Logging**: never log message text, prompts, completions, attachments,
  context ids together with user ids, or credentials. Log `request_id`,
  conversation id hash, latency and status. Sentry events for the module
  must not carry request or response bodies (open: confirm the existing Sentry
  scrubber covers these routes, or add them).

## Behaviour the module guarantees (configuration is out of scope)

Provider, credentials, model choice, settings names and spend configuration are
handled separately by the owner and are deliberately not designed here. The
module only relies on these behaviours, which the contract already states:

| Situation                                                                      | Behaviour                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Kill switch off (feature flag `assistant.enabled`)                             | `503 ASSISTANT_DISABLED`; `GET /assistant/status` → `disabled`                                                                 |
| Environment cannot take new replies (spending limit reached or not configured) | `503 ASSISTANT_DISABLED` — unconfigured refuses, never unlimited                                                               |
| Per-account daily message limit spent (default 30 accepted/day, Q1)            | `429 ASSISTANT_DAILY_LIMIT` + `Retry-After` to the reset (midnight Asia/Ho_Chi_Minh); status → `limit_reached`                 |
| Per-minute burst (default 5 accepted in any rolling minute, Q1)                | `429 RATE_LIMITED` + `Retry-After`                                                                                             |
| Idempotent replay of a send                                                    | Same `202` (`x-idempotent-replay: true`); consumes no daily or burst allowance                                                 |
| Hard reply ceiling (length or time) hit (Q5)                                   | `done{status: truncated}`; partial text persisted; unfinished structured outputs discarded; no auto-continuation               |
| No first text within 15 s                                                      | `notice{fallback, timeout}` + `done{status: fallback}`, deterministic                                                          |
| Port error / invalid structured output                                         | Same fallback path (`provider_unavailable` / `invalid_output`); after text started, `error` frame and the partial text is kept |
| Kill switch turned off mid-reply                                               | `error` frame `ASSISTANT_DISABLED`; partial text kept                                                                          |
| Guest session                                                                  | `403 USER_ONLY`                                                                                                                |

Observability follows the repo's metric rules (closed label sets; never a user
id, conversation id or text): request outcomes, rejections by reason,
time-to-first-text and reply latency, errors by kind, rejected model outputs
(id not allowlisted, invalid card / proposal), proposal outcomes, feedback and
retention purges. Cost-side metrics and alerts belong to the separate
configuration work.

## Decisions (SA on GoGo-BE#713, owner-delegated)

Astra's answers on GoGo-BE#713, applied in contract 2.0.0-alpha.3 (the owner
delegated these, including the ones marked as owner calls). Each is reversible
as noted on the issue.

1. **Limits (Q1, owner call).** Per signed-in account: **30 accepted messages
   per day** and **5 in any rolling minute**, the day resetting at midnight
   Asia/Ho_Chi_Minh. These are provisional product limits, not capacity
   findings, and are configurable per environment. Only accepted sends count;
   idempotent replays consume nothing. An unset limit refuses — never
   unlimited. Clients read `dailyMessageLimit` / `messagesPerMinuteLimit` from
   `GET /assistant/status` and never hardcode them. Existing 429 codes and
   `Retry-After` are kept.
2. **Export (Q2, owner call).** `/me/export` and the secure `/me/exports` (one
   shared collector) gain `assistantConversations`: titles, each message's
   role, text, timestamps and terminal status, and the account's own feedback.
   Excluded: internal prompts, retrieval internals, upload keys. **Attachments
   are excluded pending explicit owner approval** of their portability scope.
   The field is optional in the contract and absent until the module lands —
   its collector populates it then. Ledger / delivery controls are unchanged;
   CMS operators still never receive raw exports.
3. **Original questions stay out of the feedback queue in v1 (Q3/Q10, owner
   call).** Known limitation: reply-only review sometimes cannot judge
   relevance, and a reply can itself repeat personal information. Any later
   access to the question is a separately authorized, audited disclosure of
   that turn, not full history.
4. **No delete proposals in v1 (Q4).** `AssistantProposalKind` stays
   `create_room | create_invite | cast_vote | finalize_plan`. Destructive
   conversational actions need their own preview, authorization and recovery
   design.
5. **`truncated` status (Q5).** Hitting the hard ceiling ends the reply as
   `done{status: truncated}` (also on `AssistantMessageStatus`): partial text
   persisted, unfinished structured outputs discarded. Mobile shows "Reply cut
   short" with an explicit retry; CMS displays the status. No automatic
   continuation. (Replaces the earlier "ends as `complete`" behaviour.)
6. **Keep `x-gogo-planned` during contract-first development (Q6).** No 503
   stubs. Each module PR removes the marker from the operations it serves
   (`pnpm api:routes` enforces both directions). Planned operations count as
   **unavailable** for integration and release readiness, not as working
   endpoints.
7. **Feature-flag `reason` (Q7).** `PUT /cms/feature-flags/{key}` takes
   `reason` (trimmed, 3–500, the bound of every other audited CMS write),
   stored in the `feature_flag.set` audit entry. Optional in 2.0.0-alpha.3 so
   older writers keep working; it becomes required in a later contract version,
   and the CMS always sends it — on every flag-editing surface, the assistant
   switch included. BE acceptance is implemented in this version.
8. **Feedback queue roles (Q8).** `moderator`, `ops_admin`, `super_admin` only
   — an explicit exception to rank-read (see CMS roles). Guide documents stay
   hierarchical.
9. **Feedback is read-only in v1 (Q9, owner call).** No resolve / assign
   workflow; the queue identifies guide corrections without implying tracked
   case resolution.
10. **Suggestion copy is fixed app i18n in v1 (Q11, owner call).** No
    CMS-managed interface copy and no endpoint for it; copy ships with the
    apps. Contextual reply follow-ups keep their existing contract.

Out of scope here (owner's separate configuration work): provider, credentials,
model choice, settings names and spend limits.

## As built (PR 3)

Where the implementation is more specific than (or differs from) the design above:

- **No fake LLM.** `FakeAssistantLlm` was not built (ADR-0036 forbids mock
  inference). Each model has its own key (GoGo-BE#731): Haiku on
  `OPENROUTER_ASSISTANT_API_KEY`, Jev on `OPENROUTER_API_KEY`. Without either one that
  model's binding is absent and sends answer `503 ASSISTANT_DISABLED`.
- **Pipeline** (`AssistantOrchestrator`): bounded history (6 turns) →
  `parseIntentFacts` → **one** Jev call (the #709 intent questions + `assistant_intent`,
  `action`, `needs_unverified_attribute`) → area through the published administrative
  dataset (`AssistantAreaResolver`) → `SearchService.search` (category, suitability,
  per-person price ceiling, `openAt` only for "now") → optional **one** Jev relevance
  call over ≤ 6 server-keyed candidates (only when a mood/setting was asked) → card
  re-validation (published, `priceMin ≤ budget`) → **one** Haiku stream → structured
  frames. Out-of-scope, empty results, clarification and every model failure before
  text use a deterministic reply built from validated data (`deterministicReply`).
- **Where turns run.** In the API process after the send commits, under a DB
  generation lease (`lease_owner`, `lease_expires_at`, renewed every 20 s, text
  checkpointed). A process that dies mid-reply loses the lease; the reaper (every API
  instance, every 60 s) ends the turn `failed` with the checkpointed text. The worker
  is not involved: since #265 it holds no Redis connection and polls Postgres, which
  would add seconds to time-to-first-text. Retention is in the worker's daily
  `PrivacyJobs` run.
- **Frames.** Redis list `assistant:frames:{messageId}` (TTL 1 h; in memory without
  `REDIS_URL`), `seq` = SSE `id`, folded into `assistant_messages.frames` at the
  terminal state. **Card frames store refs only** (`{kind, placeId}`); every SSE
  reader and every history read hydrates facts from verified data, so neither Redis
  nor the row keeps a copy of place facts.
- **Allowance and spend** read `assistant_usage_ledger`, not messages, so deleting a
  conversation neither refunds the day nor hides spend. Unknown cost is `NULL` in the
  ledger and counted at `ASSISTANT_TURN_COST_CEILING_USD` against the monthly ceiling.
- **Strict BYOK at runtime.** The Haiku request pins `provider.only = ['anthropic']`,
  `allow_fallbacks: false`, `reasoning.enabled: false`. Each call's `usage.is_byok`
  is recorded; an `is_byok: false` answer quarantines new sends for 10 minutes
  (`byok_unverified`) and logs `assistant.byok_violation`.
- **Cost Center.** Haiku runs on the backend key `gogo_be_*`; its activity items are
  filed under `openrouter.claude_byok` (OpenRouter's BYOK fee + meters) instead of
  `openrouter.decisions`, which stays Jev-only. The Anthropic inference itself is
  `anthropic.claude_byok` (existing collector). Nothing is counted twice.
- **Attachments** stay unavailable: `POST /uploads` does not accept
  `purpose: assistant_image` yet, so any attachment is `400 ATTACHMENT_INVALID`.
- **Proposals generated** from chat: `create_room` (any turn that asks to plan), and
  `create_invite` / `finalize_plan` when opened from a plan. `cast_vote` is
  confirmable but not yet proposed by the orchestrator. Invite codes are never stored
  in a proposal result.
- **Feedback queue ids** are keyed HMACs (row id, `conversationRef`), unlinkable to
  app ids.

### Astra round 1 (PR #717) — what changed

- **Place names are never stored (A-R-04, CLAUDE.md "no new persistent Google
  content").** A reply names a place by a token holding its id only
  (`domain/place-tokens.ts`, private-use delimiters). Haiku is told to write
  `[P1]`, `[P2]`…; the sanitizer turns those, and any listed name it wrote anyway,
  into tokens. The deterministic reply writes tokens. The message text, its frames,
  the buffer and the preview therefore hold ids; every read (history, SSE, export,
  moderation queue) renders today's name from `places`. Earlier replies reach Haiku
  with their places as "a place". Search over reply text no longer matches a place's
  name — accepted.
- **Budget (A-R-01).** The send re-reads readiness inside its transaction under a
  global `assistant:budget` advisory lock (after the account lock) and reserves the
  ledger row before releasing it.
- **Unsettled spend (A-R-02).** A turn finalized by a stop fallback or the reaper
  leaves its ledger row `unsettled`, counted at the per-turn ceiling; a live runner
  overwrites it with what it reported. A Haiku call with no OpenRouter fee reported
  is also unknown.
- **BYOK quarantine (A-R-03)** is read from the ledger (`haiku_is_byok = false`
  within the quarantine window), written the moment the violation is seen, so it
  holds on every replica and across restarts.
- **One first-text deadline (A-R-05)** over every stage; a stage still running when
  it passes is abandoned and the turn answers with a fixed "slower than usual"
  reply and a `timeout` fallback notice.
- **Cancellation (A-R-06)** is checked at every stage boundary, before the Haiku
  call, before the deterministic reply and before a proposal is prepared; a turn
  aborted while finishing ends as the abort says.
- **Confirm (A-R-07).** Only a 4xx refusal from the target use case releases a
  proposal to `pending`; any other failure may have followed a committed write, so
  the proposal stays claimed until it expires (`assistant_proposals_total
{outcome=ambiguous}`) — no second write.
- **Erasure (A-R-08).** Send replay records keep ids only and are rebuilt from the
  rows; erasure deletes the account's assistant replay records and lists recent
  replies in `assistant_buffer_purges`, drained by the reaper on every instance
  (live buffers dropped). Deleting a conversation drops its buffers directly; a
  runner that finds its row gone writes nothing more and drops its own.
- **Context place (A-R-09)** is a candidate only if the same search filters return
  it (with no area named, the search is anchored 2 km around it).
- **Frame holes (A-R-10).** The Redis buffer is read by `seq`, not list position;
  readers deliver only frames contiguous with `Last-Event-ID` and fill a hole from
  the finalized row.
- **Terminal frames (A-R-11)** are published only by the writer that finalized; the
  reaper re-checks lease expiry in its finalize statement.
- **Telemetry (A-R-12).** `q` on the assistant conversation search is redacted in
  request logs and Sentry (URL and query string).
- **Feedback queue cursor (A-R-13)** is sealed with AES-256-GCM.

### Astra round 2 (PR #717) — what changed

- **Names in any spelling (A-R2-02).** The sanitizer matches listed names
  case-, diacritic- and whitespace-insensitively, after any punctuation, and
  holds back enough text that a name split across deltas is judged whole. Owner
  decision 2026-10-27: Haiku may not shorten a name, so any run of two or more
  consecutive words of a listed name is replaced by its token too, and the
  prompt forbids parts, abbreviations, nicknames, translations and respellings.
  A respelling that matches none of these remains a residual of model prose.
- **Export (A-R2-03, owner decision 2026-10-27).** The export is stored, so a
  place in it reads "địa điểm GoGo (id)" — never a name.
- **Replay records (A-R2-04).** Conversation create stores the new id only and
  replays from the row; rename and stop are idempotent by themselves and store
  no replay body (`NoIdempotencyReplay`).
- **Preview (A-R2-05)** is truncated at a token boundary.
- **Abandoned stages (A-R2-06)** get the guard's signal: a stage the deadline
  abandoned starts no Jev call, and while any Jev call is in flight the turn's
  Jev cost is unknown, so a ledger settled early is counted at the ceiling.
- **Live buffer (A-R2-07)** is never awaited by the turn (at most 2 s when it
  ends); a stalled append leaves a hole the reader fills from the row.
- **Buffer purges (A-R2-08)** are queued in the conversation-delete transaction
  as well as in erasure, for every reply younger than the buffer's lifetime
  (`BUFFER_LIFETIME_SECONDS`); a failed drop keeps its row and is retried.
- **Losing writers (A-R2-09)** append nothing after an abort unless they win
  finalization, and a reader always ends with the committed terminal frame.
- **Telemetry (A-R2-10)** redacts every decoded `q` (repeated, `%71`) on the
  assistant search, in the URL and the query string.

### Astra round 3 (PR #717) — what changed

- **Exact names, never shortened (owner, 2026-10-27).** Haiku's reply may not
  carry wrong or shortened place information: every mention it makes is turned
  into a token, so the person always reads the full verified name.
- **Emoji (A-R3-01).** Name matching maps every UTF-16 unit, so an emoji before,
  between or after a name no longer lets the original name through.
- **Long whitespace (A-R3-02).** Text is held back while its last words could
  still begin a listed name, judged on the folded form — whatever whitespace
  follows — instead of a fixed length.
- **Visible-text deadline (A-R3-03).** Model text the sanitizer still holds back
  does not count as started: at the deadline the call ends and the
  deterministic reply is shown.
- **Tombstones (A-R3-04).** Dropping a buffer leaves a tombstone for its whole
  lifetime; an append still queued by a stale runner is refused atomically
  (Redis Lua), so purged content cannot reappear.
- **Input the search cannot place (owner, 2026-10-27).** An empty search says
  nothing was found and asks the person to re-enter the place, area or budget —
  it never guesses.
- Tech debt: A-R3-05 (a reconnect after the terminal frame receives it again,
  renumbered).

### Sol review (PR #717) — what changed

- **Two-stage sanitizer (S-F-01, S-F-02, S-F-04).** Hygiene (URLs, link targets,
  invalid citations and markers) runs first on text released to its last
  whitespace; names are judged afterwards on the hygienic text, so nothing
  removed can join two name words that were judged apart. The release cut is
  moved until it neither splits a complete name nor follows a possible name
  prefix (overlapping names). The prefix scan folds once and walks word starts
  only, so long whitespace costs nothing.
- **Bounded buffer writes (S-F-03).** The buffer's Redis client has no offline
  queue and a 5 s command timeout, and a runner issues no buffer write later
  than 30 s after its turn ends — so no write can land after a purge's
  tombstone (75 min) expires.
- **Sol round 2.** Names that begin with punctuation are held across deltas
  too (S2-F-01); the release loop folds once and walks spans from the end, so a
  long chain of overlapping names stays linear (S2-F-03); and every buffer
  write carries an absolute expiry (turn start + reply ceiling + 30 s) that
  Redis checks with its own clock in the same script as the tombstone, so a
  write delayed anywhere — a slow commit answer, the network — cannot land
  after a purge (S2-F-02).
- **DEV acceptance 2026-10-28.** A run of a name made only of common words
  (place types, food, cities, descriptors: "cà phê", "Sài Gòn") is no longer
  read as the name, and a run two listed names share is given to neither. On
  DEV the model's "quán cà phê" had become "Cà phê Đỗ Phủ - Biệt động Sài Gòn",
  so the reply described another place as that one. A full name is still
  matched whole, and a shortened name with an identifying word ("Đỗ Phủ") is
  still the name. A run two listed names share becomes a neutral label ("một
  trong các địa điểm trên") so it names neither place and stores no name; a
  word with no letter ("1") never identifies a place (Sol G-01, G-02).
- **New administrative addresses (owner, 2026-10-28).** Places are searched by
  the published post-2025 dataset only (province + ward/commune, no district);
  old names such as "Quận 1" are not mapped (the resolver's legacy-district →
  province fallback is removed, Sol N-02). An area the resolver cannot place,
  or places ambiguously, gets "Mình chưa nhận ra khu vực bạn nhập…" asking for a
  new address with an example; a message with no area asks for one in the same
  form, and it is never composed by the model, even with conflicting
  preferences (Sol N-01). Neither case guesses or searches nationwide.

Configuration (`apps/api/src/config/env.ts`), named after the GoGo-Infra
manifest rows (ADR-0014) so a deploy renders them: `OPENROUTER_ASSISTANT_API_KEY`
(`openrouter/assistant-api-key`, key gogo_ai_anthropic_<env>, Haiku via Anthropic BYOK),
`OPENROUTER_API_KEY` (`openrouter/api-key`, key gogo_be_<env>, every Jev call — intent and
the `recommend_places` relevance judgment; GoGo-BE#731),
`ASSISTANT_USER_DAILY_MAX_MESSAGES` (`budget/assistant-user-daily-max-messages`),
`ASSISTANT_MONTHLY_MAX_USD` (`budget/assistant-monthly-max-usd`) (either key, the daily
limit or the monthly budget unset ⇒ refuse), `ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES` (default 5, no SSM row), `ASSISTANT_TURN_COST_CEILING_USD`, `ASSISTANT_FIRST_TEXT_TIMEOUT_MS`
(≤ 15 000), `ASSISTANT_REPLY_MAX_MS`, `ASSISTANT_MAX_OUTPUT_TOKENS`,
`ASSISTANT_JEV_MODEL`, `ASSISTANT_JEV_TIMEOUT_MS`, `ASSISTANT_HAIKU_MODEL`. The kill
switch is the feature flag `assistant.enabled` (default off).

### "Tạo kèo" through the chat (GoGo-BE#733)

Shape `dev/handoffs/sa-shape-be-733-create-room-chat.fable.md` (D-1…D-7) with the owner's
answers of 2026-10-31 (Q-1: the card is shown at once; Q-2: a day with no hour is asked).
No contract change: `AssistantFollowUpGroup.field` is a free string; new values `area_scope`,
`time`, `party_size`.

- **Detection (D-1).** Jev's `action` criterion `create_room` now names "tạo kèo", "lập kèo",
  "lên kèo", "rủ … đi", "tạo plan", "tạo room"; the instruction adds _"Asking how to do
  something in the app is not an action."_ The fallback's `create_room` terms gain `tao keo`,
  `lap keo`, `len keo`, `mo keo`, `tao plan`, `tao room`; `tao phong`, `tao ke hoach`, `moi ban`
  left `GUIDE_TERMS`. `guardDecision` runs on both paths: an injection phrase → `out_of_scope`,
  no action; a how-to term (`lam sao`, `cach nao`, `cach tao`, `cach moi`, `huong dan`,
  `the nao`, `how do i`, `how to`) → no action.
- **Routing (D-2).** `create_room` on `gogo_guide`/`out_of_scope` becomes `recommend_places`
  (`trace.routeOverride = 'create_room'`; the decision metric keeps Jev's intent).
- **Proposal (D-3).** Prepared on every `create_room` turn; the area is resolved on that turn
  even when it still asks what to do (`clarify`). A new room card marks the conversation's
  other pending room cards `dismissed` (`assistant_proposals_total{outcome=superseded}`).
- **Time (D-3 + Q-2).** `TimeHint` gains `saturday`/`sunday` ("cuối tuần" stays `weekend`).
  `parseDayPart` reads a part of the day only next to a named day ("thứ 7 tối", "tối thứ 7",
  "Saturday evening"; not "ăn tối thứ 7", "tối đa"). Hours: sáng 09:00, trưa 12:00, chiều 15:00,
  tối 19:00 Asia/Ho_Chi_Minh. A named day **with** a part → the coming such day (next week when
  the hour has passed), origin `explicit` (`weekend` + part → Saturday, `assumed`); **without**
  one → no `startAt`/`endAt`, and `time` is asked with that day's chips ("Thứ 7 trưa/chiều/tối";
  `weekend` offers both days, six chips). Not changed, read literally from Q-2 and left for
  review: "tối nay"/"hôm nay"/"ngày mai" still give an assumed 19:00, so "tối nay" stays
  `assumed` while the "Thứ 7 tối" chip is `explicit`.
- **Questions (D-4).** On a `create_room` turn the missing items are asked by priority —
  preference › area (or `area_scope`) › activity › time › party size › budget — and the contract
  cap keeps two; the rest ride on the card as assumed. The deterministic reply appends one
  sentence naming the missing time / party size / budget.
- **Episode (D-5, amended for A-F-01/F-12).** A clarification answer merges only after an
  assistant reply with stored `follow_ups`. An explicit new action/search request or how-to question
  starts fresh, even if it carries facts; an exact offered activity chip still answers its question.
  Typed activity/preference answers also continue their pending question. Facts: newest non-null wins
  (the part of the day resets when a new day is named). Each reply stores at most eight source-message
  references in the existing internal `trace.episodeRefs`: the opening request and the latest source
  of party size, budget, day, day part, area, activity and preference. Only user rows from that same
  conversation within retention can be reloaded. References carry whether a bare area was prompted;
  no message body or administrative id is copied into the trace. This bounded state survives raw-history
  eviction. Older replies without references use the existing 10-row reconstruction window; already
  evicted context from those replies is not recovered. Jev receives at most 500 characters, preserving
  the opening request's head and newest answers; Haiku still sees six recent rows. The diagnostic
  `trace.episode = { turns, merged }` counts retained source turns. No schema or model-call change.
- **Area scope (D-6).** Step 0: the full dataset name of a current unit in the text wins (newest
  message first) — "Phường Sài Gòn, Thành phố Hồ Chí Minh" → the ward, "Cả Thành phố Hồ Chí Minh"
  → the city. Otherwise the phrase is the newest area, an alias in it, the episode's area, an alias
  anywhere (a level-word-only phrase such as "TP" from "Ở TP.HCM" is skipped). A phrase that names
  a province (name or alias) **and** a commune of that name inside it, with no qualifier
  (`thanh pho`, `tp`, `tinh`, `ca` / `phuong`, `xa`, `dac khu`), is `scope_choice`: no search, a
  deterministic delta, one `area_scope` group — "Cả <province fullName>" then each commune's
  `fullName` (text `<fullName>, <province fullName>`, ≤ 5). Data-driven; on v5.1.0 Phường Sài Gòn
  (26740) is the case. Legacy locality qualifiers are rejected in the user's message before exact
  province matching, including district-level cities; exact current provinces and supported province
  aliases remain valid. Bare commune names count only after an area/scope question or a locative word,
  so a preference such as "bình yên" does not replace an established area. Both typed and dataset names
  use the same punctuation fold; a bare hit resolves from the matched current units.
- **After Sol r1 / Astra r1.** A `create_room` turn with no known kind of place asks the activity on both
  paths; `create_room` from an opened plan takes the room flow; the room `type` is `explicit` only from a
  stated party size. Each reconstructed link is gated on its own (a fresh request is a boundary), and
  the newest message that names an area decides. Insert + supersede remains one statement, now inside
  a short transaction sharing a conversation lock with release. A refused confirm is retired when
  any newer same-kind card exists, regardless of that card's status. The insertion timestamp is taken
  after acquiring the lock. No provider call runs inside these transactions.
- **Shape amendment (2026-10-31 review fixes).** The D-5 bounded-history-only mechanism and R-1's
  deferred fresh-request boundary are replaced by the source references and deterministic boundary
  above. D-3 release and D-6 locality/bare-name rules are tightened as described. Owner Q-1/Q-2 and
  invariants I-1… I-8 remain binding. The original shape is outside this worktree and is not edited.
- **Known limits (owner accepted 2026-10-31, Sol r5 @855b011).** The episode boundary and the legacy
  district check are word heuristics, and two edge cases remain: **F-16** a typed polite activity answer
  ("cho mình quán cà phê") under an activity question is read as a fresh search and drops the room
  request; **F-17** a brand starting with "Q" ("Q Coffee ở TP.HCM") is read as a legacy district and the
  area is not recognised (the assistant asks for a new address). Measured on DEV in L-1…L-3; the
  mechanism change considered and not taken: a Jev `continues_previous` noul for the boundary.
- **F-17 closed (GoGo-BE#739).** The legacy district check no longer trusts a level word: a qualifier
  (quận/huyện/thị xã/thành phố/TP/Q, read before folding so "quán" is not "quận") counts only when
  the name right after it is a `LEGACY_DISTRICT` in the published snapshot (`legacySearch`). "Q
  Coffee ở TP.HCM" resolves TP.HCM; "Q. Bình Thạnh, TP.HCM", "Quận 1, …", "Thành phố Thủ Đức, …"
  stay `none`. A current province-level city after "Thành phố"/"TP" ("Thành phố Quảng Ninh") is the
  city, not its same-name old district (Huyện Quảng Ninh). No brand-name exceptions. A numbered
  district after "Quận"/"Q" ("Q2, TP HCM", "Quận 9") is legacy whatever the snapshot holds — no
  current unit is a quận, and Quận 2/9 (merged into Thủ Đức in 2021) are absent from the pinned
  v2.4.1 snapshot — so it is never widened to the city (PR #741 F-01).
- **Never written before confirm (D-7).** Unchanged; the int test counts `rooms` before and after.

## Open items

1. **Configuration hand-off.** Done for code (ADR-0036); the per-environment values
   (limits, monthly budget) still have to be written to SSM by GoGo-Infra#257 before
   the flag is turned on.
2. **Search.** `q` is substring (unaccent + `ILIKE`/trigram) over the user's own
   rows. Fine at 90-day volume; revisit if a user's history gets large.
3. **Attachment export scope.** Excluded until the owner approves what of an
   image (bytes, metadata) is portable.
