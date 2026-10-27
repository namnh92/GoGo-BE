# GoGo AI assistant — module design (GoGo-BE#713)

Status: **contract landed (PR 1, amended by contract PR 2), module not built.**
This note is what the module PRs implement against. The contract is
`openapi/gogo.v1.yaml` 2.0.0-alpha.3, tag `assistant`, every operation marked
`x-gogo-planned: GoGo-BE#713`. The SA decisions applied in 2.0.0-alpha.3 are
listed under [Decisions](#decisions-sa-on-gogo-be713-owner-delegated).

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

## Open items

1. **Configuration hand-off.** The port, credentials and spend limits are wired
   by the owner separately; the module PR builds against `FakeAssistantLlm`.
2. **Search.** `q` is substring (unaccent + `ILIKE`/trigram) over the user's own
   rows. Fine at 90-day volume; revisit if a user's history gets large.
3. **Attachment export scope.** Excluded until the owner approves what of an
   image (bytes, metadata) is portable.
