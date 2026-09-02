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

1. **Detect:** SLO alerts (BFF p95 ≤500ms, search ≤700ms, suggestion ≤3s, availability 99.9%) **[infra]**. Those four numbers are also thresholds in `load/` (QP-005), so a load run fails and names the SLO it broke rather than producing a chart to interpret; `/v1/cms/ops/kpis` for domain health (zero-result spike, provider errors, over-budget plans, moderation backlog).
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
- **The drill runs in CI**, not only quarterly: `libs/database/test/restore.int.spec.ts`
  dumps a populated database, restores it into a _fresh_ server, and checks
  what actually matters afterwards. A drill that is only ever described is a
  drill nobody has run — the first time anyone learns whether a dump restores
  should not be during an incident.
- **Two findings from writing it, both of which look like a broken backup and
  are not:**
  1. The PostGIS image ships `tiger`, `tiger_data` and `topology`. Dumping
     them makes every restore fail with `schema "tiger" already exists`. Dump
     with `--exclude-schema` for those three.
  2. Selecting only `--schema=public` instead trades that for two worse
     errors: `CREATE SCHEMA public` colliding, and `f_unaccent` failing to
     resolve because the `unaccent` dictionary is an extension member that was
     not restored yet. Exclude the PostGIS schemas; do not select ours.
- **What the drill verifies**, beyond rows being present: `unaccent` works
  (`f_unaccent('Đà') = 'Da'` — without it Vietnamese search silently stops
  matching and nothing errors), geometry came back as geometry rather than
  text, the name-normalisation trigger fires (a restored database that accepts
  writes the original refused is the failure that looks like success), the
  one-current-plan-per-room constraint still rejects a second, and the
  migration ledger matches so the next deploy does not re-run everything.
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

### Google-content purges (ADR-0006 §9.4)

Each remediation ships as a forward-only, idempotent migration. **Record the
row count before and after in the deploy notes** — the count is the evidence
the purge ran, and an idempotent migration produces no other trace on a second
apply.

| ID  | Store                                    | Migration                           | Count query                                                                                                                            |
| --- | ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `place_sources.raw`, `raw_updated_at`    | `0033_unify-google-provenance.sql`  | `select count(*) from place_sources where raw is not null or raw_updated_at is not null;`                                              |
| R3a | `place_ingest_rows.candidates[].lat/lng` | `0034_candidate-coordinates.sql`    | `select count(*) from place_ingest_rows where jsonb_path_exists(candidates, '$[*].lat') or jsonb_path_exists(candidates, '$[*].lng');` |
| R5  | `place_imports.provider_snapshot`        | `0036_import-provider-snapshot.sql` | `select count(*) from place_imports where provider_snapshot is not null;`                                                              |

After each: the count must be **0**, and re-running the migration must leave it
at 0 while reporting `UPDATE 0`. None of the three has a down path — restoring
the values would undo the compliance fix, and every field is re-fetchable from
Google on demand.

The column in each case is dropped a release later, once no deployed code
names it. Do not fold that drop into the purge migration: a rollback to the
previous deployment must still find the column.

## 6. Migration execution

1. PR includes: forward test on snapshot (CI does fresh-container apply), documented rollback path, lock analysis (no long exclusive locks; use `CREATE INDEX CONCURRENTLY` for new prod indexes **[infra]** — drizzle migration files hand-edited when needed per ADR-0002).
2. Apply in maintenance budget window; monitor `pg_stat_activity` for lock waits **[infra]**.
3. Verify: app boots (fail-fast config), health check, smoke.

## 7. Ingestion & platform alerts (PI-SRE-001, #120)

Metrics are scraped from `GET /v1/metrics`, guarded by `METRICS_TOKEN`. With no
token set the route answers 404 — an unconfigured deployment does not quietly
publish its internals. Alert conditions live in `docs/infrastructure.md` §3b;
this is what to do when one fires.

`ALERTED_METRICS` in `@gogo/observability` lists the names those rules depend
on, and a test fails if one is renamed. An alert matching a series nobody emits
looks exactly like an alert that is quiet because nothing is wrong, which is
the failure this guards against.

### Break-glass takedown (`cms_emergency_takedown_total`)

**Pages immediately, on any occurrence.**

1. `GET /v1/cms/audit?breakGlass=true` — actor, role, reason, request id, IP.
2. One takedown with a plausible reason is the system working. Several in a
   row from one actor is the signal that matters: treat it as a possible
   account compromise, not as a busy moderator.
3. If compromised: suspend the admin (`status = suspended`), which kills read
   and write on the next request, then review every action in that window.
4. Restoring is a separate, privileged action on purpose — do not reverse a
   takedown to "tidy up" before the review is done.

### Ingestion paused on provider quota (`place_import_jobs_total{status="paused_provider_quota"}`)

Not a data error. Rows are intact and the job is waiting.

1. Check the Google Cloud console for the actual quota and the daily spend.
2. If quota is genuinely exhausted, decide whether to raise it or wait — the
   job resumes with `POST /v1/cms/place-imports/{jobId}/start`, from where it
   stopped, with no duplicate rows.
3. Do **not** cancel to "clear" the alert: cancel drops unprocessed chunks and
   the already-imported rows stay, which is the confusing half-state.

### Provider errors > 10% (`places_provider_requests_total{status!~"2.."}`)

**Read the reason before concluding "outage" (#273).** Every failure is
counted again on `places_provider_failures_total{method,status,reason}`, where
`reason` is Google's own `error.details[].reason`. It is the only field that
separates a dependency having a bad day from a setting in our console:

| `reason`                                                       | What it actually is                                                                          | Who fixes it                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `SERVICE_DISABLED`                                             | The API was never enabled on our GCP project                                                 | Operator, in the console. Waiting never clears it                      |
| `API_KEY_SERVICE_BLOCKED`                                      | Key restricted to a different API — the failure `#271`'s one-key-per-API split made possible | Operator: fix the restriction, or the key is in the wrong variable     |
| `API_KEY_INVALID`                                              | Key deleted or mistyped                                                                      | Operator: re-put the secret                                            |
| `API_KEY_HTTP_REFERRER_BLOCKED` / `API_KEY_IP_ADDRESS_BLOCKED` | Application restriction does not match a server-side caller                                  | Operator: server keys take an IP restriction or none, never a referrer |
| absent, 5xx                                                    | Genuine upstream fault                                                                       | Nobody. Wait                                                           |

These raise `ProviderConfigurationError`, which is deliberately **not**
retried and does **not** count toward the circuit breaker — a disabled API
answers the third attempt exactly as it answered the first, and letting it
open the breaker is what made a permanent console setting look like a
dependency flapping on a cycle.

**A rejection is not a failure (#314).** When Google's `error.status` is
`INVALID_ARGUMENT` or `NOT_FOUND`, it understood the request and refused it —
almost always a place id from a link a user pasted wrong. Those are counted on
`places_provider_rejected_total{method,canonical_status}` and are deliberately
**absent** from `places_provider_failures_total`, because an alert on that
series asserts Google is not serving us and a user's typo must not make that
assertion. They raise `ProviderInvalidRequestError`: not retried, not counted
toward the breaker, and turned into a business result (`INVALID_URL`) rather
than a 503.

If `places_provider_rejected_total` climbs on its own while failures stay flat,
nothing is broken here — look at where the links are coming from. If it climbs
because _we_ built a malformed request, that is our bug, and the `method` label
says which call.

1. Distinguish key problems from outages: a wrong or expired key fails every
   call, an outage fails some.
2. Key problems — rotate the key for the failing API from the secret manager
   (`GOOGLE_PLACES_API_KEY`, `GOOGLE_ROUTES_API_KEY` or `GOOGLE_SHEETS_API_KEY`
   — they are separate, so only one surface is down) and
   restart. The circuit breaker will have opened; it closes on its own after
   the cooldown, so no manual reset.
3. Outage — nothing to do but wait. Ingestion pauses, search and suggestions
   keep working on catalog data, and travel time falls back to straight-line
   estimates marked as estimates.

### Provider slow (p95 `place_provider_request_duration_seconds` > 1s)

Google itself is slow. `place_provider_request_duration_seconds{method,status}` times
the HTTP call and nothing else, so it separates "Google is slow" from "we are
slow around Google" — `place_resolve_duration_seconds` covers both and cannot tell
you which. Its buckets are tuned to the 25–300ms band every observed call lands
in (#313), so a shift of 50ms is visible rather than rounded into the next
bucket, and 1s — where this alert fires — is a bucket edge rather than a point
interpolated between two (#320).

Nothing to do but confirm it is Google: check the status page, check whether one
`method` is slow or all of them. A single slow `method` with the others healthy
is more likely our request shape — an oversized field mask, a batch that grew —
than an upstream problem.

### Resolve slow (p95 `place_resolve_duration_seconds` > 3s)

A 5,000-row job will not finish inside its window. Either accept the longer
run or pause the import; do not raise the timeout, which only moves the
failure later and burns quota on calls that will be abandoned.

### Cost over budget (`places_provider_cost_units`)

The metric is the early warning, **not** the control. The binding limit is the
budget alert in Google Cloud Billing — set that too, because a metric on a
process that has stopped emitting cannot tell you it is spending.

### Submissions stale (p95 `place_submission_publish_latency_hours` > 72h)

The moderation queue is being ignored rather than failing. Check
`GET /v1/cms/place-submissions` for depth, and whether one editor account is
carrying the whole queue.

### Duplicate Google calls came back (`place_dbfirst_hit_total`, `place_resolution_attestation_total`)

#337 removed two repeated `details` calls. Both removals are switchable, so the
first question when spend climbs is whether they are still on.

| Symptom                                                          | Read it as                                                                                                                                                     | Do                                                                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `place_dbfirst_hit_total` at ~0 with imports still running       | the shortcut is off, or every id is genuinely new                                                                                                              | check `feature_flags` for `place_dbfirst.enabled`; then read `place_dbfirst_miss_total{reason}`                                                                              |
| `place_dbfirst_miss_total{reason="stale"}` climbing              | provider rows are past `refresh_after`, so DB-first cannot answer for them — this is a refresh backlog                                                         | PR7's refresh job is what fixes it; the fallback is correct, just expensive                                                                                                  |
| `place_dbfirst_miss_total{reason="legacy"}` non-zero             | pre-PR1 `place_sources` rows with no freshness to check                                                                                                        | expected to trend to zero as PR1's backfill completes; a rising count is a regression                                                                                        |
| `place_dbfirst_miss_total{reason="closure_unverified"}` non-zero | a stored `source_status` says closed but is older than `PLACE_RESOLUTION_TTL_S`, so the place was re-checked against Google instead of refused on a stale fact | expected and deliberate — it is one Details call spent so a reopened place is not told it is shut. A high rate means closed rows are not being refreshed, which is PR7's job |
| `place_resolution_attestation_total{result="unconfigured"}`      | the deployment has no `PLACE_RESOLUTION_ATTESTATION_SECRET` and is silently paying for the second fetch                                                        | set the SSM parameter `places/resolution-attestation-secret` (GoGo-Infra manifest) and redeploy                                                                              |
| `..._total{result="bad_signature"}` non-zero                     | tokens are being forged, or the secret was rotated without draining the old TTL                                                                                | a rotation shows as a burst that decays within `PLACE_RESOLUTION_TTL_S`; anything sustained is abuse                                                                         |
| `..._total{result="expired"}` high                               | users take longer than the TTL between preview and submit                                                                                                      | that is a product measurement, not a fault — raising the TTL widens the replay window, so decide it deliberately                                                             |

**Turning either off is the rollback**, and neither loses correctness — both
paths fall back to asking Google, which is what the code did before:

```sql
-- kill the DB-first shortcut for this environment
insert into feature_flags (key, environment, platform, enabled)
values ('place_dbfirst.enabled', 'production', 'all', false)
on conflict (key, environment, platform) do update set enabled = false;

-- …or the attestation
insert into feature_flags (key, environment, platform, enabled)
values ('place_resolution_attestation.enabled', 'production', 'all', false)
on conflict (key, environment, platform) do update set enabled = false;
```

Both default **on** with no row, because they remove spend rather than add a
feature. A `RESOLUTION_TOKEN_INVALID` in a client's hands is not an incident:
the client is being told to resolve again, which is the one thing that has to
happen rather than a silent second Google call.

### super_admin bypass (`cms_super_admin_bypass_total`)

A rising count means the role model does not fit the work people actually do —
it is not, by itself, evidence that anyone misbehaved. Read the audit with
`authorization_path = 'super_admin_bypass'`, see which routes keep needing it,
and fix the role model rather than the people.
