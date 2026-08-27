# ADR-0003: Authentication & authorization model

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** FR-AUTH-001..005, BE-BFF-002, DB-003, `.claude/rules/security.md`

## Context

Three actor classes hit the same API: registered users, room-scoped guests, CMS staff. Security rules demand short-lived access tokens, rotating hashed refresh tokens with a revoke chain, room-scoped guest sessions with claim flow, HttpOnly cookies on web, policy-based authorization, and per-action rate limits.

## Decision

### Tokens

1. **Access token:** JWT (HS256, `AUTH_JWT_SECRET`, ≤15 min TTL). Claims: `sub` (actor id), `act` (`user` | `guest`), `sid` (session id), `room` (guest only — the single room the token can touch), `iat`, `exp`, `jti`. No PII in claims.
2. **Refresh token:** 256-bit random opaque value, stored **SHA-256-hashed** server-side with `family_id` rotation chain. Each use rotates; presenting a superseded token **revokes the whole family** (theft detection). TTL 30 days idle.
3. **Guest session:** own table, scoped to exactly one room, expiring (`AUTH_GUEST_SESSION_TTL_SECONDS`). Guest access tokens carry `act=guest` + `room`; policies reject any resource outside that room. Claim flow: on registration with valid guest access token, guest memberships/votes/preferences re-parent to the new user in one transaction and the guest session is closed.
4. **Transport:** Web — access+refresh in `HttpOnly; Secure; SameSite=Lax` cookies (signed), CSRF protected via double-submit token on mutations. Mobile — tokens in body, stored in Keychain/Keystore client-side. Tokens never in URLs or logs.
5. **Password hashing:** argon2id (memory 19 MiB, iterations 2, parallelism 1 — OWASP baseline). Login is enumeration-safe: identical error + timing-safe compare against a dummy hash when the account does not exist.

### Authorization

6. **Policy layer** (`presentation/policies`): every protected handler declares a policy evaluated against `(actor, membership, role, resource state)` loaded server-side — client-sent role/room fields are never trusted. Deny by default; `host`-only actions verified against the `room_members` row, not the token.
7. **Rate limits** (Redis, per key): login 5/min/IP+account, guest session create 10/min/IP, room join 10/min/IP, invite lookup 20/min/IP, suggestion 6/min/room, report 5/min/actor. 429 returns the standard envelope with `retryable: true`.

## Consequences

- Single verification path for user and guest tokens; guests are constitutionally incapable of cross-room access.
- Hashed refresh tokens mean a DB leak exposes no usable credentials; family revoke bounds replay damage.

## Rollback / evolution

HS256 → asymmetric (EdDSA + JWKS) when a second first-party verifier appears; claim names stay stable so clients are unaffected.
