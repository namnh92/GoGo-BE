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

- 🟢 **No virus scanning of uploads** — _accepted risk, decided 2026-08-27._
  Operators vet import files before uploading them. The backend never executes
  an upload and never serves it back: bytes are parsed in-process, and only the
  parsed cell values are stored. The residual exposure is to whoever opens the
  original file outside GoGo, which the upload path does not widen. Revisit if
  import is ever opened past staff accounts.
- 🟡 Import history is visible to any `editor`; there is no per-team scoping.
  Accepted for MVP — CMS accounts are staff-only.

### Audit record (BE-IMP-007)

Every audit row now carries `request_id` and, for **admin actors only**,
`ip_address`. Both come from the request context (`AsyncLocalStorage`), filled
by one Fastify hook — audit writers sit deep in services that never see the
request, which is why `request_id` had been declared on the table and populated
by exactly one writer, and the IP had nowhere to go at all.

IP is PII, so the scope is deliberate: staff accountability needs to tell "that
admin did it" apart from "that admin's account was taken over". That
justification does not extend to users or guests, whose actions are audited
without an IP. The IP comes from `req.ip`, which honours `TRUST_PROXY` — a
client cannot write its own address into the audit trail.

### Emergency takedown / break-glass (SEC-001)

Normal writes stay with the role that owns them — right until nobody who owns
them is awake. Without an escape hatch the practical outcome is a shared
`super_admin` account, and a shared account collapses the audit trail into one
identity, losing exactly what RBAC exists to give.

The hatch is narrow rather than absent, and asymmetric on purpose: **taking
content down** (`POST /v1/cms/emergency/*`) is open to every active admin role
because it is reversible and reduces harm; **putting it back up** — restore,
publish, activate — keeps its usual privileged role. Wrongly suspending costs
five minutes of an editor's time; wrongly publishing has already reached users.

Scope is one transition per resource: place `published → suspended`, review
`published → hidden`, check-in `→ hidden`. Deliberately excluded: delete and
archive (side effects that do not undo cleanly), ranking configs and feature
flags (ops-only config, and ops is usually on call anyway).

**Abuse of the hatch itself** is the risk this opens. A compromised staff
account could mass-suspend the catalog — a denial of service on the business,
through the door we just built. Mitigations: one resource per call with no bulk
form, a dedicated limit of 20/hour per admin **plus a 5/minute burst cap** (an
hourly cap alone still allows twenty takedowns in two seconds, which is a
script, not an incident), and every call raising an alert rather than only a
counter.

Each call is audited with actor, role, request id, staff IP, reason (required,
≥10 chars) and before/after state, and emits
`cms_emergency_takedown_total{resource_type, role}`.

**Success condition**: a takedown counts only when the resource is gone from
discovery, not when the row is written. Today search and suggestion read
`status` live from Postgres, so that holds automatically; an integration test
asserts the place disappears from search results, which is what turns red the
day an external index lands (SE-009) and a takedown would otherwise silently
stop working.

Residual: alert **routing** still depends on a metric destination (#120). Until
then the alert exists as a distinctly-named metric in the log stream, not as a
page.

### super_admin observability (SEC-002, part A)

`super_admin` bypasses every role gate. That is the design — there has to be an
escape hatch — but an unobserved hatch becomes the main road: when parallel
writes are inconvenient, people reach for the shared account, and a shared
account collapses the audit trail into one identity.

So every audit row records **which rule authorized it**: `exact_role` (the role
that owns the action), `rank_read` (a peer or higher rank reading, SEC/#143), or
`super_admin_bypass` (would have been refused for any other role). Only the last
one is the hatch, and its frequency is the signal for whether the role model
matches the work or is being routed around.

Deliberately observation, not obstruction: `super_admin` is not blocked and no
extra confirmation step is added. Blocking an emergency escape hatch is the
surest way to have it worked around by some other route.

A bypass **write** also emits `cms_super_admin_bypass_total`, labelled by
`action` (method plus route pattern) and `resource_type`. Only writes through
the hatch are counted: a `super_admin` reading, or writing where its own role
was what the route asked for, is ordinary work, and counting it would drown the
signal. The label is the route pattern rather than the resource id — one label
per place would make the counter unusable, and the audit log is where a
specific resource is looked up.

A rising count means the role model does not fit the work people actually do.
It is not, by itself, evidence that anyone misbehaved.

Answering "how often was the hatch used, on what" therefore needs no metrics
backend either — it is also one query on `audit_logs`. Alerting on a threshold
does, and waits on the metric destination (#120). The threshold itself waits on
a real baseline: setting one before knowing the normal rate only manufactures
noise.

### Spoofed client address (#77)

`TRUST_PROXY` used to default to `1`, meaning Fastify took `X-Forwarded-For`
from the direct peer. Anywhere the API is reachable without a proxy in front of
it, that peer is the client — so a client could send its own header and get a
fresh rate-limit bucket on every request, and could write whatever address it
liked into the audit log's staff IP.

Measured before the fix: fifteen guest-join attempts from one source with a
rotating `X-Forwarded-For` drew **no** 429 at all, while the same fifteen from
a fixed address were cut off after ten.

The default is `false` now — trust nobody — and production must set the value
explicitly. Getting it wrong now costs availability (every client looks like
the proxy and shares one bucket) rather than security, and an operator running
behind a proxy is made to say so rather than inheriting a default that happens
to match.

The regression test uses an IP-keyed route with no per-account fallback, so it
measures the IP key alone. The obvious login test passes either way, because
per-account lockout catches it — which is why it is not the test that guards
this.

### Admin second factor (#62)

The console had MFA in the sense that a code was checked. Four things it was
not doing:

The TOTP secret sat in a column called `mfa_totp_secret_enc` and was stored in
plaintext. An attacker holding a database dump already has the password
hashes; the second factor is precisely what is supposed to still stop them,
and unencrypted it stopped nothing. Secrets are AES-256-GCM sealed now, with a
key that lives in the application and is required at 32+ characters in
production.

Enrollment wrote the secret and switched MFA on in one step, with no proof the
authenticator had received it. Since production refuses a login without MFA,
that is a lockout of the admin from their own console. Enrollment is now two
steps and only a verifying code activates it. The confirming code is spent, so
it cannot also be used to log in, and every other session for that admin is
revoked — adding a second factor is a credential change, and older sessions
were opened with less.

A code stayed usable for the whole of its 30-second step, so an intercepted
one could be replayed inside it. The highest step consumed is recorded and
compared, with the update conditional on that step so two racing requests
cannot both spend the same code.

Login was rate-limited per IP and not at all per account — on the door with
the most privilege behind it, while consumer login had per-account lockout.
Admin login now uses the same threshold and window, under a namespaced
identifier so admin and consumer counters cannot be made to collide. A wrong
TOTP code counts as a failed attempt too: counting only the password would
leave the second factor brute-forceable at the per-IP rate.

### The first CMS account, and why there is only one (DB-012, ADR-0018)

An environment holds **at most one** `super_admin` before it is bootstrapped and
**exactly one** after — the index enforces the upper bound for every writer, and
the lower bound is held by bootstrap creating the account and by no path being
able to demote or suspend it. Every other CMS account is created and managed by
that account. A second holder doubles the blast radius of a
compromise for nothing the role model needs: `ops_admin` covers every delegable
operation, and the one thing it does not cover — changing who holds which role —
is precisely what has to stay singular. Refused at the API and at the database,
because the API is not the only way into this table: `AdminAuthService` refuses
to create, grant, demote or suspend the role (`SUPER_ADMIN_SINGLETON` /
`LAST_SUPER_ADMIN`, both 409), and a partial unique index refuses a second row to
any writer at all, including a psql session.

**The database is the authentication source for that account, like every other.**
Its password is an Argon2id hash. AWS SSM holds _bootstrap_ credentials —
what the first login is typed from, once — and the bootstrap command never
overwrites an existing account. Editing the parameter afterwards changes nothing
about how the account signs in, which is the point rather than a limitation:

- a SecureString can be read back by anyone holding the path; a hash cannot;
- login gains no dependency on a network service that can be unreachable exactly
  when the console is needed;
- a parameter edit is not authenticated as a person, writes no audit row and
  revokes no session, so sessions opened under the old password would survive it.

Rotation therefore goes through account management — `POST
/cms/auth/change-password`, or a temporary password from
`POST /cms/auth/admins/{id}/reset-password` — which authenticates the actor,
audits the change and revokes what it invalidates. Precisely: a self-service
change **keeps the session that made it and revokes every other session of that
account**; a reset keeps none, because there the actor is someone else and
control of the account is already in doubt.

Residual, and tracked: between provisioning a bootstrap value and the first
rotation, that value is a live credential readable by every principal holding the
backend SSM prefix. The DEV value is worse than that — it predates this work and
is the literal that was in this repository's source, so it is in the history for
good. Rotating it is a required follow-up, not a completed one.

### CMS session model (SEC-003)

The staff session used to be an access token in a response body with no server
side to it: no cookie, no refresh, and `sid` set to the admin id itself. Three
consequences, all now closed.

A browser client had to hold a bearer token in JS, against the rule that says a
web session belongs in a secure `HttpOnly` cookie. Login now sets one, scoped so
the refresh cookie only travels to `/v1/cms/auth/refresh`, with the CSRF cookie
readable for the double-submit header.

With no refresh, a 15-minute access token meant a hard logout mid-edit. Sessions
now rotate, single-use, with reuse of a superseded token revoking the family —
the same theft response as ADR-0003. The session lives 8 hours against the
consumer app's 30 days, which is the "shorter timeout for CMS" the rule asks for.

With `sid` equal to the admin id there was nothing to log out of: no logout
endpoint existed, and revoking would have hit every device that account had.
Each login is now its own row, so `POST /cms/auth/logout` ends one session and
denylists its id — an access token in flight stops working immediately, the same
guarantee #129 gave consumer sessions.

Refresh re-reads the admin row rather than trusting the token, so a suspended or
demoted account cannot refresh onward.

## Open risks (tracked)

1. 🔴 SSO for CMS — blocked on IdP (#62 note).
2. 🔴 Backup encryption + restore rehearsal — blocked on provider (#21/#30).
3. 🟡 Load/soak validation of rate limits + query costs (#76).
4. 🟡 Dependency/supply-chain scanning in CI (add `pnpm audit` + Dependabot — small follow-up).
5. 🔴 Pentest before beta (QP gate) — schedule with team.
6. 🔴 Rotate the DEV CMS super admin password (ADR-0018). The value is the
   literal that lived in this repository's source and remains in its history;
   moving credentials into SSM did not rotate it. Rotation goes through CMS
   account management, not through an SSM edit.
7. ✅ Virus scanning for CMS bulk-import uploads — accepted risk (files vetted
   before upload; staff-only endpoint). Reopen if import leaves staff scope.

Review cadence: revisit per release gate (Alpha/Beta/Pilot — WBS §18) and on
any auth/permission/ranking change (CODEOWNER rule).

## Automated security suite (QP-006, #77)

`apps/api/test/security.int.spec.ts` is the executable half of this document,
organised by the OWASP categories the security rules name, so a gap shows up as
a missing block rather than an absence nobody notices. Everything is a
hand-crafted HTTP request, because the rule is that the API is the enforcement
layer and a hidden button proves nothing.

Covered there: SQL payloads in both free text and filter parameters; forged JWT
signatures, `alg: none`, an edited `sub`, an expired token with a valid
signature, and a refresh token presented as an access token; account and
invite-code enumeration; deny-by-default on protected routes; a consumer token
against every CMS route; mass assignment of `hostUserId`; rate-limit evasion by
spoofed forwarded header; tokens in query strings; request bodies echoed into
error envelopes; and the response headers a JSON API should send.

What it does not cover, and why: anything needing a real deployment (TLS
termination, WAF rules, secret rotation) belongs to #21 and #76, and dependency
scanning belongs in CI rather than in a test file.
