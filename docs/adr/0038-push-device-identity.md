# ADR-0038: Push identity for devices with no account

- **Status:** accepted
- **Date:** 2026-11-04
- **Deciders:** owner, SA (shape GoGo-MobileApp#398 rev 7), DEV
- **Extends:** ADR-0016, ADR-0017, ADR-0021, ADR-0025, ADR-0037 (part 1).

## Context

The owner's rule (2026-11-03): a signed-in user receives everything; a device with no
session receives GoGo-wide promotions; signing out returns to the second case. Under
Identity Verification a device with no session has no subscription at all, and M-3
(2026-11-03, both platforms) measured that `logout()` then `login('device:<id>', jwt)`
moves the one subscription and re-enables it.

## Options considered

1. **Decline the second case, docs only.** Rejected by the owner.
2. **Switch Identity Verification off.** Rejected: any holder of the app id could log in
   as any user id.
3. **Keep verification and give the device a BE-signed identity.** Chosen.

## Decision

**Identity.** `external_id = device:<uuid>`, minted by the BE. User paths refuse the
prefix, device paths build it only from a uuid, and the provider adapter refuses to
delete anything outside it.

**Two credentials.** The provider JWT carries today's claims and is never accepted by
GoGo's API. The device credential is `Authorization: Device <id>.<secret>`: 32 random
bytes returned once, stored as SHA-256, reaching only `POST …/identity/device/token`,
`PUT /notifications/device-subscriptions` and `DELETE …/identity/device`. A wrong secret,
an unknown id and a retired identity get one answer, 404 `PUSH_DEVICE_IDENTITY_GONE`.

**Ownership extends ADR-0037.** One table, one protocol. Lock order in every transaction
taking more than one: identity row(s) `for update`, in id order → fence → subscription
row. A device report re-checks `revoked_at` under that lock, so a request authenticated
before a retirement cannot land after it. A confirmed logout takes no identity lock: it
touches only a row its own user owns. A user taking a device-owned row retires that
identity in the same transaction, and a second device identity taking the row retires the
first, so a copied secret cannot go on renewing.

**Preference.** A higher `preferenceVersion` applies, the same one replays and reports the
provider afresh, a lower one answers 409 with the stored version. Null has never been
stated and is not in any audience, so the first report applies at any version. The
response's `providerEnabled` is the read made in that request; a client keeps an opt-out
open until the current version shows false (R-16).

**Audience `public`.** Accounts as `all`, plus identities that are live, said yes, and own
a live row. Estimate and send use the same two predicates. `all`, `couple`, `group` and
`platform` stay accounts only, and the outbox addresses a user id, so nothing but a
`public` dispatch can address a device.

**Dispatch.** Per device, inside the same run and after the accounts:
`campaign_device_sends` is claimed by `dedupe_key = <dispatch_key>:device:<id>`, the send
carries the derived idempotency key, `push_sent_at` follows acceptance. A thrown provider
error fails the campaign as today, and rescheduling replays the keys. `campaignOutcome`
takes both halves. The content freeze counts both ledgers. A device gets no inbox row.
A message id alongside `invalid_aliases` naming the target counts as `no_target` for
accounts too: M-3 measured that shape, and one target named invalid is nothing delivered.

**Flag.** `push.device_identity.enabled`, a per-environment `feature_flags` row, off with no
row (owner 2026-11-04; replaces the shape's env var). It can be thrown without a deploy.
Off: issuing, renewing and reporting answer 404 `PUSH_DEVICE_IDENTITY_DISABLED`, dispatch
skips devices, `GET /cms/campaigns/capabilities` says so. `DELETE` still works. **Production
needs a separate owner order** (Decree 13, shape Q8).

**Limits.** Creation: 5 a minute per IP like a login, and
`PUSH_DEVICE_IDENTITY_DAILY_CEILING` (20 000 in any 24 hours, owner 2026-11-04, no measured
source) across all callers. Past it: 429 and `push_device_identities_total{result=ceiling}`.

**Lifecycle.** A worker job every 5 minutes:

1. Expire: never confirmed within 7 days, or quiet for 90. Takes the row lock and re-checks,
   so a renewal either lands first and the job skips, or sees `revoked_at` and gets GONE.
2. Flag off: retire identities quiet for over an hour. Nothing can renew while it is off, so
   they hold no JWT the provider would still accept.
3. Provider cleanup: `DELETE /apps/{app}/users/by/external_id/device:<id>`, an hour after
   retirement so the last JWT has expired and the device has moved its subscription. Backs
   off from 5 minutes; after 8 attempts the row is `failed` and
   `push_device_cleanup_dead_lettered` counts it.
4. Delete: 30 days after retirement with cleanup done, the identity and its rows go (owner
   2026-11-04, so the 90-day promise to a person is true). The ledger keeps its counts with
   `device_id` null. Its dedupe key still holds the dead random id, which no longer links
   to anything.

## Consequences

- Who can create: anyone, by design; FR-USER-014 gains this exception. The worst a holder
  of a bogus identity gets is promotions.
- Logs carry reason codes only; never a device id with a subscription id.

Limits, stated rather than solved:

- **A credential proves a credential, not a device.**
- **Provider and database are never updated atomically** (ADR-0037). M-3: a provider
  `enabled=true` does not prove a live device (reinstall), so the device audience can
  overcount until expiry.
- **Two copies across a transition during a send** (device copy accepted, then user copy).
- **Withdrawal window.** An opt-out is effective at the provider when the SDK flushes it and
  at the BE when the report lands; a send between them may be delivered.
- **Provider cleanup of a device that never moved** deletes its subscription; the SDK makes
  a new one and the next report writes it.
- **The ceiling is a shared availability limit**, and per-IP creation limits are hard on
  carrier NAT. Both are the shape's choice.
- **The ceiling alert is not here.** The metric ships; the rule belongs in GoGo-Infra.
- **WAF:** the login rule set for these routes (shape D7) belongs in GoGo-Infra.

## Migration & rollback

Forward: `0078_push-device-identity.sql`, additive. The rollback baseline is the release
carrying ADR-0037, never an older binary (R-18):

1. Turn the flag off. Issuance stops, dispatch skips devices, clients discard credentials.
2. Let the worker drain: identities retire after an hour, provider cleanup follows. The
   JWTs have expired by then, and a `login` with one cannot recreate a BE identity because
   the row is what admits a device.
3. Cancel any scheduled `public` campaign; the baseline cannot resolve that audience and
   would fail it rather than send it.
4. Roll the binary back. Its `register()` takes over a device-owned row by writing a valid
   owner. It does not retire the identity, which is why the drain comes first.

The schema stays. Dropping it is the `Down` script, a separate decision with its own order;
it refuses while a device-owned row exists and leaves the enum value behind.
