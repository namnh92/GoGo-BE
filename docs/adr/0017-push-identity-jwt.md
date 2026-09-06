# ADR-0017: OneSignal identity JWT — signed server-side, unavailable rather than permissive

- **Status:** accepted (2026-09-06)
- **Date:** 2026-09-06
- **Deciders:** BE + Mobile + Infra
- **Implements** `GoGo-OneSignal-Implementation-Spec.md` §9–§14 for GoGo-BE (NTF-BE-008, #199)
- **Extends** ADR-0016 (push provider)

## Context

Named-user push (ADR-0016) targets `external_id = users.id`. Without Identity
Verification any client can call `OneSignal.login("<someone else's id>")` and
receive that person's pushes. OneSignal's remedy is a JWT the app's backend
signs and the SDK presents at login; production must enforce it (spec §11).

Facts checked against the provider documentation on 2026-09-05/06:

- Algorithm ES256. Claims `iss` (app id), `exp`, `identity.external_id`. No
  `kid`. The private key is issued by OneSignal (Settings → Keys & IDs →
  Identity Verification) as a PEM; GoGo does not generate it, and the App API
  key is not a substitute.
- Native SDKs (iOS ≥ 5.3.0, Android ≥ 5.9.0) accept the JWT at login. The
  React Native wrapper installed on Mobile (5.5.9) exposes `login(externalId)`
  only; wrapper support is documented as pending.
- DEV SSM holds no identity signing key (GoGo-Infra manifest: `required: [prod]`).

## Options considered

1. **Wait for the wrapper and the key; ship nothing.** Blocks Mobile#51 on two
   external events with no server contract to build against.
2. **Ship the endpoint now; refuse when the key is absent.** Same code in every
   environment; DEV answers 503 until Infra supplies the key; enforcement in the
   OneSignal dashboard is switched on only after the client presents tokens.
3. **Ship the endpoint and, absent the provider key, sign with a GoGo-generated
   key.** The provider would not trust it — tokens that verify nowhere, a green
   checklist guarding nothing.

## Decision

Option 2.

- `GET /v1/notifications/identity` (authenticated, user actors only). Returns
  `{ externalId, token, expiresAt }`. The user id comes from the resolved actor;
  no query, header or body field is read. Rate-limited per actor.
- `PushIdentityService` signs with `fast-jwt` (already a dependency) — ES256,
  `iss` = `ONESIGNAL_APP_ID`, `expiresIn` = `ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS`
  (default and maximum 3600, minimum 60), `iat` stamped by the signer. The
  response's `expiresAt` is read back from the token's `exp`, so what the client
  refreshes on is what the provider checks.
- `ONESIGNAL_IDENTITY_VERIFICATION_KEY` accepts the PEM raw, with `\n`-escaped
  newlines, or base64-encoded — SSM stores one string and `render-env.sh` writes
  one line. `loadEnv` parses it at boot and refuses anything that is not an EC
  P-256 private key. Empty is a valid state: `available = false`, the endpoint
  answers 503 `PUSH_IDENTITY_UNAVAILABLE` with `retryable: false`, and boot logs
  `push identity signing NOT configured`. Never permissive, never a local key.
- Clock skew: tokens carry `iat` and a ≤1 h `exp`; the client refreshes before
  `expiresAt` and on the SDK's invalidation callback. No `nbf` is set, so a
  device a few seconds ahead of the server does not reject a fresh token.
- Rotation: replace the SSM value, redeploy. Outstanding tokens are at most an
  hour old; the provider accepts the new key immediately for new tokens. Nothing
  else changes.
- Logging: the service logs nothing; the token appears only in the response
  body. The metric `push_identity_tokens_total{result}` counts issued and
  unavailable.

## Consequences

- Mobile#51 has a server contract to implement against. It still cannot pass
  the JWT through the installed wrapper; that needs either a wrapper release
  with JWT login or a native bridge, and is recorded on Mobile#51 — not worked
  around by calling `login(externalId)` unverified.
- Identity Verification enforcement in the OneSignal dashboard must stay **off**
  until the client sends tokens; switching it on first silently unsubscribes
  every named user. That order is an Infra#13 acceptance step.
- Staging/prod need the key rendered (`required: [prod]` today; add `staging`
  when that environment exists).

## Migration & rollback

- Adopt: put the provider-issued key in SSM `onesignal/identity-verification-key`
  for each environment, redeploy the API, confirm the boot line and a 200 from
  the endpoint with a real session. Enable enforcement in the dashboard last.
- Rollback: remove the key from the environment and redeploy — the endpoint
  returns 503, nothing else changes. Reverting the commit is also safe: no
  schema, no data.
