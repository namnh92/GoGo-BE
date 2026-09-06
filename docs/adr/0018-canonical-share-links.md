# ADR-0018: Canonical share links — hashed slug, invite-as-slug, attribution behind a port

- **Status:** accepted (2026-09-06)
- **Date:** 2026-09-06
- **Deciders:** BE + Mobile + Infra
- **Implements** `GoGo-MVP-Tenjin-Deferred-Deep-Link.md` §3–§7, §13, §21–§25 for GoGo-BE (LNK-BE-001/002/003 — #204, #205, #206)
- **Related** GoGo-Infra#12 (edge Worker), GoGo-Infra#14 (Tenjin app/template), Mobile#56 (deferred link)

## Context

The product shares one kind of URL, `https://<share-host>/l/{slug}`, for a
room invite, a plan or a place (FR-LINK-001). The edge Worker in GoGo-Infra
already resolves a slug against `GET /v1/share-links/{slug}` and redirects; the
mobile parser already recognises `/l/{slug}`. What did not exist was the table
and the API behind them, and two decisions the spec leaves open:

1. **How a ROOM_INVITE link joins a room.** The client contract (spec §13) hands
   the app `{ type: 'ROOM_INVITE', inviteCode }`, and `POST /rooms/join` takes
   an invite code. `room_invites` stores codes hashed and shows the plaintext
   once, so a share link cannot look one up later.
2. **Where attribution lives.** Tenjin's click URL must carry the canonical link
   as `deeplink_url`, the Worker already composes one from its own template, and
   the spec says the tracking URL is stored on `share_links` and nowhere else.

## Options considered

**Invite handling**

1. Store the invite code in clear on `share_links` so resolve can return it.
   Undoes the hash on `room_invites` for every shared invite.
2. Encrypt the invite code at rest with a server key. More machinery; a DB read
   plus the key still yields every shared invite.
3. **The slug _is_ the invite code.** Minting a ROOM_INVITE link creates an
   invite whose code is the slug (same 128-bit base64url entropy). Resolve
   returns the slug back as `inviteCode`; the app joins through the existing
   door. Nothing is stored in clear.

**Slug storage**

Given 3, the slug is a credential and is stored as `slug_hash` (SHA-256) for
every type — one rule rather than a per-type exception. The URL is returned
once at creation; there is no "list my links" endpoint.

**Attribution**

1. Let the Worker keep composing the tracking URL from its own template.
   Two places own vendor knowledge; the row's `provider`/`provider_tracking_url`
   would be fiction.
2. **`AcquisitionLinkPort` in `@gogo/providers`, `TenjinAcquisitionLinkProvider`
   behind it, result stored on the row at mint time, returned by resolve.** The
   Worker should prefer the API's `trackingUrl` and keep its template only as a
   fallback (Infra#12 follow-up).

## Decision

- `share_links(slug_hash unique, type, target_id, invite_id, created_by_user_id,
provider, provider_tracking_url, source, medium, campaign, expires_at,
revoked_at)`; enum `share_link_type` carries the P1 values COLLECTION and
  REFERRAL so every consumer shares the vocabulary now, but the API refuses to
  issue them (`400 SHARE_LINK_TYPE_UNSUPPORTED`).
- `POST /v1/share-links` — host for ROOM_INVITE (via `RoomsService.createInvite`
  with the slug as code, so joinability and rate limits are the invite's), member
  for PLAN, any signed-in user for a published PLACE; guests refused.
- `GET /v1/share-links/{slug}` — public, `keyBy: ip`, generous limit (slugs carry
  128 bits; the limit is a flood guard). Answers type + target id + expiry +
  provider + trackingUrl. Never a user id, never the room behind an invite.
  404 for a slug nobody minted; 410 when revoked, expired, or the invite is
  spent — FR-LINK-002 "revoke takes effect immediately" is the row, and the
  edge TTLs of FR-LINK-005 bound how long a cached answer may lag.
- `DELETE /v1/share-links/{slug}` — creator, or the host of the room a
  ROOM_INVITE/PLAN points into; revokes the invite in the same transaction.
- `SHARE_LINK_BASE_URL` per environment (https origin only). Empty → mint
  answers 503 `SHARE_LINKS_UNAVAILABLE`, not retryable; resolve/revoke unaffected.
- `TENJIN_TRACKING_URL_TEMPLATE` per environment. Present → `provider: TENJIN`
  and the template with `deeplink_url=<canonical>`; absent → `NONE`. The
  adapter is string building; no Tenjin credential exists server-side, and the
  Infra manifest documents why. Any adapter error or a 2 s timeout falls back
  to `NONE` — attribution never blocks a share (FR-LINK-006). The vendor
  receives the canonical URL and nothing else; the adapter refuses a canonical
  URL carrying a query, fragment or credentials.
- Metrics: `share_link_created_total{type}`,
  `share_link_resolved_total{type,result}`,
  `share_link_attribution_total{result}`. Domain events
  (`share_link.created/resolved`) are LNK-BE-004 (#207).

## Consequences

- A ROOM_INVITE share link is an invite: it follows the invite TTL (7 days),
  `maxUses`, and the room's joinable states; revoking either revokes both.
- Changing attribution vendor touches the adapter, the template variable and
  two columns. Slugs, canonical URLs, `DeepLinkRouter` and joins do not move.
- The Worker composes a redirect target from its own template today and, with
  no template, redirects to the canonical URL itself — a loop for a browser.
  Both are Infra#12 follow-ups: prefer the API's `trackingUrl`, and fall back to
  the web landing page (LNK-WEB-001, WebApp — PENDING) or a store URL once one
  exists, never to `/l/{slug}` again.
- Mobile (Mobile#56, LNK-APP-002): resolve `shareSlug` through this endpoint,
  map `ROOM_INVITE → invite/{inviteCode}`, `PLAN → plan/{id}`, `PLACE →
place/{id}`; treat 404/410 as a "link no longer works" screen, not a crash;
  consume a deferred slug exactly once.

## Migration & rollback

- Migration `0044_share-links.sql` is additive; down path in the file header.
- Rollback: revert the API commits and drop the table — no other table
  references it; ROOM_INVITE links leave ordinary `room_invites` rows behind
  that expire on their own.
- Enabling per environment is two values: `SHARE_LINK_BASE_URL` (required to
  mint) and `TENJIN_TRACKING_URL_TEMPLATE` (optional). Staging/prod add rows to
  the GoGo-Infra manifest; no code changes.
