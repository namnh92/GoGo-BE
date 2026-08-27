# GoGo Backend Threat Model (QP-006)

Scope: API BFF + worker + PostgreSQL + Redis + providers. Assets: user
accounts/PII, guest sessions, room data (preferences are private), place
catalog integrity, ranking configs, admin access. Method: STRIDE per surface.
Status legend: ✅ mitigated+tested · 🟡 mitigated, test pending · 🔴 open.

## Trust boundaries

1. Internet → BFF (consumer + CMS routes)
2. BFF → PostgreSQL/Redis (internal)
3. BFF/worker → external providers (Google, push, R2)
4. Worker ← outbox (async, at-least-once)

## STRIDE by surface

### Auth & sessions (`/v1/auth/*`, `/v1/sessions/*`)

| Threat          | Vector                      | Mitigation                                                       | Status                           |
| --------------- | --------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| Spoofing        | credential stuffing         | argon2id; lockout 5/15m per account; per-IP rate limit           | ✅ `auth.int.spec`               |
| Spoofing        | account enumeration         | identical 401 both paths; dummy-hash timing; register 409 opaque | ✅                               |
| Spoofing        | stolen refresh token replay | single-use rotation; reuse ⇒ family revoke                       | ✅                               |
| Tampering       | JWT forgery/tamper          | HS256, ≥32-byte secret enforced in prod boot; tamper test        | ✅                               |
| Elevation       | guest → other rooms         | token `room` claim + policy double-check                         | ✅ `rooms.int.spec`              |
| Elevation       | guest → user APIs           | `requireUser` on user-only surfaces                              | ✅                               |
| Repudiation     | login events                | audit log admin login; login_attempts (hashed)                   | ✅                               |
| Info disclosure | tokens in logs/URLs         | pino redaction paths; tokens only in body/cookie                 | 🟡 log-audit in review checklist |
| DoS             | login/OTP floods            | per-action limits; Redis store multi-instance                    | ✅ `platform.int.spec`           |

### Web session (cookies)

| Threat            | Vector               | Mitigation                                     | Status |
| ----------------- | -------------------- | ---------------------------------------------- | ------ |
| CSRF              | cookie-auth mutation | SameSite=Lax + double-submit header            | ✅     |
| XSS steal session | script reads cookie  | HttpOnly; CSRF cookie value is worthless alone | ✅     |
| MitM              | cookie sniffing      | `COOKIE_SECURE=true` enforced in prod boot     | ✅     |

### Rooms/invites (`/v1/rooms/*`)

| Threat          | Vector                      | Mitigation                                                                      | Status |
| --------------- | --------------------------- | ------------------------------------------------------------------------------- | ------ |
| Spoofing        | invite brute force          | 128-bit codes, hash-only at rest, expiry/revoke/maxUses atomic, join rate limit | ✅     |
| Elevation       | member calls host-only      | RoomPolicy role check server-side (hand-crafted request tests)                  | ✅     |
| Info disclosure | preference leakage          | members endpoint returns progress only; selections owner-only                   | ✅     |
| Info disclosure | room code leak to members   | code returned to host only                                                      | ✅     |
| Tampering       | concurrent constraint edits | optimistic versioning 409                                                       | ✅     |

### Search/places (public)

| Threat          | Vector                   | Mitigation                                                                                | Status                                                            |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Injection       | tsquery/SQL via `q`      | parameterized SQL only; tsquery metachar strip                                            | ✅                                                                |
| DoS             | expensive geo/text scans | limit≤50, radius cap, rate limit 60/min/IP, GiST/GIN indexes                              | 🟡 load test pending (#76)                                        |
| Info disclosure | PII in search logs       | zero-result event stores normalized query + pseudonymous actor only                       | ✅                                                                |
| SSRF            | place import URL         | host allowlist; provider adapter does resolution; no raw fetch of user URL body           | ✅ (short-link expand is HEAD via adapter — keep allowlist tight) |
| Tampering       | fake places via import   | provider verification + thresholds + service-area + `community_submitted` + editor review | ✅                                                                |

### Suggestion/votes/plans

| Threat    | Vector                         | Mitigation                                                | Status |
| --------- | ------------------------------ | --------------------------------------------------------- | ------ |
| Tampering | vote stuffing / off-list votes | idempotent upsert per member; allowlisted candidates only | ✅     |
| Tampering | client-sent prices/scores      | server recalculates totals; DTO never trusted             | ✅     |
| Elevation | non-host finalize/edit plan    | policy checks                                             | ✅     |
| DoS       | suggestion spam                | 6/min/actor limit                                         | ✅     |

### CMS (`/v1/cms/*`)

| Threat      | Vector                      | Mitigation                                                             | Status                  |
| ----------- | --------------------------- | ---------------------------------------------------------------------- | ----------------------- |
| Spoofing    | staff credential theft      | TOTP MFA; prod refuses non-MFA login; SSO khi có IdP                   | 🟡 (SSO 🔴 blocked #62) |
| Elevation   | consumer token / stale role | act=admin required; role re-read per request; suspended = instant deny | ✅ `cms.int.spec`       |
| Tampering   | ranking manipulation        | bounds validation; four-eyes approval; versioned + rollback; audit     | ✅                      |
| Repudiation | who changed place/config    | append-only audit with diff + actor                                    | ✅                      |

### Platform

| Threat          | Vector                         | Mitigation                                              | Status |
| --------------- | ------------------------------ | ------------------------------------------------------- | ------ |
| Replay          | retried mutations double-apply | Idempotency-Key replay + body-hash 422                  | ✅     |
| Tampering       | outbox event forgery           | events written only in-transaction server-side          | ✅     |
| Info disclosure | stack traces to clients        | error envelope; internals log-only                      | ✅     |
| DoS             | provider latency cascade       | timeout/retry/breaker; fallbacks                        | ✅     |
| Info disclosure | backup theft                   | 🔴 encryption-at-rest depends on managed provider (#21) | 🔴     |

## Open risks (tracked)

1. 🔴 SSO for CMS — blocked on IdP (#62 note).
2. 🔴 Backup encryption + restore rehearsal — blocked on provider (#21/#30).
3. 🟡 Load/soak validation of rate limits + query costs (#76).
4. 🟡 Dependency/supply-chain scanning in CI (add `pnpm audit` + Dependabot — small follow-up).
5. 🔴 Pentest before beta (QP gate) — schedule with team.

Review cadence: revisit per release gate (Alpha/Beta/Pilot — WBS §18) and on
any auth/permission/ranking change (CODEOWNER rule).
