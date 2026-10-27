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

## GitHub identity: act as the agent App, never as the owner

Every write an agent session makes to GitHub — push, pull request, PR or issue comment, review
request — goes through the agent GitHub App (GoGo-Infra#250), so it is authored by `<app>[bot]`
and the owner can approve it. The wrapper lives in GoGo-Infra, checked out next to this
repository on an up-to-date `develop`:

```bash
../GoGo-Infra/scripts/secrets/as-agent.sh -- git push -u origin <branch>
../GoGo-Infra/scripts/secrets/as-agent.sh -- gh pr create --base develop --title "…" --body-file <file>
../GoGo-Infra/scripts/secrets/as-agent.sh -- gh issue comment <n> --body-file <file>
```

- The command after `--` is one of an allowlist of concrete forms: `git push <remote> …` (the
  remote by name, of this checkout, on github.com), `gh pr create|comment|edit|view|list|checks`,
  `gh issue create|comment|edit|close|reopen|view|list`, `gh run view|list`, `gh repo view`,
  `gh api <relative path>`. Every option must be in that form's table; anything else — a shell,
  a script, `env`, a path to git, `git -C …`/`-c …`, any other git subcommand or alias, a gh
  alias/extension, `gh pr merge`/`review`, `-R HOST/OWNER/REPO`, `--hostname`, a URL where a
  number belongs, `-w`/`-e` — is refused before any token is minted, and gh is pinned to
  github.com. Run it from the checkout it concerns. (GoGo-Infra `docs/secrets.md` → *Using it* has the
  tables and the stated residuals; a new form is one table line plus a test, never a wider rule.)
- The command runs in an environment the wrapper builds: your global/system git and gh config,
  `~/.netrc`, hooks and push signing are not loaded (proxy/CA only via the environment), and the
  gh forms have no git transport — push with the `git push` form first. Residual: programs on
  your `PATH` or named in this checkout's own config still run as you, with the token.
- Read-only calls (`gh pr view`, `gh pr checks`, `gh issue list`, `gh api` GETs) may use the
  session's own login.
- Minting the token needs AWS credentials for the `ci` rows (on the owner's workstation:
  `AWS_PROFILE=gogobootstrap`). If it fails, stop and tell the owner. Do not fall back to the
  owner's `gh` login or git keychain: a pull request authored by the owner cannot be approved by
  the owner, and the code-owner gate on `develop` exists for exactly that.
- A session with no AWS access (e.g. a cloud session) may push its branch with the access it
  has, but does not open the pull request itself: it reports the branch and the prepared PR body
  so a session that can run `as-agent.sh` opens it.
- The App has no `workflows` permission, by design: GitHub rejects a push from it that
  creates or changes anything under `.github/workflows/`. Push such a branch with the session's
  own git access (the push author does not count as the PR author), then open the pull request
  with `as-agent.sh` as usual.
- Never print the token, write it to git config or a file, or put it in a remote URL.
- Never merge. Merging stays with the owner.

Details, creation and revocation: GoGo-Infra `docs/secrets.md` → *Agent GitHub App*.
