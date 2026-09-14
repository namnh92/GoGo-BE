# ADR-0025: One application-level push switch per account

- **Status:** accepted (2026-09-14)
- **Date:** proposed 2026-09-14; owner decisions recorded 2026-09-14
- **Deciders:** BE + Mobile + product owner (repository owner approved the two
  product decisions below on 2026-09-14)
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
  per-kind push rows are ignored for delivery by this release. They are still
  written (see Rollback compatibility) so that an earlier release reads the
  same choice.
- **Older clients** (`PUT /me/notification-preferences`):
  - a push opt-out (`enabled: false`) for any kind turns the switch off
    (`source: legacy`) — a single kind can no longer be stopped on its own, so
    the request is honoured conservatively;
  - a push opt-in (`enabled: true`) never turns push back on; the row is stored
    only while push is allowed, and ignored while it is off;
  - email rows are stored and returned as before.
- **Older clients reading** (`GET /me/notification-preferences`) see every push
  kind as the switch's value, so an older screen does not show a kind as on
  while nothing is pushed.
- The contract carries no field for OS permission, subscription or delivery.
- Export includes `{ pushEnabled, source }`; account deletion removes the row
  and the per-kind rows.

### Owner decisions (approved 2026-09-14)

1. **CMS campaigns follow the single push switch.** A person who turns push off
   receives no campaign; a person who has push on receives campaigns without a
   separate opt-in.
   - This deviates from SRS FR-USER-008 (`GOGO_SRS.md`, §User, "`marketing`
     mặc định tắt và luôn tách riêng khỏi transactional"), which asks for a
     separate, default-off marketing preference. Develop never implemented
     that preference: campaigns already reached everyone without a `campaign`
     opt-out. The owner chose to keep that reach and put campaigns under the
     one switch.
   - **Follow-up:** a separate marketing consent, if wanted (for store policy or
     regulation), is a new decision and a new ADR. It must not be inferred from
     the per-kind `campaign` rows, which this change now writes as a mirror of
     the switch.
2. **Any legacy push opt-out disables all push.** Migration 0064 turns off every
   account holding any push-channel opt-out, and a later legacy opt-out of one
   kind turns the switch off. Some people lose notifications they still wanted
   until they turn the switch on; nobody receives a push they asked not to get.

## Rollback compatibility

The release before this change decides push from per-kind rows alone
(`outbox-dispatcher.ts` skips an account whose `push` row for the event's kind
is off; `respectsPushPreference` skips a `push`/`campaign` row that is off). If
the switch lived only in `notification_settings`, a person who turned push off
after the deploy would be pushed again by that release after a rollback.

So every write that decides push keeps the per-kind rows in step, in the same
transaction, under a row lock on the account (`for no key update`), so that two
concurrent writes cannot leave the switch and the rows disagreeing:

| Write after the deploy                   | `notification_settings` | per-kind `push` rows (every kind, `campaign` included) |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `PUT /me/notification-settings` off      | `false`, `explicit`     | all `false`                                            |
| `PUT /me/notification-settings` on       | `true`, `explicit`      | all `true` (leftover opt-outs cleared)                 |
| legacy push opt-out, any kind            | `false`, `legacy`       | all `false`                                            |
| legacy push opt-in while push is allowed | unchanged               | that kind `true`                                       |
| legacy push opt-in while push is off     | unchanged               | unchanged (the request is ignored)                     |
| legacy email write                       | unchanged               | unchanged; the email row is stored as asked            |

Invariant, tested against that release's predicates copied verbatim into
`apps/api/test/notification-settings.int.spec.ts`: after any of these writes,
the earlier release pushes a kind to the account if and only if this release
pushes to it.

### Accepted rollback boundary

A rollback restores the previous release's rules, which read only the per-kind
rows. Whether it resumes a notification category depends on whether the account
wrote anything after the deploy:

| Account state at rollback                         | This release      | Previous release after rollback                                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| Any switch or legacy write after the deploy       | as chosen         | the same (per-kind rows mirror the switch)                                               |
| Untouched, every push row on, or no push rows     | push on           | push on                                                                                  |
| Untouched, every push row off                     | push off          | push off for those kinds; kinds that never had a row and campaigns follow their own rows |
| Untouched, **mixed** (e.g. only `plan_ready` off) | push off (policy) | **other kinds and campaigns resume**; `plan_ready` stays off                             |
| Untouched, only `campaign` off                    | push off (policy) | every kind resumes; campaigns stay off                                                   |

So **yes: a rollback resumes categories that only the migration policy turned
off**, for accounts that made no notification write after the deploy. It never
resumes a category the person turned off themselves. The owner decision "any
legacy opt-out disables all push" is a rule of this release; by default a
rollback returns those accounts to the choices they had actually recorded.

Accepted boundary (2026-09-14):

- **Always preserved:** every opt-out a person recorded, before or after the
  deploy, through any client.
- **Preserved by default only for accounts that wrote after the deploy:** the
  all-off policy. Untouched mixed accounts return to their pre-deploy per-kind
  behaviour.
- **Optional hold:** if the policy must keep holding while rolled back, run
  `scripts/ops/ntf-0064-rollback-hold.sql` after stopping this release and
  before starting the previous one. It writes a `false` push row for every kind
  to each account this release does not push to, so the previous release pushes
  nothing to any account this release does not push to (tested), and leaves
  every other account as it was. Its cost is permanent: it overwrites the per-kind rows
  that recorded which single kind a person had turned off.
- **Never preserved:** the `source` and timestamp of a choice (the previous
  release has no such fields); an explicit "on" that cleared an earlier per-kind
  opt-out stays cleared.

## Consequences

- Mobile replaces twelve toggles with one switch and keeps OS permission as a
  separate, device-read state (NTF-APP-010).
- Per-kind delivery control is gone from the product. Reintroducing it needs a
  new decision; the per-kind rows are now a mirror of the switch and are not a
  correct basis for it.
- The email channel is untouched: its rows are stored and returned as before,
  and nothing sends email.
- A switch write touches up to eight rows (one settings row, seven push rows)
  in one short transaction.

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
The migration modifies no existing row.

Order: 0064 deploys after 0063 (GoGo-BE#581) and before 0065/0066. Drizzle
applies only journal entries newer than the last applied one, so an environment
that has already run a later migration would skip this one silently.

Rollback procedure:

1. Stop this release's api and worker. Decide whether the all-off policy must
   hold while rolled back (see Accepted rollback boundary); if it must, run
   `scripts/ops/ntf-0064-rollback-hold.sql` now.
2. Deploy the previous application revision. No down-migration is needed: the
   table is additive, and the per-kind rows already carry every post-deploy
   choice (see Rollback compatibility).
3. Leave `notification_settings` in place. Rolling forward again reads it as it
   was; choices made on the older release through the per-kind API while rolled
   back are then judged by the predicate's rules (an opt-out turns push off).
4. `DROP TABLE notification_settings` is for a migration rehearsal only.
