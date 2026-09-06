# ADR-0016: Push goes through OneSignal, addressed by user id — GoGo keeps no device tokens

- **Status:** accepted (2026-09-05)
- **Date:** 2026-09-05
- **Deciders:** BE + Mobile + Infra
- **Implements** `GoGo-OneSignal-Implementation-Spec.md` §22–§32, §44, §46–§48 for GoGo-BE (NTF-BE-002, #193)
- **Extends** ADR-0004 (provider adapters and resilience), ADR-0012 (provider accounting)

## Context

Notification fan-out existed before this change (#59): `outbox_events` →
`OutboxDispatcher` in the worker → `notifications` rows for the Notification
Center → a `PushPort.send(deviceToken, payload)` per row in `device_tokens`.
The port was bound to `FakePush` everywhere, so nothing was ever delivered, and
the slot reserved for it (`FCM_SERVICE_ACCOUNT_B64`, `APNS_*`) described a path
the product had already abandoned: the spec routes **BE → OneSignal REST →
APNs/FCM**, with the APNs `.p8` and FCM V1 credentials held by the OneSignal
app (GoGo-Infra#13, DEV configured) and never by GoGo-BE.

That leaves two designs that do not fit together. The pipeline is keyed on
device tokens; OneSignal is keyed on people (`external_id` alias = `users.id`)
and owns the device list itself (spec §26). The question is where the seam goes.

DEV is mini-production: identical code and validation in every environment,
future environments supplied with values only.

## Options considered

1. **Keep the token-based port; adapter maps token → OneSignal subscription id.**
   Pros: no dispatcher change. Cons: keeps the APNs/FCM registry the spec forbids,
   needs the mobile app to fetch and upload a subscription id it does not own,
   and duplicates OneSignal's device bookkeeping in our schema — two sources of
   truth for "which devices does this person have", guaranteed to drift.
2. **User-targeted port; dispatchers send once per event to a set of user ids;
   OneSignal adapter behind it.** Pros: matches the spec's provider interface,
   removes the token loop, one provider call per event, retry becomes safe via
   the provider's idempotency key. Cons: touches both dispatchers and every
   test that counted per-device sends.
3. **New parallel `notification_outbox` pipeline per spec §28 alongside the
   existing one.** Pros: literal spec shape. Cons: two outboxes, two dispatchers,
   two dedupe schemes for one product — the duplication the backlog review of
   2026-09-05 explicitly warned against. The spec's per-recipient outbox is a
   delta for NTF-BE-001/003/004 (#192/#194/#195) to apply _to_ this pipeline,
   not a second pipeline.

## Decision

Option 2.

- `NotificationProviderPort { sendToUser, sendToUsers }` replaces `PushPort`.
  A `UserNotification` carries `headings`/`contents` per locale (`en` required by
  the provider), a `data` map of routing facts, and an `idempotencyKey`.
  `PUSH_PROVIDER` is the DI token, unchanged.
- `OneSignalPushAdapter` is the only code that knows OneSignal. `POST
https://api.onesignal.com/notifications?c=push`, `Authorization: Key <App API
key>`, `include_aliases.external_id`, `target_channel: push`, chunked at 2,000
  ids. It runs under `withResilience('onesignal.push')` — timeout, jittered
  retry, breaker — so its state shows up in the same breaker snapshots the ops
  health view already reads. Failure classes are the ones the rest of the
  provider layer uses: `ProviderUnavailableError` (transient, retry),
  `ProviderConfigurationError` (401/403, do not retry),
  `ProviderInvalidRequestError` (400, do not retry).
- `OutboxDispatcher` writes the `notifications` rows (idempotent on the event
  id), then makes **one** provider call for every opted-in member with the
  event id as the provider idempotency key. Transient failure → the event is
  backed off and retried, and the retry is a replay at the provider, not a
  second push. Permanent failure → counted, the in-app row stands, the event
  publishes. `CampaignDispatcher` sends per recipient with the campaign dedupe
  key hashed into a UUID; a thrown provider error fails the campaign visibly, as
  an audience-resolution outage already did.
- Mode, not credential presence, decides the binding — the #279 rule.
  `PUSH_PROVIDER_MODE` unset follows the build: `NODE_ENV=production` (every
  deployed environment, DEV included) → `onesignal`; a workstation and the test
  suite → `fake`. `onesignal` with a missing or malformed value binds
  `UnconfiguredPushProvider`, which refuses every send with a counted
  configuration fault, and boot logs `push provider NOT ready` — it never binds
  the fake. API and worker resolve this from their own copy of the env and log
  the same line. Boot is not refused: push is an asynchronous dependency and a
  worker that will not start over it also stops imports and privacy jobs (spec
  §48).
- `device_tokens` and `PUT /me/device-tokens` stay, deprecated in the contract.
  Nothing on the delivery path reads them. Removing the table and route is a
  separate, announced change once the mobile client binds identity through the
  SDK (NTF-APP-004).
- Copy on the lock screen is a placeholder (`GoGo` / the kind key) until the
  template layer (NTF-BE-005, #196) lands. It must land before any client logs
  users into OneSignal (Mobile#51) — until then no `external_id` is subscribed
  and no user can receive the placeholder.
- Secrets: `ONESIGNAL_REST_API_KEY` from SSM `onesignal/rest-api-key`, rendered
  by GoGo-Infra into the runtime env; `ONESIGNAL_APP_ID` is public. Neither is
  logged; the adapter never interpolates the key into an error or a metric.

### Review amendments (2026-09-06)

- **Delivery progress is its own fact.** `notifications.push_sent_at` /
  `push_message_id` (migration `0048_notification-push-delivery`) record that the provider created a
  message for that recipient. The campaign dispatcher inserts the inbox row,
  then skips recipients whose row is marked delivered and sends to the rest.
  Rescheduling a campaign that _failed_ mid-send keeps its `dispatch_key`, so
  the retry reaches only the recipients still owed a push; cancel-then-schedule
  still mints a new key and is the deliberate re-send. Before this, a reschedule
  after an outage pushed everyone who had already been reached a second time and
  never retried the recipient the outage hit.
- **A delivered campaign's message is frozen.** Resuming under the old key
  fixed the duplicates but opened a second hole: `failed` is editable, so the
  copy could be changed and the resumed send would deliver the new text to the
  remainder only, leaving half the audience on each version. Once a campaign has
  any recipient with `push_sent_at` set, `update` refuses `title`, `body`,
  `imageKey`, `ctaLabel`, audience and destination with 409
  `CAMPAIGN_ALREADY_DELIVERED` — whatever its status, because status cannot
  express "failed having reached half of them". Cancelling first is not an
  escape hatch: that path would deliver a second, different message to the
  people already reached. The editorial `name` stays editable (no recipient
  sees it), an unchanged retry stays allowed, and new copy means a new campaign.
- **"Sent" means a message was created.** `PushSendResult` now carries every
  provider message id and the number of requests the provider accepted with
  nobody subscribed (`id: ""`). The outbox counts `push_delivery_sent_total` per
  created message and `push_delivery_no_target_total` per empty response; a
  chunked send can be partly accepted and is counted as such.

## Consequences

- Real delivery is one deploy away in every environment that holds the two
  values. DEV holds them; staging/prod are values, not code.
- Two `.env` slots (`FCM_*`, `APNS_*`) are dead config from the abandoned path
  and can be removed separately.
- Tests that counted "one push per device" now count "one call per event" /
  "one send per recipient". `FakePush.sent` is one entry per provider call.
- New metrics: `push_delivery_sent_total`, `push_delivery_unknown_user_total`,
  `push_delivery_failed_total` (re-scoped to permanent refusals),
  `push_provider_requests_total{status}`,
  `push_provider_request_duration_seconds{status}`. Transient outages are
  visible as `outbox_event_retry_total` and on the `onesignal.push` breaker.
- What this does **not** deliver: identity JWTs (#199), per-recipient outbox
  rows and the spec's retry schedule (#192/#194/#195), templates (#196),
  domain-event catalog (#200), observability wiring (#201), and — on the
  client — SDK login/logout, permission UX, click routing (Mobile#49–#52). A
  push is not verified end-to-end until a signed device subscribes and a
  targeted send is received; nothing in this ADR claims that.

## Migration & rollback

- Adopt: deploy. `render-env.sh` already renders `ONESIGNAL_APP_ID` and
  `ONESIGNAL_REST_API_KEY` for `dev`/`prod`; add `staging` to those manifest
  rows before a staging environment exists (GoGo-Infra#13).
- Verify per environment, identically: boot log shows `push provider ready`
  with `provider: onesignal`; `push_provider_requests_total{status="200"}`
  rises after a domain event with an opted-in member; a test device subscribed
  under a real `external_id` receives it.
- Rollback: set `PUSH_PROVIDER_MODE=fake` in the environment and restart the
  worker — sends are recorded and reach nobody, Notification Center rows keep
  being written. Reverting the commit is also safe: no migration, no schema
  change, no data written that a previous build cannot read.
