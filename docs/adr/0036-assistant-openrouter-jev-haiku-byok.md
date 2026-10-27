# ADR-0036 — GoGo AI Assistant: live OpenRouter BYOK, Jev decisions, Claude Haiku responses

- **Status:** Accepted (owner decision, 2026-10-27); implementation pending
- **Scope:** GoGo-BE runtime, GoGo-MobileApp assistant
- **Related:** GoGo-BE#713, #709, #711; GoGo-Infra#257; GoGo-MobileApp#377
- **References:** `docs/assistant.md`, `docs/adr/0035-decision-models-for-intent-classification.md`, `CLAUDE.md`

## 1. Decision

GoGo Mobile App calls GoGo-BE only. Backend owns authorization, conversation state, query execution, hard constraints, ranking, card facts, SSE, usage and permitted write transactions. Two real models, both reached through **OpenRouter's existing live gateway key**, are used:

| Purpose | Pinned model | OpenRouter endpoint | Responsibility |
| --- | --- | --- | --- |
| Semantic decisions | `typesafe/jev-1.14` | `POST https://openrouter.ai/api/alpha/decisions` | Typed intent, clarification, category/mood and (when justified) relevance judgments |
| Answer composition | `anthropic/claude-haiku-5.5` | `POST https://openrouter.ai/api/v1/chat/completions`, streaming | Natural Vietnamese grounded response, no authoritative facts |

**Haiku 5.5 is the owner's cost-optimization choice, superseding Sonnet.** No automatic Sonnet fallback. Do not use `~latest` aliases or silently swap models. Model changes require a documented owner decision.

The owner states that their live OpenRouter gateway key and upstream BYOK configuration for Claude and Jev **already exist**. **Reuse them; do not request, create, rotate or expose keys.** No mock, fake, demo, local-simulated or canned-inference assistant implementation or acceptance tests. Pure deterministic unit tests on code-level policy/parsing/repositories are allowed; these are not substitutes for live inference integration tests.

**Important distinction:** BE authenticates to OpenRouter with its existing runtime gateway key, not a provider's raw BYOK secret. OpenRouter chooses the upstream credential/endpoint. Before enabling real users, verify model allowlists, selected provider, BYOK routing and OpenRouter/shared-capacity fallback settings separately for **both** Jev and Haiku. A successful 200 response proves model availability, not that BYOK was used. For strict BYOK use, ensure shared-capacity fallback is disabled in the OpenRouter workspace/provider configuration; fail closed if credentials/routing do not meet the approved policy. Do not assume chat routing preferences apply to the Decisions API. Never print credentials or capture full upstream payloads in logs.

Runtime assistant must be completely isolated from GoGo-Infra development AI Harness; it cannot invoke agents, tool execution, shell or development policy modules.

## 2. Contract and invariant compatibility

Implement the existing `/v1/assistant` contract in `openapi/gogo.v1.yaml` and `docs/assistant.md` (GoGo-BE#713). Do not invent another public chat endpoint. Preserve:

- Registered users only; guest gets `403 USER_ONLY`.
- Conversation CRUD/history/search, user-owned messages and context authorization.
- `POST /assistant/conversations/{id}/messages` with `Idempotency-Key`: persist user turn + streaming assistant placeholder, enqueue, respond `202`; **no LLM call inside a DB transaction**.
- `GET /assistant/conversations/{id}/messages/{messageId}/stream`: replayable, resumable SSE, `Last-Event-ID`; reconnect never causes duplicate billing/inference.
- `POST .../stop`: abort Jev/Haiku if still running, save partial text, mark `stopped`; idempotent.
- Source references, structured place/plan cards, typed follow-ups, proposals and confirmation actions.
- Proposal confirmation is the **only** route that writes room/plan/invite/vote data. It rechecks ownership, membership, constraints, request schema and idempotency at confirmation time; never auto-executes.
- CMS published/version-pinned guide; `assistant.enabled` kill switch default off; environment spend ceilings, account limits; privacy/export/erasure; 90-day conversation retention.
- Existing `x-gogo-planned` markers remain until the corresponding real endpoints are implemented and verified.

Hard rules: no AI-generated price, address, opening hours, rating, availability, route time or plan state as trusted facts. All card facts are rehydrated using the existing verified GoGo data read paths. Never store new persistent Google-derived content. AI suggestions may return only IDs from the caller-specific backend allowlist.

## 3. End-to-end pipeline

### A. Admit and persist (short synchronous send)

1. Authenticate the registered actor and verify ownership of the conversation, optional `placeId`/`planId` context chip, and any uploaded images.
2. Check `assistant.enabled`, provider configuration/strict BYOK readiness, hard per-environment budget, per-account 30 accepted messages/day and five per rolling minute (configurable), and only one in-flight turn per conversation. Unconfigured spend limit means **disabled**, not unlimited.
3. Honor send idempotency before debiting account allowance. Persist request and reserved assistant turn, enqueue background work, return existing contract's `202`.
4. Do not send user chat or private data to models on rejected requests.

### B. Build bounded context and parse hard facts

1. Load only the bounded, authorized chat history required to disambiguate the present question; never ship an unrestricted full conversation.
2. Reuse `parseIntentFacts` and area-administrative resolution for party count, VND budget amount + `total/per_person` mode, relative date/time, locality; distinguish `explicit`, `assumed` and `unknown` origins.
3. Load only relevant preferences and authorization-filtered room/plan context. Store no model-derived field as an authoritative user preference.
4. Retrieve published CMS-guide references only as needed; pin the guide version for each turn. Strip private tokens, unnecessary PII, raw user IDs and untrusted markup from model-bound context. Treat all third-party documents and user content as **untrusted data**, never instructions.

### C. Jev decision 1 — intent routing (live)

Reuse the existing `DecisionProviderPort` and `OpenRouterDecisionProvider` from `libs/providers`, plus `IntentClassificationService` and domain taxonomy from `libs/modules/search`. Extend decision questions for assistant operation categories without forking the original POC implementation.

Supply the user question, explicit parsed facts, small relevant context and tightly enumerated options to Jev. Typical decisions:

- `intent`: `recommend_places | gogo_guide | plan_help | clarification | out_of_scope`
- Existing category, occasion, mood/setting, conflicting wishes and need-for-clarification questions
- Optional confidence/probabilities (not evidence of factual correctness)

The server validates the exact question/answer types and choice keys. Jev never emits SQL, executable commands, permissions, free-form explanations, unbounded identifiers, or place facts.

### D. Deterministic retrieval and optional Jev decision 2 — relevance

Based on verified intent, call existing GoGo application services for places/search/suggestions, plans, room constraints, or published CMS-guide search. Filter candidate IDs **before ranking** for actor visibility, geography, hard budget, time windows, active status and room rules. A compact bounded top-K candidate set may be supplied to a **single batched Jev relevance judgment** only where semantic relevance adds value. Jev can score/choose solely among enumerated candidate keys; the server keeps the key-to-real-ID map privately. No free-form place discovery from either model, no model-built SQL, no automatic repeated re-ranking calls. Thresholds require calibration on independently labeled Vietnamese requests rather than blindly copying the intent POC's 0.5 defaults.

The backend rechecks all selected candidates against the current allowlist and canonical data; rejects stale/unauthorized/invalid choices; orders ties deterministically. If a hard filter yields no candidates, do not ask Jev or Haiku to invent alternatives: return a grounded empty state and supported follow-ups.

### E. Trusted decision executor

Construct a typed, backend-owned `GroundedAnswerContext` containing:
- Chosen intent and uncertainty / clarification decision.
- Server-verified place/plan IDs and public facts, from authorized reads.
- User constraints with provenance (`explicit` vs `assumed`).
- Version-pinned CMS-guide `sourceIndex` references and canonical citation metadata.
- Allowlisted follow-up actions or **pending-only** proposal IDs.

Only the existing business-service layer can prepare/execute reads or confirm action writes. The models cannot decide authorization, change eligibility, mark assumed fields explicit or inject a new source/card ID. Card title, address, hours, price and link fields always come from backend reads, not Haiku prose.

### F. Claude Haiku 5.5 answer composer (live)

Add `AssistantLlmPort` and production `OpenRouterAssistantLlmAdapter` in `libs/providers`, plus the assistant orchestration service in `libs/modules/assistant/application`. Call OpenRouter Chat Completions using the **existing OpenRouter key**, explicit pinned `anthropic/claude-haiku-5.5`, bounded messages, `stream: true`, configured output cap and cancellation.

Haiku's only permitted purpose is to explain the vetted decision in concise, friendly Vietnamese using the `GroundedAnswerContext`. No tool invocation that writes data. In the model instruction, expressly prohibit invented place facts, uncertified availability, price, hours, sources, unsupported product features, confirmations and markdown links. Have it refer to cards by controlled indices; backend generates actual cards and citations. Server-side validation must discard invalid structured outputs rather than trusting generated IDs. Prose can still hallucinate: test known adversarial cases, avoid repeating sensitive content, and do not claim that raw text streaming provides a mathematical guarantee of factual correctness.

Use a short stable system prompt and only top relevant evidence; cap conversation window and generated tokens. Haiku reasoning effort may be reduced/disabled **only after verifying supported parameters live**. Avoid large prompt replay, extra model loops and unapproved Sonnet escalation. No blind retry of a billable model request.

### G. Stream, commit, stop and fallback

SSE frames and terminal statuses remain defined by the existing contract. Maintain append-only/replayable frames for reconnect, cancellation via `AbortSignal`, and persist text/usage/status at terminal state. **No first visible text within 15 seconds** from reply orchestration start triggers a deterministic timeout fallback; the 15-second ceiling applies to the combined Jev/retrieval/Haiku first-text path, not 15 seconds independently for each call. Configured hard reply time/token ceiling ends with `done{status: truncated}`, preserving partial text and discarding incomplete structured outputs.

Jev timeout/quota/config/invalid response: deterministic intent fallback from ADR-0035; continue only if safe grounded data exists. Haiku failure **before text**: a deterministic Vietnamese response sourced from the validated data (not mocked Haiku output), `notice{kind: fallback}`, `done{status: fallback}`. Failure **after text started**: emit an error and preserve partial text. Mid-reply kill switch: stop, save partial. Repeated or cross-model fallback requests are not allowed. With strict BYOK, no shared-credit provider escalation.

## 4. Public behavior examples

**Recommendation:** “Tối nay hai đứa ăn gì ở Cầu Giấy, tổng 500k, chỗ yên tĩnh?” The backend extracts two people, 500,000 VND **total**, tonight and area. Jev classifies a couple's restaurant outing and preference for calm atmosphere. Search provides authorized GoGo-owned candidates; optional Jev relevance chooses from bounded candidates. Backend validates canonical prices/hours; Haiku writes a succinct, qualified Vietnamese explanation and the app renders source-backed PlaceCards. Missing price/availability is labeled unknown, not assumed.

**Guide question:** “GoGo tạo kế hoạch thế nào?” Backend retrieves published versioned GoGo Guide and Haiku explains only documented functionality, returning source indices mapped by BE. If no source exists, return the empty state, not invented onboarding instructions.

**Action:** “Tạo plan đi chơi từ các chỗ này.” The backend returns a **pending proposal** with field origins and a confirmation card; nothing is written until the user confirms through the authorized idempotent endpoint.

## 5. Provider configuration, spend and privacy

- Reuse the existing runtime OpenRouter gateway credential provisioned in SSM (currently backend row `openrouter/api-key` -> `OPENROUTER_API_KEY`); **inspect existing config first** before any change. No new mandatory key provisioning or application-side credentials.
- Keep provider adapters separated by transport: `openrouter-decisions.adapter.ts` for `/api/alpha/decisions` and `openrouter-assistant-llm.adapter.ts` for `/api/v1/chat/completions`.
- Confirm actual **upstream BYOK** usage for Jev and Haiku separately in OpenRouter activity/provider routing and upstream billing. Provider key allowed-model and priority settings must include `anthropic/claude-haiku-5.5`, not merely an older Haiku model. Respect owner-configured strict-BYOK failure instead of using shared OpenRouter credits.
- Charge and report separate dimensions `openrouter.decisions` and `openrouter.assistant_haiku` or compatible Cost Center taxonomy, keyed by model, role, env and actual API usage. Store provider-reported token usage and USD when present; unknown cost is `null` and not an invented 0.
- Observe admission decisions, TTFT (including Jev), E2E latency, provider errors/429/402, token usage, spend vs alert threshold, cost per accepted turn, missing sources, invalid model selections and proposal outcomes. No message body, prompt, raw image, API key, private URL, PII-bearing message or full model response in metrics, logs or Sentry.
- Avoid unnecessary model calls for out-of-scope, empty or already deterministically resolved requests; use a bounded Jev pass for applicable user queries and a single Haiku stream only when composed prose is needed.
- Existing image-only attachments remain private and are forwarded to a model only if the configured upstream supports the modality and the user has access.
- Validate the upstream's handling of personal data and provider/account retention settings before enabling personal chat at scale.

## 6. Implementation sequence and acceptance

1. **Contract wiring:** Implement `libs/modules/assistant` according to `docs/assistant.md`; preserve all existing OpenAPI routes and planned markers until ready.
2. **Provider wiring:** Reuse live Jev provider. Add the real OpenRouter Haiku adapter with SSE parsing, token usage, typed errors, abort support and a verified explicit model ID. Never add a fake LLM adapter for assistant runtime/test acceptance.
3. **Orchestration:** Admission -> parse -> Jev -> authorized retrieval -> optional bounded Jev relevance -> backend validation -> Haiku -> SSE, plus deterministic no-source/failure paths.
4. **Production guards:** Add feature flag, access checks, idempotency, limits, cost ceiling, safe termination, proposals with explicit user confirmation, privacy/retention, and structured outputs.
5. **Live DEV validation:** Using already provisioned runtime credentials, call **both** endpoints, verify actual model name, actual BYOK route and billing, input/output usage, error cases, cancel and streaming. Do not print or persist the keys. E2E live tests should be intentionally gated, budget-bounded, rate-limited, and not run automatically on every CI push.
6. **Tests:** Pure deterministic unit/contract/integration tests for authorization, parsing, candidate allowlist, confirmation invariants, SSE replay/stop and fallback behavior; live paid integration tests for real provider responses, failure handling and grounded Vietnamese cases. No mock inference claimed as live proof.
7. **Rollout:** DEV behind default-off feature flag, review spending/latency/relevance/grounding, then STAG and PROD only after the owner explicitly enables each environment. No automatic model substitution, no merge without owner review.

**Acceptance must include:** verified successful live Jev and Haiku calls through existing OpenRouter key; documented BYOK route for both; correct Vietnamese grounded answer and valid server-hydrated cards; hard budget and room access upheld; no fabricated IDs or facts; no unexpected writes; stop/replay/timeout/retry safe; separate usage tracking; source-backed fallback; disabled mode refusing requests; no mock model execution.

## 7. Cost optimization

OpenRouter's listed price for `anthropic/claude-haiku-5.5` on 2026-10-27: **$0.10 per 1M input tokens; $0.50 per 1M output tokens**, before any BYOK-provider-side and plan-dependent OpenRouter fees. Haiku 4.5 lists **$1/$5** (10x the listed rate). Do not embed either number as permanent billing truth; fetch current actual costs for dashboards. Jev 1.14 input is low-priced but must be billed by observed usage, not assumed free.

Start with **one** Jev intent call, **at most one** bounded Jev relevance call if needed and **one** Haiku composition call. Keep narrative short, avoid full-history replay, cap tokens and use only necessary published-guide excerpts. Consider prompt caching only when it is supported/beneficial on the actual BYOK upstream route and privacy constraints permit it.

## 8. Documentation and rollback

This ADR supersedes the previous proposed Sonnet response-model selection for assistant runtime; it does **not** change the GoGo AI development harness or replace ADR-0035. Document the model/role/route in the assistant runbook and Cost Center. Roll back by turning `assistant.enabled` off per environment; retain stored conversation data subject to existing retention and privacy rules. Do not remove or rotate the owner's existing live credentials in a rollback.

### Public references

- OpenRouter Claude Haiku 5.5 model page: https://openrouter.ai/anthropic/claude-haiku-5.5
- OpenRouter BYOK documentation: https://github.com/OpenRouterTeam/docs/blob/main/guides/overview/auth/byok.mdx
- OpenRouter Jev 1.14 Decisions endpoint: https://openrouter.ai/blog/insights/what-is-jev/
