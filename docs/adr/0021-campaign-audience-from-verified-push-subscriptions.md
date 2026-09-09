# ADR-0021: A campaign's audience comes from provider-verified push subscriptions, not from a device-token table

- **Status:** accepted (2026-09-09)
- **Date:** 2026-09-09
- **Deciders:** BE + Mobile
- **Implements** NTF-BE-011 (GoGo-BE#515), NTF-APP-008 (GoGo-MobileApp#171)
- **Extends** ADR-0016 (push addressed by user id, GoGo keeps no device tokens), ADR-0017 (push identity JWT)

## Context

Push campaigns created in the CMS on DEV reached no device. Campaign `AAA`
(`b04fa2bb-0ba5-4595-ae55-b1dcc2b162ad`, audience `platform: ios`) recorded
three recipients, zero provider-accepted messages, three failures — and a
terminal status of `sent`.

What the runtime actually did, on the deployed revision (`0437565`):

- the worker was alive and on the real provider — boot line
  `port=PUSH_PROVIDER mode=onesignal provider=onesignal ready=true`, heartbeat
  current;
- at `02:22:35–37Z` it made **three OneSignal requests, all HTTP 200**, then
  logged `campaigns dispatched {campaigns:1}`. Not 401/403: the credential was
  accepted;
- all three `notifications` rows for that dispatch kept `push_sent_at = null`
  and `push_message_id = null`. A 200 with an empty `id` is OneSignal's
  documented "accepted, nobody to deliver to", which `OneSignalPushAdapter`
  reports as no message and `CampaignDispatcher` counts as `no_target`.

So the provider was reachable, authorised, and had nothing to deliver to. The
question was who those three recipients were.

`campaign-audience.ts` gated every audience on
`exists (select 1 from device_tokens dt where dt.user_id = u.id)`, and took the
`platform` filter from `device_tokens.platform`. On DEV that table held exactly
three rows, all `contract-<timestamp>` tokens belonging to throwaway
`@gogo.test` accounts, written on three separate days by
`GoGo-MobileApp/src/shared/api/__tests__/contract.test.ts` — which signs up a
fresh account per run against DEV.

Nothing else had ever written to it. `PUT /me/device-tokens` shipped;
GoGo-MobileApp has a `registerDeviceToken` API wrapper and a
`useRegisterDeviceToken` hook; **no screen or flow calls either.** So the
predicate failed in both directions at once:

- every real user was excluded. Someone who has signed in and completed
  `OneSignal.login()` with a verified identity JWT holds a genuine subscription
  and no `device_tokens` row, so no campaign could ever select them;
- three accounts that had never opened the app were the entire audience.

The transactional path had already moved on. #193 took `device_tokens` out of
`OutboxDispatcher` under ADR-0016 and spec §26; the campaign path was the one
consumer left behind. This was not a regression in the campaign code — it was
the last place still asking the question the old design asked.

## Options considered

1. **Drop the reachability gate; target every matching user by `external_id`.**
   Purest reading of ADR-0016: GoGo names people, OneSignal owns devices. No new
   table, no drift, no mobile change. But it deletes the `platform` audience
   from a shipped contract and a shipped CMS screen — nothing else in GoGo knows
   a user's platform — and it turns `recipient_count`, the number an operator
   reads immediately before an action that cannot be recalled, into "accounts we
   asked about". A campaign that reaches four people out of eight hundred would
   report eight hundred.
2. **Ask the provider per recipient at send time.** Correct, and unusable: one
   `GET /users/by/external_id` per person, on both the estimate and the send.
3. **Record confirmed subscriptions in GoGo, verified against the provider on
   write.** Restores an honest audience and keeps `platform`, at the cost
   ADR-0016 named when it rejected mirroring device bookkeeping: two places
   holding a fact about the same devices.

## Decision

Option 3, with the drift ADR-0016 warned about bounded explicitly.

`push_subscriptions` records `(user_id, platform, subscription_id,
last_confirmed_at, revoked_at)`. What it is, and what it is deliberately not:

- **Not a routing table.** Nothing reads it to address a push. Sends remain
  `include_aliases.external_id = users.id`; OneSignal still owns the device
  list. Its only reader is `audiencePredicate`.
- **Not a token registry.** It holds no APNs or FCM token and never will (spec
  §26, WBS APP-008). `subscription_id` is OneSignal's own id for a device's push
  subscription — it addresses nothing at APNs or FCM, GoGo never sends to it,
  and the mobile client already hands the same id to
  `POST /notifications/identity/logout` (#160).
- **Not client-asserted.** `PUT /v1/me/push-subscriptions` verifies the claim
  before writing: the provider is asked, for the guard-resolved actor's own
  `external_id`, whether that subscription exists and is `enabled`. Without that
  check a client could name someone else's subscription id and move their row
  onto its own account — which would not steal their push (identity decides
  that) but would silently remove them from every campaign audience. "Not yours"
  and "yours but disabled" answer identically, so the route is not a probe for
  whether a subscription id exists.
- **Bounded against drift, in three ways.** A row is only written on a
  provider-confirmed registration. A row is revoked when a provider-confirmed
  logout proves the device is gone (#160's endpoint already asks exactly that
  question, and now records the answer). And a row that has gone stale anyway
  shows up as a counted `no_target` failure in the campaign's own numbers — it
  can make an audience too large, never a send falsely successful. Under
  NTF-BE-012 (#516) that also stops the campaign from claiming it was sent.

The client reports only after the ordered flow already in place completes:
session → JWT login → **confirmed identity** → OS permission → opt-in → report.
An unconfirmed device is not reachable and must not be recorded as such.
`allowUnverified` stays off; nothing here weakens Identity Verification.

`PUT /me/device-tokens` is removed (contract `1.0.0-alpha.19`). It was already
`deprecated: true`, no client called it, and leaving a write endpoint for a
registry that routes nothing is a control that looks operable and is not
(`.claude/rules/core.md` rule 16). The `device_tokens` table stays for now,
still cleared on account deletion; a separate migration drops it.

## Consequences

- The `platform` audience keeps working and now means what it says.
- `recipient_count` and the pre-send estimate count people the provider has
  confirmed can be reached. They can still be an over-count — someone can
  uninstall — and the delivery counters are what reconcile that.
- One extra provider call per registration. Registrations happen on login and
  account switch, not per request; rate-limited to 30/min per actor.
- Account deletion deletes `push_subscriptions` rows explicitly: deletion is a
  soft delete, so the `ON DELETE CASCADE` on `users` never fires.
- **No campaign audience exists until clients report.** Between this landing and
  GoGo-MobileApp#171 shipping, every campaign has an empty audience — which
  under #516 completes as `failed / EMPTY_AUDIENCE` rather than as a silent
  `sent`. That is the honest state, and it is visible.
- Stale `device_tokens` rows are inert; the three DEV rows stop being an
  audience the moment this deploys.

## Migration / rollback

Forward: `0058_push-subscriptions.sql` creates one table and two indexes. No
backfill is possible or wanted — every existing `device_tokens` row is either a
contract-test artefact or unverifiable, and backfilling would re-create the bug
with a new table name.

Rollback: `DROP TABLE push_subscriptions` and revert the predicate. The audience
returns to `device_tokens`, i.e. to reaching nobody real; rolling back is only
appropriate together with reverting the campaign feature itself.
