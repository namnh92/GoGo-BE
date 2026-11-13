# ADR-0059: Invite-attempt device bootstrap (I05)

- Status: Approved shape rev2 implemented; CODEOWNER / independent code review pending
- Date: 2026-11-12
- Refs: GoGo-BE#891, parent #861, approved `sa-shape-be-861-invite-6-digit.astra.rev2.md` §5.1/§9
- Requirements: FR-AUTH-002/005, FR-ROOM-009; security and api-contract rules

Device proof supplies a stable attempt context across account changes. It grants
no identity, membership, hardware attestation, or extra CODE6 entropy. This slice
is standalone: no I03 schema/crypto dependency and no CODE6 admission endpoint.
CODE6 remains off until the parent gates, including ≤1% in every rolling 48h,
are met. Invite-link TTL remains 24h (#882); context TTL is independently 48h.

The BFF generates 256 random bits and stores SHA-256(proof), UUID, fixed expiry,
revocation, transport and purpose `invite_attempts`. Mobile stores the bearer in
Keychain/Keystore and sends `X-GoGo-Invite-Context`. Browser proof uses the
`__Host-gogo_invite_ctx` Secure/HttpOnly/Path=/ cookie with SameSite=Lax, no Domain.
Browser JSON contains only expiry and a separately derived CSRF token. A second
Secure/host-only/SameSite=Lax cookie `__Host-gogo_invite_csrf` is JavaScript-readable
is retained only for compatibility and deprecated; it contains no bearer proof.
Web cannot read cookies on the API hostname; reload recovery uses response-body
delivery as specified below. The token
is HMAC bound to context ID; browser bootstrap and later CODE6 POSTs with cookie
proof require `X-GoGo-Invite-CSRF`. A browser cannot request mobile transport.

First bootstrap requires an exact HTTPS Origin from CORS_ORIGINS and browser
Sec-Fetch-Site `same-origin`/`same-site`, JSON, and UUID Idempotency-Key. These
are the concrete anti-CSRF bootstrap policy chosen within the approved shape;
legacy browsers missing Fetch Metadata fail closed. Cross-site deployments must
use a same-site BFF; weakening cookie flags is forbidden. CORS exposes Retry-After
and permits the two proof headers with credentials and exact origins only.

A dedicated managed INVITE_ATTEMPT_KEY (≥32 characters, randomly generated) derives
independent HKDF keys for replay AES-256-GCM, CSRF, bucket HMAC and replay scope.
An empty/unavailable key or schema/storage outage returns 503
INVITE_LOOKUP_UNAVAILABLE. No ephemeral key or memory fallback is used.
This key is separate from auth JWT, recovery, push Device and I03 invite keys.

Replay uses a dedicated table, AES-GCM authenticated by scope, transport and
concrete context ID. First bootstrap uses IP + random UUID in its own purpose;
proof-bearing requests bind the proof hash. Context + encrypted completion +
credential-free audit commit atomically. PostgreSQL advisory try-locks serialize
same-key requests; concurrent in-flight requests get 409 and Retry-After: 1.
Replay rechecks purpose, transport, expiry and revocation. Browser bootstrap
401 expires both context cookies, allowing an explicit fresh bootstrap; 403
does not clear cookies. Existing valid proof
always returns its original context/deadline, including with a new IP/key.
Client keys and IPs persist only as keyed digests. No plaintext proof or CSRF is
stored. Generic idempotency storage is bypassed. Browser replay sets the cookie
again; it never returns the proof in JSON.

Bootstrap flood limits use independent shared PostgreSQL buckets (10/IP/min,
30/prefix/min, 1000/global/min; IPv4 /24 and IPv6 /64). They are fixed windows
anchored at first request and never extended by rejected requests. Their purpose
is context-creation flood protection, separate from I06's rolling CODE6 ledger.
They count retries/reuse/rejections as requests. This trades a short serialized
transaction per bootstrap for multi-instance correctness without Redis fallback.
All buckets are charged in a separate transaction so a refusal cannot roll back
its charge. Retry-After is the latest blocking bucket's actual remaining TTL.

I08 must call validateForCredential after syntax/actor/flood validation and before
ticket, security-budget reservation or invite lookup. Missing/malformed/forged/
expired/revoked/wrong-purpose proof is 401 INVITE_CONTEXT_REQUIRED; CSRF is 403
CSRF_FAILED. Legacy or TOKEN128 bypasses this service before configuration or
storage access. Global AuthGuard and legacy room/session DTOs stay unchanged.
No credential or hash is sent to Tenjin. Proof cannot be put in URLs, logs,
analytics, cache keys, outbox events or response-error details. Telemetry uses
bounded operation/result only; the creation audit contains internal context ID
and transport, with no IP, proof or CSRF.

Migration 0106 creates three independent tables and expiry indexes after
0103 place aliases, 0104 invite foundation and 0105 room host transfer. Its
journal timestamp is strictly greater than 0105. ADR-0056 covers invite
foundation, ADR-0057 seed contributions and ADR-0058 host transfer; this
decision uses ADR-0059.
No old table is altered. Forward snapshot testing and real browser/DEV acceptance
remain required; sandbox unit checks do not establish them.

Rollback: unset INVITE_ATTEMPT_KEY to close bootstrap/proof validation with 503,
keep CODE6 off, retain the additive tables and key until replays have expired.
Keep the key stable across instances/restarts. Emergency replacement changes flood digest namespace and invalidates browser
CSRF/encrypted replay. Disable bootstrap and CODE6, revoke live contexts under
the audited ops procedure (key replacement alone does not revoke mobile proof),
wait ≥60 seconds, rotate, then clients discard old context and bootstrap with a
fresh UUID. Do not expose a reset that renews
CODE6 budget. A physical down migration is only for an isolated disposable DB
or after all consumers are retired: drop replays, buckets, then contexts. No
existing token/session data or 24h invite TTL is changed.

## 2026-11-13 F-01 supplement: response-body CSRF recovery

Additive OpenAPI 12.1.0-alpha.1 adds `POST /v1/invite-attempt-contexts/csrf`
(`recoverInviteAttemptCsrf`), public with NoIdempotencyReplay and explicit 200.
It requires application/json (optional charset), explicit empty object, exact
HTTPS CORS_ORIGINS match, Sec-Fetch-Site same-origin/same-site and browser cookie
proof. It ignores incidental stale invite-CSRF and any Idempotency-Key without
replay storage. Any proof header (even empty/mixed) is forbidden. No user auth,
mobile transport selector, credential/context ID/recovery parameter in URL.

Origin/metadata validation precedes configured crypto/shared bootstrap flood
buckets, cookie-only proof hashing and repo.findProof. Purpose, transport,
revocation and expiry use the existing validity rules/database clock. Return
exactly `{ expiresAt, csrfToken }` (original deadline, existing 64-lowercase-hex
HMAC), additionalProperties false, with no success Set-Cookie. Never call bootstrap
or add a general skip-CSRF flag. No migration/new secret: recovery creates,
rotates or renews nothing and performs no context/replay/audit/invite/ticket/I06
history writes. Only shared flood counters and bounded metrics may change.

Errors use the standard envelope: 400 VALIDATION_FAILED for missing/malformed
JSON, non-object/extra fields; 401 INVITE_CONTEXT_REQUIRED for missing/malformed/
forged/expired/revoked/wrong-purpose/wrong-transport cookie or forbidden proof
header; 403 CSRF_FAILED for Origin/metadata; 415 UNSUPPORTED_MEDIA_TYPE;
429 RATE_LIMITED with Retry-After; 503 INVITE_LOOKUP_UNAVAILABLE for unavailable
crypto/database/security dependencies. No recovery-specific 201/409/422.
After accepted Origin, 401 for unusable/missing cookie expires both cookies with
original attributes. Header/mixed rejection must preserve browser cookies;
403/429/503 preserve them. No automatic replacement. Early no-store covers both
paths, trailing slash variants, parser/guard/dependency errors. CORS retains exact
origins, credentials, Vary: Origin, exposed Retry-After and public 204 preflight;
unallowlisted origins receive no grant and are independently rejected by handler.

A malicious sibling is same-site, so SameSite alone is insufficient. Exact Origin,
Fetch Metadata and JSON-only POST/preflight secure token delivery. Deterministic
context-bound HMAC prevents token fixation and cross-context use without tabs
invalidating each other. Preserve the proof's __Host-/Secure/HttpOnly/Path=/,
no Domain, SameSite=Lax attributes against sibling cookie planting. Allowlisted
Web compromise is outside CSRF protection's trust boundary. A parent-domain
readable cookie expands sibling exposure; same-origin deployment needs routing
work. Response-body delivery is the selected bounded correction.

No-store on every response, NoIdempotencyReplay, no CDN/service-worker/persisted
query caching, and existing redaction prevent leakage. Recovery metrics use only
`result=recovered`; rejection telemetry adds bounded `operation=recover` and
existing error codes. Bootstrap payload/cookies and mobile/legacy remain compatible.
Only recovery may use browser proof without a prior invite-CSRF header;
proof-bearing bootstrap and CODE6 POSTs retain their checks.

### Client guide (normative)

Web uses the HTTPS same-site BFF with `credentials: 'include'`. Browser proof stays in the API’s Secure, HttpOnly, host-only `__Host-gogo_invite_ctx` cookie. JavaScript never receives or copies that proof.

Bootstrap returns `{ expiresAt, csrfToken }`. Keep `csrfToken` in memory. Web cannot read cookies belonging to the API hostname; do not use `document.cookie` for reload recovery.

On page load or when the in-memory token is missing, POST `{}` as `application/json` to `/v1/invite-attempt-contexts/csrf` with credentials included. No previous CSRF token or Idempotency-Key is required. A `200` returns the existing CSRF token and original context deadline; it does not renew the context.

Send that token as `X-GoGo-Invite-CSRF` on proof-bearing bootstrap and every CODE6 POST. User-session `X-GoGo-CSRF` remains separate where required.

On recovery `401`, discard the in-memory token; the BFF clears unusable invite cookies. Explicitly bootstrap with `BROWSER_COOKIE` and a fresh UUID Idempotency-Key. On `403`, stop and correct the origin/browser configuration; never switch to mobile transport. On `429`, honor Retry-After; on `503` or network failure, back off without discarding the context.

After a mutation’s `CSRF_FAILED`, allow one recovery and one retry using the original mutation body and Idempotency-Key. Stop if recovery or the retry fails; do not loop.

Never put proof, CSRF, invite codes or tickets in URLs, logs, analytics, Tenjin, persistent browser storage or persisted query caches. Exclude recovery responses from service-worker caching. Mobile continues using its existing header transport.

### Acceptance allocation

Owner decision 2026-11-13 in `dev/policy/decisions-log.md`: **no Playwright in
GoGo-BE**. Implement unit and Node Fastify-inject integration cases with real
Postgres in `apps/api/test/invite-attempt-contexts.int.spec.ts` here. Real-browser
reload acceptance moves to WebApp I11. Use Chromium, Firefox and WebKit with two
distinct trusted HTTPS same-site hosts, real API/database and browser security on.

1. Bootstrap via actual page-origin fetch; retain CSRF only in page memory.
2. Confirm Web document.cookie exposes neither API cookie and bootstrap JSON has no bearer proof.
3. Perform real page.reload(); confirm the memory token is gone.
4. POST recovery with credentials and `{}` from the reloaded page; browser supplies Cookie, Origin and Fetch Metadata.
5. Assert 200, original token/deadline, unchanged context count/identity, no success Set-Cookie.
6. Recovered CSRF permits proof-bearing bootstrap (201, original expiry); missing CSRF remains 403.
7. Unallowlisted sibling and cross-site attacker pages cannot read a token or alter/clear victim context.
8. Revoke, recover (readable 401 and cookie cleanup), then explicitly bootstrap a replacement.

No HTTP-client substitute or manually injected browser security headers. Disable
trace/HAR capture for credential-bearing requests. I05 proves POST protection
through bootstrap; real CODE6 endpoint acceptance remains I08. I11 browser
acceptance is still required; Node inject does not prove browser enforcement.
