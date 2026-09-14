# ADR-0025: One application-level push switch per account

- **Status:** proposed (2026-09-14)
- **Date:** 2026-09-14
- **Deciders:** BE + Mobile + product owner
- **Implements** NTF-BE-014 (GoGo-BE#572); consumer NTF-APP-010 (GoGo-MobileApp#215)
- **Extends** ADR-0016 (push addressed by user id), ADR-0021 (campaign audience)

## Context

Device feedback on 2026-09-10 (U11): people want to turn notifications on or
off as a whole, not per kind. Today `notification_preferences` holds one row
per `(user, channel, kind)` and absent means enabled. The outbox reads the
push row for the event's kind; the campaign audience reads the `campaign` kind.
Mobile shows twelve toggles (six kinds × push/email) although nothing sends
email.

Three facts are routinely conflated and must stay apart:

1. the **app preference** — what the account asked GoGo to do (server);
2. the **OS permission** — whether this device lets GoGo notify (device only);
3. a **registered subscription** — whether the provider can reach a device
   (`push_subscriptions`, ADR-0021), and beyond that, **delivery**, which only
   the provider observes.

## Options considered

1. **Keep per-kind rows; the client writes all kinds at once.** No schema
   change, but "on" is then a UI convention: any row an older client leaves at
   `false` silently keeps a kind off after the person turned everything on.
2. **A single `push_enabled` column on `users`.** Simple, but the identity row
   is the wrong home for a notification fact and cannot record how the value
   came to be.
3. **A `notification_settings` row per account that alone decides push once it
   exists.** Chosen.

## Decision

`notification_settings(user_id, push_enabled, source, updated_at)`.

- `GET/PUT /v1/me/notification-settings` read and write `{ pushEnabled }`.
  `true` allows every push kind GoGo sends, campaigns included; `false` stops
  all of them. The in-app inbox is written either way.
- **One predicate** (`pushAllowed`) is used by the transactional outbox, the
  campaign estimate and the campaign send: the row's `push_enabled` when a row
  exists; otherwise on unless the account holds a push-channel per-kind opt-out.
- **Hidden per-kind rows never override an explicit switch.** Once a row exists,
  per-kind push rows are ignored for delivery. They are kept, not deleted, so a
  rollback reads exactly what it read before.
- **Older clients** (`PUT /me/notification-preferences`): the row is stored as
  before; `enabled: false` on push also sets the switch off (`source: legacy`),
  because a single kind can no longer be stopped on its own and the request
  must be honoured conservatively. `enabled: true` never turns push back on.
  `GET /me/notification-preferences` reports every push kind as the switch's
  value, so an older screen does not show a kind as on while nothing is pushed.
- The contract carries no field for OS permission, subscription or delivery.
- Export includes `{ pushEnabled, source }`; account deletion removes the row.

### Proposal needing product confirmation

- **Campaigns follow the switch.** SRS FR-USER-008 asks for a separate
  `marketing` preference, default off. Develop never implemented that: a
  campaign reaches everyone without a `campaign` opt-out. This ADR keeps that
  default and puts campaigns under the one switch, as the feedback asked for
  one switch covering everything. A separate marketing consent, if wanted, is a
  follow-up decision, not something this change settles.
- **A mixed legacy choice becomes off.** Someone who turned off only one kind
  stops receiving every push until they turn the switch on. This loses wanted
  notifications for some people; it never sends one somebody asked not to get.

## Consequences

- Mobile replaces twelve toggles with one switch and keeps OS permission as a
  separate, device-read state (NTF-APP-010).
- Per-kind delivery control is gone from the product. Reintroducing it needs a
  new decision; the stored rows alone would not be a correct basis.
- The email channel is untouched: its rows are stored and returned as before,
  and nothing sends email.

## Migration & rollback

Migration `0064_notification-master-switch` (journal `when` 1790467200000)
creates the table and backfills, conservatively:

| Stored push rows for the account       | Row written                        |
| -------------------------------------- | ---------------------------------- |
| none (never chose, or email-only rows) | none — default on                  |
| every push row `enabled = true`        | `push_enabled = true`, `migrated`  |
| any push row `enabled = false`         | `push_enabled = false`, `migrated` |

The predicate's fallback applies the same rule to any account without a row,
so a legacy write racing the deploy lands where the backfill would have put it.

Rollback: revert the application. The table is additive and per-kind rows are
unchanged, so the previous code reads its old data. Choices made through the
new switch after deploy are not visible to the old code. Dropping the table is
for a migration rehearsal only.
