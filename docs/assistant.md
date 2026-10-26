# GoGo AI assistant — module design (GoGo-BE#713)

Status: **contract landed (PR 1), module not built.** This note is what PR 2+
implement against. The contract is `openapi/gogo.v1.yaml` 2.0.0-alpha.2, tag
`assistant`, every operation marked `x-gogo-planned: GoGo-BE#713`.

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
- `/cms/assistant/feedback` — moderator queue, minimal PII.
- Kill switch: **no new endpoint.** Feature flag `assistant.enabled` through
  the existing `PUT /cms/feature-flags/{key}` (`ops_admin`, audited). The key is
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

| Action                    | Roles                                          | Why                                                                                                            |
| ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Read documents / versions | `editor`, `moderator`, `ops_admin` (read rule) | BE-IMP-008 hierarchical read: controller declares `editor, ops_admin`; `moderator` (rank 1) reads as a peer.   |
| Create / edit draft       | `editor`, `ops_admin`                          | Same as banners, plan templates and recommendations: user-visible content copy.                                |
| Publish / unpublish       | `ops_admin`                                    | Changes what the AI tells every user — a release decision, split from authoring like safety rules / campaigns. |
| Feedback queue            | `moderator` (+ `ops_admin` by read rule)       | GoGo-CMS#249 asks for moderator; content quality review, not policy.                                           |
| Kill switch               | `ops_admin`                                    | Existing feature-flag endpoint.                                                                                |

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
5. **End**: `done` (`complete | stopped | fallback`) or `error`; message row
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
| Per-account daily message limit spent                                          | `429 ASSISTANT_DAILY_LIMIT` + `Retry-After` to the reset; status → `limit_reached`                                             |
| Per-minute burst                                                               | `429 RATE_LIMITED` + `Retry-After`                                                                                             |
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

## Open items

1. **Limits.** The numbers (per-account daily messages, burst, reply length)
   are the owner's, set with the configuration work.
2. **Configuration hand-off.** The port, credentials and spend limits are wired
   by the owner separately; PR 2 builds against `FakeAssistantLlm`.
3. **Export.** Should `/me/export` (ADR-0033 allowlist) include assistant
   conversations? Proposed: yes (title, messages, timestamps; no sources'
   internals). Needs owner sign-off; not in this contract.
4. **Moderator visibility.** The feedback queue shows only the assistant's
   reply. If moderators need the user's question to judge an answer, that is a
   PII decision for the owner (and a contract change).
5. **Proposal kinds.** v1: `create_room`, `create_invite`, `cast_vote`,
   `finalize_plan`. "Delete" from the design system is not included — no
   assistant-initiated deletion until the owner asks for it.
6. **Search.** `q` is substring (unaccent + `ILIKE`/trigram) over the user's own
   rows. Fine at 90-day volume; revisit if a user's history gets large.
7. **Stream ceiling.** A whole-reply time ceiling ends a long reply as
   `complete`; whether it should be a distinct status is open.
8. **Planned marker.** Until PR 2 the deployed `/v1/docs` lists 24 operations
   that answer 404 (stated in each description and the CHANGELOG). If the owner
   prefers, PR 2 can instead ship stub controllers answering
   `503 ASSISTANT_DISABLED` first and drop the markers.
