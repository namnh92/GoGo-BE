# Invite-attempt context lifecycle and client guide

Refs #891 / #861 I05. OpenAPI `12.3.0-alpha.1` is the source contract.
`POST /v1/invite-attempt-contexts` is public and does not enable CODE6.

Mobile sends `{ "transport": "MOBILE_HEADER" }`, a fresh UUID Idempotency-Key,
and no Origin. It receives `201 { expiresAt, contextToken }`. Persist proof only
in Keychain/Keystore; keep the key through a lost-response retry. Later send
`X-GoGo-Invite-Context`; user bearer Authorization remains independent. Never use
push `Authorization: Device`, localStorage, URLs, analytics, query/mutation cache
keys or crash breadcrumbs for this material.

Web uses the HTTPS same-site BFF with `credentials: 'include'`. Browser proof stays in the API’s Secure, HttpOnly, host-only `__Host-gogo_invite_ctx` cookie. JavaScript never receives or copies that proof.

Bootstrap returns `{ expiresAt, csrfToken }`. Keep `csrfToken` in memory. Web cannot read cookies belonging to the API hostname; do not use `document.cookie` for reload recovery.

On page load or when the in-memory token is missing, POST `{}` as `application/json` to `/v1/invite-attempt-contexts/csrf` with credentials included. No previous CSRF token or Idempotency-Key is required. A `200` returns the existing CSRF token and original context deadline; it does not renew the context.

Send that token as `X-GoGo-Invite-CSRF` on proof-bearing bootstrap and every CODE6 POST. User-session `X-GoGo-CSRF` remains separate where required.

On recovery `401`, discard the in-memory token; the BFF clears unusable invite cookies. Explicitly bootstrap with `BROWSER_COOKIE` and a fresh UUID Idempotency-Key. On `403`, stop and correct the origin/browser configuration; never switch to mobile transport. On `429`, honor Retry-After; on `503` or network failure, back off without discarding the context.

After a mutation’s `CSRF_FAILED`, allow one recovery and one retry using the original mutation body and Idempotency-Key. Stop if recovery or the retry fails; do not loop.

Never put proof, CSRF, invite codes or tickets in URLs, logs, analytics, Tenjin, persistent browser storage or persisted query caches. Exclude recovery responses from service-worker caching. Mobile continues using its existing header transport.

The host-only `__Host-gogo_invite_csrf` cookie remains for compatibility but is
deprecated and unnecessary for recovery. Never broaden its Domain. Supported
browsers must supply Sec-Fetch-Site `same-origin` or `same-site`; only exact
configured HTTPS Origins are accepted. SameSite/Secure are never relaxed.

Both transports use fixed 48h TTL, not rolling expiry. Re-bootstrap with valid
proof and any new UUID returns the same context and deadline; neither login nor
IP change resets it. On a lost initial response, retry the exact initial
transport/key from the same IP. Initial replay is IP-scoped; switching network
may create another context under the shared creation quotas. An invalid supplied
proof gets 401, never automatic replacement. On expiry/revocation the client
clears its old proof (BFF expires unusable browser cookies on bootstrap 401), then explicitly starts
a new context with a fresh UUID. A context is not permission to join a room.
Invite links still expire after 24h; CODE6 generations and tickets have their
own shorter deadlines and cannot be renewed by bootstrap.

Only CODE6 will require device proof and preview ticket. TOKEN128 and omitted
discriminator clients keep preview, user/guest join and `/sessions/guest` working
with every new field, header, cookie and ticket omitted. I05 does not change the
existing room DTOs or publish incomplete CODE6 operations. I08 consumes the
exported `InviteAttemptService.validateForCredential` and presentation request
adapter after syntax/actor/flood checks, before ticket, budget or invite lookup.
I06 must key device history by internal context ID; bootstrap does not reset or
refund that history. Global risk remains ≤1%/rolling 48h and CODE6 fail-closed/off.

| Status / code                                   | Client action                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 400 INVALID_IDEMPOTENCY_KEY / VALIDATION_FAILED | Correct UUID/body; no credential in error details.                                             |
| 401 INVITE_CONTEXT_REQUIRED                     | Missing, forged, expired, revoked, wrong-purpose or wrong-transport proof; no invite lookup.   |
| 403 CSRF_FAILED                                 | Correct Origin/fetch metadata and context CSRF; do not retry through mobile transport.         |
| 409 IDEMPOTENCY_IN_PROGRESS                     | Honor Retry-After, retry same request/key.                                                     |
| 422 IDEMPOTENCY_KEY_REUSED                      | Same initial IP/key used with another transport; use the original request.                     |
| 429 RATE_LIMITED                                | Honor Retry-After (also CORS exposed); no context minted.                                      |
| 503 INVITE_LOOKUP_UNAVAILABLE                   | Dependency/config/schema unavailable; no anonymous fallback. Retry/backoff and keep CODE6 off. |

All bootstrap and recovery responses, including validation/CSRF/dependency errors, carry
Cache-Control: no-store. Default Fastify body/header flood limits apply before
business processing; bootstrap takes a strict one-field object; recovery requires explicit `{}` JSON
(optional charset), rejecting extra fields/non-objects with 400 VALIDATION_FAILED
and non-JSON media with 415 UNSUPPORTED_MEDIA_TYPE. CORS permits
only configured exact origins with credentials, permits the two invite headers,
and exposes Retry-After. No proof/credential goes to Tenjin or another provider.

Operators provision INVITE_ATTEMPT_KEY via the secret manager (random ≥32-char
secret, stable across API instances), run migration 0106, configure HTTPS
CORS_ORIGINS on the same site, and verify cookie/CORS plus the DEV suite below.
Missing key/table fails closed; no startup auto-issuance or key generation.
An empty default leaves bootstrap unavailable until provisioned. CODE6 remains
off independently of provisioning this endpoint. See ADR-0059 for key rotation.

Metrics: `invite_context_bootstrap_total{operation=bootstrap,result=created_or_replayed|reused}`
and `invite_context_recovery_total{result=recovered}` plus
`invite_context_rejection_total{operation=bootstrap|validate|recover,result=<bounded error code>}`.
Alert on sustained INVITE_LOOKUP_UNAVAILABLE and unexpected CSRF/401/429 growth.
No metric label contains room/device/context ID, host alias, IP, proof or hash.
The audit action `invite_context.created` records only context ID and transport.

Expiry/revocation is checked synchronously using database time, even if cleanup
is delayed. Expiry indexes support bounded cleanup; run maintenance under the
normal ops policy, deleting replay rows before contexts and only after expiry.
Example batch (repeat in separate short transactions until empty):

```sql
DELETE FROM invite_attempt_replays WHERE key IN
  (SELECT key FROM invite_attempt_replays WHERE expires_at <= now() LIMIT 1000);
DELETE FROM invite_attempt_contexts WHERE id IN
  (SELECT c.id FROM invite_attempt_contexts c WHERE c.expires_at <= now()
   AND NOT EXISTS (SELECT 1 FROM invite_attempt_replays r WHERE r.context_id = c.id)
   LIMIT 1000);
DELETE FROM invite_bootstrap_buckets WHERE key IN
  (SELECT key FROM invite_bootstrap_buckets WHERE expires_at <= now() LIMIT 1000);
```

Do not delete live records or reset future I06 security history as cleanup.
No account/room PII is stored in these tables. An operator revokes a context by
setting its revoked_at under the existing audited ops procedure; there is no
public revoke endpoint in I05.

DEV verification, from this worktree with the normal Node/pnpm dependencies and
Docker available (Testcontainers creates an isolated PostGIS DB, not the shared
DEV database):

```sh
pnpm test:integration apps/api/test/invite-attempt-contexts.int.spec.ts
```

For legacy regression also run:

```sh
pnpm test:integration apps/api/test/rooms.int.spec.ts apps/api/test/auth.int.spec.ts
```

Run a forward migration on a masked DEV snapshot using the normal DB migration
procedure (`DATABASE_URL=<isolated-snapshot-url> pnpm db:migrate`), verify the
48h TTL constraints and indexes, then exercise real HTTPS browser and mobile
transports on the deployed build. No sandbox result constitutes DEV acceptance,
CODEOWNER approval, I03/I06/I08 completion or parent activation evidence.

Recovery is the only narrow exception to the prior invite-CSRF header requirement.
It runs Origin/Fetch Metadata checks before proof lookup/cleanup, then configured
crypto and the same bootstrap flood buckets (10/IP/min, 30/prefix/min,
1000/global/min). It rejects any proof header, including empty/mixed headers,
without clearing a valid browser cookie. An accepted-origin missing/unusable
cookie returns 401 and expires both cookies using their original attributes.
403/429/503 never clear cookies. No context/replay writes, issuance audit, expiry
updates, invite lookup, tickets or I06 budget/history changes occur; only flood
counters and bounded telemetry change. Recovery has no 201/409/422 response.

A malicious sibling remains same-site: SameSite alone is insufficient. Exact
Origin authorization, Fetch Metadata and JSON preflight protect response delivery;
the handler independently enforces Origin rather than relying on CORS. A caller
cannot choose a context/token: context A's HMAC fails with B's proof, and concurrent
tabs recover the same token. Preserve Secure/HttpOnly/host-only/Path=/ `__Host-`
proof attributes to prevent parent-domain cookie planting. An allowlisted Web
origin is a trusted execution boundary; compromise there permits authorized
browser requests. A parent-domain readable cookie broadens sibling exposure;
same-origin deployment requires routing changes. Neither is needed here.

Owner decision 2026-11-13 (`dev/policy/decisions-log.md`): no Playwright in GoGo-BE.
Node unit and real-Postgres Fastify-inject cases live here. Real-browser reload
acceptance belongs to **I11 GoGo-WebApp**, with Chromium, Firefox and WebKit,
two distinct trusted HTTPS hosts on the same site (`web.gogo.test` and
`api.gogo.test`), the real API/database, and browser security enabled:

1. Bootstrap from the Web page using actual browser fetch; retain CSRF only in page memory.
2. Confirm Web document.cookie exposes neither API cookie and bootstrap JSON contains no bearer proof.
3. Perform a real page.reload(); confirm the memory token is gone.
4. From the reloaded page POST recovery with credentials and `{}`; let the browser supply Cookie, Origin and Fetch Metadata.
5. Assert 200, original token/expiry, unchanged context count/identity and no success Set-Cookie.
6. Use recovered CSRF on proof-bearing bootstrap: expect 201 and original expiry; missing CSRF still produces 403.
7. Repeat from an unallowlisted sibling and a cross-site attacker page: neither can read a token or alter/clear the victim context.
8. Revoke context and recover: readable 401, cookie cleanup, then a separate explicit bootstrap creates the replacement.

Do not substitute an HTTP request client or manually injected security headers
for page-origin fetches. Keep trace/HAR capture off for credential-bearing traffic.
I05 proves POST protection through bootstrap; real CODE6 endpoint acceptance
remains an I08 gate. Sandbox checks do not establish I11 acceptance.
