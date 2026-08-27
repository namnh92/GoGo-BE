# GoGo Backend Runbooks (QP-008 / DB-011)

Provider-agnostic drafts. Items marked **[infra]** get concrete commands once
the managed Postgres/host decision lands (#21); game-day rehearsal is the
acceptance for this doc.

## 1. Release

1. `release/x.y.z` from `develop`; only version bump, notes, config, necessary bugfixes.
2. CI green = lint/format/typecheck/unit/**api:check (contract drift)**/integration/build.
3. Merge → `master`, tag `vX.Y.Z` (annotated, immutable), merge back `develop`.
4. Deploy order: **migrations → worker → api** (migrations are backward-compatible by rule, so old code runs on new schema during rollout).
5. Publish contract artifact (`gogo-api-contract`) — FE repos pin the new version.
6. Post-deploy checks: `GET /v1/health`; smoke: guest join + search + suggestion on seeded room; `GET /v1/cms/ops/kpis` baseline; error rate + p95 dashboards **[infra]**.
7. Record release manifest: backend version ↔ api contract version ↔ FE versions (repo rule: no shared version).

## 2. Rollback

- **Code:** redeploy previous tag. Safe because migrations are expand-only within a release (ADR-0002); never `migrate down` in production.
- **Schema mistake:** roll **forward** with a reverting migration; forward-test it on a snapshot first.
- **Ranking config:** `POST /v1/cms/ranking-configs/{key}/rollback` (engine falls back to bounded defaults) — no deploy needed.
- **Feature regression:** kill switches via `PUT /v1/cms/feature-flags/{key}` (e.g. `FLAG_AI_REFINEMENT`, `place_import.autopublish`).
- Decision rule: user-facing correctness bug → roll back first, diagnose after. Data-corruption suspicion → stop writes (maintenance mode **[infra]**) before anything.

## 3. Incident response

1. **Detect:** SLO alerts (BFF p95 ≤500ms, search ≤700ms, suggestion ≤3s, availability 99.9%) **[infra]**; `/v1/cms/ops/kpis` for domain health (zero-result spike, provider errors, over-budget plans, moderation backlog).
2. **Triage matrix:**
   - 5xx spike → check DB pool saturation, then recent deploy → rollback path above.
   - Provider errors ↑ → breakers should be open (logs `provider … unavailable`); verify fallbacks serving (areas fallback list, deterministic suggestions); no action needed beyond provider status page.
   - Queue lag (outbox unpublished ↑) → `select count(*) from outbox_events where published_at is null` — restart worker; events are idempotent, at-least-once.
   - Auth anomaly (lockout spike / token reuse revocations) → check `login_attempts` + `auth_sessions.revoke_reason='refresh_token_reuse'`; if credential-stuffing: tighten per-IP limits via config, consider IP block at WAF **[infra]**.
3. **Communicate:** status note + severity; PII never in incident docs — use pseudonymous ids.
4. **Postmortem:** blameless, within 3 days; action items become issues.

## 4. Backup / restore (DB-011)

- **Targets:** RPO ≤15 min, RTO ≤2 h (SRS §10.1). Requires managed Postgres with WAL-based PITR **[infra — blocked #21]**.
- Continuous WAL archiving + daily base backup; backups encrypted; restore credentials separate from runtime credentials.
- **Restore drill (quarterly, on a scratch instance):**
  1. Restore to point-in-time T.
  2. Verify invariants: migrations table matches expected; `plans_room_current_unique` holds; row counts within expectation; PostGIS/pg_trgm extensions present (`f_unaccent('Đà') = 'Da'`).
  3. Run `pnpm eval:search` (EVAL_REPORT_ONLY=1) against restored DB as functional smoke.
  4. Measure wall-clock vs RTO; record in drill log.
- **Redis:** cache/queues only — safe to flush; outbox re-drives notifications; rate-limit windows reset (accepted).

## 5. Data-fix / privacy operations

- Ad-hoc data fixes: through a reviewed migration or CMS API (audited) — never raw psql in prod without a paired audit_logs insert.
- Retention: worker runs `PrivacyJobs` daily 03:00 ICT; manual dry-run: `PrivacyJobs.run(true)` prints report without writing.
- Account deletion/export are self-serve (`DELETE /v1/me`, `GET /v1/me/export`); support-initiated equivalents go through the same code path.

## 6. Migration execution

1. PR includes: forward test on snapshot (CI does fresh-container apply), documented rollback path, lock analysis (no long exclusive locks; use `CREATE INDEX CONCURRENTLY` for new prod indexes **[infra]** — drizzle migration files hand-edited when needed per ADR-0002).
2. Apply in maintenance budget window; monitor `pg_stat_activity` for lock waits **[infra]**.
3. Verify: app boots (fail-fast config), health check, smoke.
