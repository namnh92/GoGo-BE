# ADR-0035: Decision models behind a port; Vietnamese intent classification as a DEV POC

- **Status:** proposed
- **Date:** 2026-10-22
- **Deciders:** product owner (pending), backend
- **Issue:** GoGo-BE#709
- **Related:** GoGo-Infra ADR-0013 / GoGo-Infra#241 (AI Harness, the development-side use of the
  same model), ADR-0009 (recommendations), `docs/search-relevance.md`

## Context

A free-text request — "Tối nay 4 người đi ăn lẩu khoảng 300k/người, gần Cầu Giấy, ưu tiên quán
yên tĩnh." — mixes facts code can read (four people, 300,000 VND each, tonight, Cầu Giấy) with
judgments code cannot (hot pot means a restaurant, "yên tĩnh" is a calm atmosphere, the request is
clear enough to answer). Today `/v1/places/search` takes structured filters and a keyword `q`;
nothing turns the sentence into those filters.

TypeSafe's Jev is a decision model: it answers typed questions (`choice`, `score`, `noul`) with
probabilities, never text, through OpenRouter's Decisions API
(`POST https://openrouter.ai/api/alpha/decisions`). That fits the hard rules: it cannot produce a
place fact, only pick among options code supplies.

Contract verification: `openrouter.ai` and `docs.typesafe.ai` were not reachable from the session
that wrote this; the contract is taken from OpenRouter's published reference
(`OpenRouterTeam/skills` → `openrouter-decisions/references/decisions-api.md`). That
`typesafe/jev-1.14` is served on the Decisions path, the Decisions-specific error table and real
latency are **not verified** — see GoGo-Infra ADR-0013 "Verification".

## Options considered

1. **A chat LLM that returns JSON** — generates text to be parsed; can invent a key or a number;
   not what was asked for, and the task forbids substituting it without approval.
2. **Keyword rules only** — what the fallback does; 46 % category agreement on the case set
   (`pnpm eval:intent`, no model), no notion of atmosphere or ambiguity.
3. **Decision model for judgments, code for facts** — chosen.

## Decision

- **Port.** `DecisionProviderPort` in `libs/providers` (`openrouter-decisions.adapter.ts`), with
  `OpenRouterDecisionProvider` and `FakeDecisionProvider`. Through `withResilience` with **no
  retries** (every attempt is billed), a ≤ 15 s timeout, a breaker; 402 → `ProviderQuotaExceeded`,
  401/403 → `ProviderConfiguration`, other 4xx → `ProviderInvalidRequest`. Responses are validated
  against the questions asked; optional `probabilities`/`confidence` stay absent when absent; a
  cost not reported is `null`, never 0. Aliases are refused; the answering build is returned.
- **Split.** `domain/intent.ts` parses party size, budget (integer VND, `per_person` | `total` |
  not stated), a time hint and the area phrase deterministically. The model is asked only:
  in scope (noul), category (choice over taxonomy keys + `none`), occasion (choice over
  `suitability` keys + `not_stated`), one noul per mood and per setting key, needs clarification,
  conflicting wishes. Taxonomy keys come from the caller, never from code.
- **Kill switch and fallback.** `IntentClassificationService(provider, 'disabled' | 'enabled')`.
  Disabled is the default. Every failure returns the deterministic classification with
  `fallbackReason`; nothing throws to the caller.
- **No route, no contract change.** The service is not wired to any controller; `/v1` and the
  OpenAPI document are unchanged. `pnpm eval:intent` is the only caller.
- **Cost registry.** `openrouter` is a `planned` provider (`openrouter.decisions`, category
  `ai_decisions`, meters `decisions`/`input_tokens`), no pricing rule, no estimate.
- **Isolation.** No code shared with the AI Harness; a separate key (a future `backend` row,
  `openrouter/jev-api-key` → `OPENROUTER_API_KEY`, not declared until the service is wired) with
  its own OpenRouter credit limit. Nothing in this repository can start a development agent.

## Consequences

- Thresholds (`INTENT_THRESHOLDS`) are the official 0.5 starting points, not probed on Vietnamese
  GoGo queries. Model accuracy is unknown until an authorized live `pnpm eval:intent` run; the
  151-case set and the fallback baseline are ready for it.
- Lowercase or locative-less area names (`ở đâu ngon Hà Nội`) are not extracted; the case set
  records these as `knownParserGaps`. Area validation stays with the administrative module.
- Wiring needs its own decision: which endpoint, the DTO (facts only), the backend key row, Zod
  config, and replacing the planned registry entry with an instrumented one.

## Migration & rollback

Additive only: new files, two union members (`ai_decisions`, `token`), one planned registry entry,
one script. Rollback is reverting the commit; nothing persists, nothing is called at runtime.

## Not authorized here (designed for, not built)

Recommendation relevance scoring (per-candidate `score` questions over verified facts), place-import
classification, review moderation. Each needs its own issue and owner approval.
