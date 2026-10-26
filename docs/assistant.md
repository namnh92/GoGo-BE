# GoGo AI assistant — module design (GoGo-BE#713)

Status: **contract landed (PR 1), module not built.** This note is what PR 2+
implement against. The contract is `openapi/gogo.v1.yaml` 2.0.0-alpha.2, tag
`assistant`, every operation marked `x-gogo-planned: GoGo-BE#713`.

Authorities: epic GoGo-MobileApp#377 (owner decisions 2026-10-26 are binding),
GoGo-Infra#257 (key, budget, kill switch, cost alert), GoGo-CMS#249 (console),
the GoGo AI design system (conversation rules: sources, ConfirmationCard,
TaskSummary, FollowUps, StateNotice, Stop keeps partial text), and the hard
rules in `CLAUDE.md`.

## Owner decisions this design takes as given

| Topic       | Decision (MobileApp#377, 2026-10-26)                                             |
| ----------- | -------------------------------------------------------------------------------- |
| Model / key | Claude through OpenRouter, BYOK Anthropic, its own key per env                   |
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
  assistant-llm.port.ts             AssistantLlmPort { stream(request, signal): AsyncIterable<LlmChunk> }
  openrouter-assistant.adapter.ts   Claude via OpenRouter chat completions (stream: true),
                                    structured output by tool call; modelled on
                                    openrouter-decisions.adapter.ts (withResilience, typed
                                    errors, usage incl. costUsd nullable — null is "not
                                    reported", never 0)
  fake.adapters.ts                  FakeAssistantLlm for tests (scripted chunks, delays)
```

`libs/providers` never imports `modules` (`check:boundaries`). The port takes
plain data; the orchestrator owns prompts.

## Turn pipeline (one reply)

1. **Admit** (synchronous, inside `POST …/messages`): actor is a user
   (`USER_ONLY` otherwise) → kill switch (flag `assistant.enabled`) → monthly
   budget configured and below 100 % → per-user daily limit configured → burst + daily limit → no streaming turn in the
   conversation → context readable by the caller (existing place/plan read
   policy; `CONTEXT_NOT_FOUND` otherwise) → attachments are this actor's
   `assistant_image` keys. Store user message + `streaming` assistant message,
   enqueue the turn. Commit. No transaction is held across the LLM call.
2. **Ground**: retrieve top-k sections of **published** guide versions
   (pinned by `versionId` for this turn); if a context is set, load the
   place/plan facts the caller may read. Build the **allowlist**: place ids
   from context + from a deterministic search (`places/search` use case with
   the user's query and room constraints), plan/room ids the caller is a member
   of. The model never sees an id it may not return.
3. **Generate**: stream from `AssistantLlmPort`. Text deltas pass through.
   Structured outputs (cards, proposals, follow-ups, source citations) arrive
   as tool calls and are **validated server-side** before any frame is sent:
   - card / proposal ids ∉ allowlist → dropped, `assistant_output_rejected_total{reason="id_not_allowed"}`;
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
4. **Timeout**: no first text within **15 s** (`ASSISTANT_FIRST_TOKEN_TIMEOUT_MS`,
   max 15000) → abort the call, emit `notice{kind: fallback, reason: timeout}`
   with the deterministic fallback (retrieved sources, if any, plus fixed
   follow-ups by i18n key), `done{status: fallback}`. Provider error / invalid
   output → same path with `reason: provider_unavailable | invalid_output`.
5. **End**: `done` (`complete | stopped | fallback`) or `error`; message row
   updated with final text, sources, card ids (not facts), proposal ids,
   status, token usage and cost.

**Stop**: `POST …/stop` sets a Redis cancel flag the orchestrator polls between
chunks and aborts the provider request (`AbortSignal`); the text so far is
stored, `status: stopped`. Idempotent.

**No information**: if retrieval returns nothing relevant and no tool applies,
the model is instructed to answer with the `empty` notice; the server also
emits `notice{kind: empty}` when the reply cites no source for a product
question. The assistant must never describe a feature GoGo has not defined —
the system prompt restricts product claims to cited guide sections.

## Proposal / confirm

- A proposal row stores `kind`, `values[] {field, value, origin}`, the
  conversation owner, `expiresAt` (30 min, `ASSISTANT_PROPOSAL_TTL_MINUTES`).
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
  only. Image bytes are sent to the provider only for that turn; nothing from
  the provider is stored except the reply.
- **Retention 90 days** (`ASSISTANT_RETENTION_DAYS=90`): a daily job in the
  worker, alongside `PrivacyJobs` (DB-010), hard-deletes conversations whose
  `lastMessageAt` is older than the window, cascading messages, sources,
  proposals, feedback and attachment objects; reports
  `assistantConversationsPurged` in the run report. Dry-run supported.
- **Account deletion / privacy request**: `UserContentService.deleteForUser`
  (ADR-0023) and the privacy-ledger execute path (ADR-0011) call
  `AssistantErasure.eraseForUser(userId)` — hard delete, not pseudonymize;
  ADR-0023's retention list gains "assistant conversations: deleted".
- **Logging**: never log message text, prompts, completions, attachments,
  context ids together with user ids, or keys. Log `request_id`, conversation
  id hash, token counts, latency, status, model. Sentry events for the module
  must not carry request or response bodies (open: confirm the existing Sentry
  scrubber covers these routes, or add them).

## Configuration and dependencies (GoGo-Infra#257 → PR GoGo-Infra#259, ADR-0014 _Proposed_)

Infra declares the SSM rows; BE reads them through the existing `scripts/secrets/`
→ `.env` path. Names below are Infra#259's; values are the owner's.

| Env / SSM row                                                                    | Default            | Meaning                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_ASSISTANT_API_KEY`                                                   | —                  | OpenRouter key `gogo_ai_anthropic_<env>` (BYOK Anthropic). Never the `backend` `OPENROUTER_API_KEY` of BE#709                         |
| `ASSISTANT_MODEL` ← `assistant/model`                                            | —                  | Proposed `anthropic/claude-sonnet-5.5`                                                                                                |
| `ASSISTANT_FALLBACK_MODEL` ← `assistant/fallback-model`                          | —                  | Proposed `anthropic/claude-haiku-5.5`; tried once inside the same 15 s budget, else the deterministic fallback                        |
| `ASSISTANT_MONTHLY_MAX_USD` ← `budget/assistant-monthly-max-usd`                 | **unset = refuse** | Environment's monthly spend cap. Refuse new turns at **100 %** (`503 ASSISTANT_DISABLED`)                                             |
| `ASSISTANT_USER_DAILY_MAX_MESSAGES` ← `budget/assistant-user-daily-max-messages` | **unset = refuse** | Per-account messages per day (`429 ASSISTANT_DAILY_LIMIT`); never unlimited                                                           |
| `FLAG_ASSISTANT` ← `flags/assistant`                                             | `false`            | Seeds the audited `FEATURE_FLAGS` row `assistant.enabled`; the runtime switch is the row (`PUT /cms/feature-flags/assistant.enabled`) |
| `ASSISTANT_RATE_PER_MINUTE`                                                      | `6`                | Burst limit per account                                                                                                               |
| `ASSISTANT_FIRST_TOKEN_TIMEOUT_MS`                                               | `15000`            | ≤ 15000 (hard rule)                                                                                                                   |
| `ASSISTANT_MAX_REPLY_SECONDS`                                                    | `60`               | Ceiling on a whole reply, then `done{status: complete}` with what was written                                                         |
| `ASSISTANT_MAX_OUTPUT_TOKENS`                                                    | `1024`             | Per reply                                                                                                                             |
| `ASSISTANT_RETENTION_DAYS`                                                       | `90`               | Owner decision                                                                                                                        |
| `ASSISTANT_PROPOSAL_TTL_MINUTES`                                                 | `30`               |                                                                                                                                       |

The env-var names for the model / budget rows are this note's proposal; if
Infra#259 lands different names, BE follows Infra. `config:check` (preflight)
refuses the flag on without a key and a model, and a timeout above 15000. A
missing budget or per-user limit is not a boot failure — the assistant simply
refuses (state `disabled`), so an unconfigured environment is safe, not down.

Monthly spend for the 100 % check is the month-to-date sum of per-turn
`cost_usd` on message rows (fast, reported by OpenRouter), reconciled daily
with the collector. A turn whose cost was not reported counts with its
token-estimated cost, never as 0.

**Cost Center** (BE#709 / #711): add key routing `gogo_ai_anthropic_*` →
`openrouter.assistant` in `openrouter.collector.ts` (today it would fall into
`openrouter.other_keys`), the BYOK charge → `anthropic.assistant` in the
`anthropic_byok_openrouter` collector, both services in the cost registry, and
a `cost_budgets` row for the assistant per environment.

## Metrics (for GoGo-Infra#257 cost alert and dashboards)

Labels are closed sets only — never a user id, conversation id, key or text.
Required by Infra#259:

| Metric                             | Type      | Labels                                                                 |
| ---------------------------------- | --------- | ---------------------------------------------------------------------- |
| `ai_assistant_spend_month_usd`     | gauge     | `env` — month-to-date spend (see above)                                |
| `ai_assistant_budget_month_usd`    | gauge     | `env` — `budget/assistant-monthly-max-usd`; absent when unset          |
| `assistant_requests_total`         | counter   | `outcome` = complete \| stopped \| fallback \| failed \| rejected      |
| `assistant_llm_tokens_total`       | counter   | `model`, `direction` = input \| output                                 |
| `assistant_first_token_seconds`    | histogram | `model` — time to first token                                          |
| `assistant_reply_duration_seconds` | histogram | `outcome` — whole-reply latency                                        |
| `assistant_llm_errors_total`       | counter   | `kind` = timeout \| quota \| provider_5xx \| invalid_output \| aborted |

Module-level, for behaviour and abuse:

| Metric                                | Type    | Labels                                                                                                                |
| ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `assistant_llm_cost_usd_total`        | counter | `model` — USD as reported                                                                                             |
| `assistant_llm_cost_unreported_total` | counter | `model`                                                                                                               |
| `assistant_rejections_total`          | counter | `reason` = disabled \| budget_exhausted \| not_configured \| daily_limit \| rate_limited \| guest \| turn_in_progress |
| `assistant_output_rejected_total`     | counter | `reason` = id_not_allowed \| invalid_card \| invalid_proposal                                                         |
| `assistant_proposals_total`           | counter | `kind`, `outcome` = proposed \| confirmed \| dismissed \| expired \| refused                                          |
| `assistant_feedback_total`            | counter | `rating`                                                                                                              |
| `assistant_retention_purged_total`    | counter | `reason` = retention \| account_deleted \| privacy_request \| user_deleted                                            |

Plus the shared `provider_requests_total` / `provider_request_duration_seconds`
with `provider=openrouter, service=openrouter.assistant`. Per-request token
counts and cost are stored on the message row (`input_tokens`,
`output_tokens`, `cost_usd`, `model`). The 80 % alert itself is Infra's, on
`ai_assistant_spend_month_usd / ai_assistant_budget_month_usd`.

## Open items

1. **Cost Center wiring** (above) must land before the key carries traffic,
   or the spend shows as `openrouter.other_keys`.
2. **Numbers for owner approval** (Infra#259 ADR-0014): monthly cap, per-user
   daily messages (proposal 30), max output tokens; model choice is proposed
   there.
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
7. **Stream ceiling.** `ASSISTANT_MAX_REPLY_SECONDS` ends a long reply as
   `complete`; whether it should be a distinct status is open.
8. **Planned marker.** Until PR 2 the deployed `/v1/docs` lists 24 operations
   that answer 404 (stated in each description and the CHANGELOG). If the owner
   prefers, PR 2 can instead ship stub controllers answering
   `503 ASSISTANT_DISABLED` first and drop the markers.
