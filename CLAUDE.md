# GoGo-BE

Backend BFF for GoGo (couple/group date planning). Modular monolith: `apps/api` + `apps/worker`, shared `libs/`.

**Stack (locked):** TypeScript, NestJS + Fastify, REST + OpenAPI `/v1`, PostgreSQL + PostGIS, Drizzle ORM + raw parameterized SQL for geo/FTS/ranking, Redis + BullMQ, SSE-first realtime, Cloudflare R2/CDN/WAF, OpenTelemetry + Sentry, Vitest/Jest + Supertest + Testcontainers, Docker, GitHub Actions.

## Structure

`libs/modules/{identity,rooms,preferences,places,search,suggestions,plans,reviews,notifications,cms}` — each module: `domain/` (entities, invariants) → `application/` (use cases) → `infrastructure/` (Drizzle repos, outbox) → `presentation/` (controllers, DTOs, authz policies). Also `libs/{database,providers,observability}`, `migrations/`, `openapi/`, `docker/`, `docs/adr/`.

## Hard rules

- Controllers hold no business logic. Drizzle models are never public response DTOs.
- DTOs return facts, not composed sentences (`type`, `participantCount`, `budgetMode: 'total'|'per_person'`, amounts as integer minor units).
- Rooms support N members; `host/member/guest` enforced server-side by policy (actor + membership + role + resource state).
- Constraint change → dependent scores/plans stale. Locked stops survive regenerate. Votes idempotent.
- AI never overrides hard constraints; only allowlisted candidate IDs; schema + budget/time validation; ≤15s timeout → deterministic fallback; kill switch.
- Place facts (price/hours/availability) only from verified data, never AI output.
- **No new persistent Google content.** Place IDs may be stored indefinitely; a
  provider object reused inside one execution persists nothing. Adding a
  provider-response snapshot, a new provider-derived column, or a cache of
  names/addresses/ratings/hours/coordinates is a blocking review finding. The
  freeze is permanent under the Product/Data Architecture (Google = identity,
  routes, directions only), not a wait for a sign-off; PR8 (#341/#365) was
  cancelled, not deferred.
- **Requirement authority (2026-09-02 reset):** cost work follows
  `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md`; Places ownership,
  personalization and AI follow `GOGO_PRODUCT_DATA_ARCHITECTURE.md` (workspace).
  `develop` is implementation truth — it says what exists and where it drifts,
  never what is required. The combined plans
  `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md` and
  `…_SOURCE_DRIVEN.md` are SUPERSEDED — HISTORICAL ONLY. Google-derived content
  never becomes GoGo-owned by copying, editor confirmation or transcription.
- Outbox + idempotent consumers; no distributed transactions; no DB transaction held across provider calls; providers behind adapters.
- Error envelope `{ code, message, field_errors, request_id, retryable }`; `Idempotency-Key` on retryable mutations; cursor pagination; ISO-8601 UTC.
- Migrations: forward-tested on snapshot, rollback path, no long locks. Append-only audit log for sensitive writes.
- No secrets in source or `.env.example`; no tokens in URLs/logs; invite codes high-entropy, expiring, PII-free.

## Git

Git Flow: `master` (prod, tags `vX.Y.Z`) / `develop` (integration) / `feature|bugfix|hotfix/GOGO-<ticket>-<name>` / `release/x.y.z`. Conventional Commits. PRs only.

Workspace-level docs and full skill set live in the parent GoGo workspace (`GOGO_SRS.md`, `GOGO_ENGINEERING_SKILLS_AND_PLANS.md`, `GOGO_MOCKUP_VERIFICATION_AND_TECHNICAL_APPLICATION-2.md`).
