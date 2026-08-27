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

## Review log — 2026-08-27 (code audit + live probes)

Two findings were proven against the running stack, not inferred. Both are
fixed in this change; the probes are now regression tests.

### 1. IP rate limits were bypassable (HIGH — fixed)

`trustProxy: true` made Fastify trust `X-Forwarded-For` from **any** source, so
`req.ip` was client-controlled. Probing the API directly (bypassing Caddy) with
a rotating XFF header: **14/14 requests passed a 10/min limit, never a 429**.

The deployed path happened to be safe only because Caddy overwrites XFF for
untrusted clients — a single misconfiguration (a published port, a second
ingress, a k8s service, local port-forward) removed every IP-keyed defence at
once: login brute force, guest-join floods, search scraping, and the
provider-billed `places/resolve-google-maps-link`.

**Fix:** `TRUST_PROXY` env, default and prod value `1` — trust only the
immediate hop (Caddy); `false` when the API is exposed directly; a CIDR list
for multi-hop ingress. Verified after the fix: an external client rotating
`X-Forwarded-For` through Caddy is still limited at request 11/10, i.e. the
spoofed value is ignored.

**Residual (accepted):** hop/CIDR trust cannot distinguish the real proxy from
another workload on the same private network — anything already inside that
network can still present its own XFF. The compensating control is that the
API port is never published; only Caddy is reachable from outside. Publishing
`api:3000` would reopen this, so it must stay unpublished.

Account-level login lockout was never affected (it keys on the identifier
hash), which is why login brute force stayed bounded even while this was open.

### 2. Logout did not stop the access token (MEDIUM — fixed)

`DELETE /sessions/current { allDevices: true }` revoked the refresh chain but
the outstanding JWT kept working for up to 15 minutes. Probe: after logout,
`/me`, `/me/saved` and **`/me/export` (full PII export)** all returned `200`.

Room-scoped routes were protected (RoomPolicy re-reads membership), but
account-level routes were not — so "log out of all devices" on a stolen phone
did not actually cut access to the user's own data.

**Fix:** a session-id denylist (Redis + per-process fallback) held for exactly
one access-token lifetime. Populated by logout, logout-all, refresh-token-reuse
family revoke, guest logout, and host-removes-member. The guard rejects denied
`sid` with `401 SESSION_REVOKED`.

**Residual:** during a Redis outage a revocation made on instance A is not
visible to instance B for the remaining token lifetime (≤15 min). Accepted for
MVP (single instance); revisit when scaling horizontally.

### Checked, no change needed

- JWT tamper / wrong-secret rejection, HS256, no PII in claims — covered by
  `token.service.spec`.
- Guest room scoping, host-only actions, CMS role re-read per request — covered
  by hand-crafted request tests in `rooms.int.spec` / `cms.int.spec`.
- SQL/tsquery injection: every query parameterised; the ingestion PG array
  helper escapes quotes/backslashes.
- SSRF on place import/resolve: allowlist + per-hop re-validation + private-IP
  block, probed live (`UNSAFE_TARGET` on metadata/loopback/private targets).
- Error envelope leaks no internals; logs redact tokens/PII.
- `/v1/health/ready` exposes dependency up/down publicly — accepted (no data,
  and uptime monitors need it unauthenticated).

## Review log — 2026-08-27 (bulk import surface, PI-SEC-001)

Scope: the CMS bulk import added in PR #130 — file upload, XLSX/ZIP parsing,
Google Sheets read, error-report export. Reviewed against spec §12.

### Fixed during the review

| #   | Finding                                                                                                                                | Fix                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | XML numeric entity out of range (`&#x110000;`) threw `RangeError` from `String.fromCodePoint`, turning a malformed workbook into a 500 | Out-of-range code points are left as literal text (`tabular/xlsx.ts`)                         |
| 2   | A malformed cell ref (`<c r="1"/>`) produced `columnIndex() === -1` and a negative array write                                         | Bad ref falls back to append order                                                            |
| 3   | The upload filename — attacker-controlled — was stored on the job and echoed back to the CMS unmodified                                | `sanitizeFileName()`: basename only, control chars and `<>"'\`` stripped, capped at 180 chars |

### Checked, no change needed

- **SSRF.** `google_maps_url` goes through the existing allowlist + per-hop
  re-validation + private-IP block. The Sheets _URL is never fetched_: only the
  spreadsheet id is extracted and passed to `sheets.googleapis.com`, a fixed
  host. Non-Google spreadsheet links are refused (`SHEET_URL_INVALID`).
- **Upload limits.** Enforced twice — `@fastify/multipart` (20 MB, 1 file, 12
  fields, 64 KB/field) before buffering, then the parser caps (5.000 rows, 64
  columns, 2.000 chars/cell).
- **Archive handling.** Nothing in the archive is executed; only the named XML
  parts are inflated. `xl/vbaProject.bin` → `FILE_MACRO_NOT_ALLOWED`. Zip bomb:
  200 MB total expansion cap, 200× per-entry ratio cap, plus `maxOutputLength`
  on each inflate so a lying central directory errors instead of allocating.
  ZIP64 and encrypted entries are refused rather than partially parsed.
- **Entity expansion.** Only the five predefined XML entities are expanded and
  no DTD is processed, so a billion-laughs payload has nothing to expand.
- **Zip path traversal.** Entry names are keys in an in-memory map; the reader
  never touches the filesystem, so `../` in a name goes nowhere.
- **Content-type confusion.** Format is decided by leading bytes; a `.xlsx`
  name over CSV bytes is `FILE_TYPE_MISMATCH`, legacy OLE2 `.xls` is refused.
- **CSV formula injection.** Error-report cells starting `=` `+` `-` `@` (and
  tab/CR) are apostrophe-prefixed; the response is
  `Content-Disposition: attachment` + `nosniff`.
- **Abuse.** Import creation is rate-limited 10 per 5 min per admin; the public
  resolve endpoint 10/min per IP; submissions 5/min. Every mutation is audited.
- **Authorization.** All import routes require `editor`/`ops_admin`;
  **publish is `ops_admin` only**. The admin row is re-read per request, so a
  suspended admin loses access mid-session. `confirm-candidate` accepts only a
  provider id the resolver surfaced for that row.
- **Secrets.** The Sheets/Places key lives in the adapter only and never
  reaches an error body, a log line or the job record.

### Residual

- 🟡 **No virus scanning of uploads** (spec §12). Uploads are parsed, never
  executed or re-served, so the risk is to whoever later opens the original
  file — but the control is genuinely missing. Needs a scanner service; not
  wired (tracked here).
- 🟡 Import history is visible to any `editor`; there is no per-team scoping.
  Accepted for MVP — CMS accounts are staff-only.

## Open risks (tracked)

1. 🔴 SSO for CMS — blocked on IdP (#62 note).
2. 🔴 Backup encryption + restore rehearsal — blocked on provider (#21/#30).
3. 🟡 Load/soak validation of rate limits + query costs (#76).
4. 🟡 Dependency/supply-chain scanning in CI (add `pnpm audit` + Dependabot — small follow-up).
5. 🔴 Pentest before beta (QP gate) — schedule with team.
6. 🟡 Virus scanning for CMS bulk-import uploads (PI-SEC-001 residual).

Review cadence: revisit per release gate (Alpha/Beta/Pilot — WBS §18) and on
any auth/permission/ranking change (CODEOWNER rule).
