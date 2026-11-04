# ADR-0037: Push subscription ownership and fencing

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** owner, SA (shape GoGo-MobileApp#398 rev 7), DEV
- **Extends:** ADR-0016, ADR-0017, ADR-0021, ADR-0025. Part 1 of device identity
  for push to devices with no account; part 2 is ADR-0038 (NTF-BE-017, #747).

## Context

The owner's rule (2026-11-03): a signed-in user receives everything, a device with
no session receives GoGo-wide promotions, and signing out returns to the second
case. Under Identity Verification a device with no session has no subscription at
all, so it will hold a BE-signed `device:<id>` identity (#747). One physical device
keeps one subscription, moving between owners.

`PUT /v1/me/push-subscriptions` reads the provider and then upserts, with no lock
across the call (a DB transaction is never held across a provider call). The
confirmed-logout path reads the provider and then revokes, the same way. Two orders
go wrong:

- a registration verified before a logout lands after it, and puts back a row the
  logout removed, or creates one the logout found absent;
- a logout delayed past a newer registration revokes it.

Today these only misstate an audience. Once a device can be owned by a user or by
an anonymous identity, they decide who owns the device. The upsert also cannot
coexist with device-owned rows: it sets `user_id` and leaves `device_id`.

## Options considered

1. **Timestamps on the row.** Rejected in the shape: clock order is not write order.
2. **A second table for device subscriptions.** Rejected: ownership transfer across
   tables can resurrect a row; one unique `subscription_id` makes it impossible.
3. **One table with an explicit owner, a revision, and a fence for absent rows.**
   Chosen.

## Decision

`push_subscriptions` gains `owner_kind user|device`, a nullable `user_id`, a nullable
`device_id` and an integer `revision`. A check constraint holds exactly one owner. No
writer produces `device` before #747.

Every ownership write follows one protocol:

1. Read `(revision, fence generation)` for the subscription id in one statement,
   **before** the provider read. No row reads as a null revision, no fence as 0.
2. Ask the provider, outside any lock.
3. Write only if what was read still holds:
   - row existed: `update … revision = revision + 1 where subscription_id = $1 and
revision = $read`;
   - row absent: in one transaction, touch the fence with a no-op upsert (taking its
     row lock), compare the generation to the one read, then
     `insert … on conflict do nothing`.
     Zero rows or a different generation is `409 PUSH_SUBSCRIPTION_CONFLICT`, retryable:
     reporting again verifies again.

`register()` sets `owner_kind='user', user_id=$me, device_id=null` in the same write.
A confirmed logout, in one transaction, advances the fence and then revokes with
`user_id = $me and revision = $read`, advancing the revision of a row already revoked
too, so a registration that read it cannot clear `revoked_at` afterwards. It reads before it asks, so it never acts on a
revision newer than its answer. A logout that saw no row revokes nothing.

**Lock order, for #747 to extend:** identity row (`for update`) → fence → subscription
row. Every multi-statement ownership transaction takes them in that order.

`push_subscription_fences(subscription_id, generation, updated_at)` is durable and
names no user.

## Consequences

- A delayed registration cannot undo a confirmed logout, and a delayed logout cannot
  revoke a newer registration. `apps/api/test/push-subscriptions.int.spec.ts` forces
  each order.
- `PUT /me/push-subscriptions` can answer 409. A client that has not learned it, the
  app until GoGo-MobileApp#398, treats it like any failed report: it logs, and the
  next report writes the row. Two simultaneous first reports now produce one 409.

Limits, stated rather than solved:

- **Provider and database are never updated atomically.** A registration verified
  before a logout's provider read can land after that read and before the logout's
  write. The logout then misses its compare-and-set and the row stays live though the
  provider has it disabled. Nothing is delivered, since the send addresses the identity
  and the provider holds the subscription disabled; the audience overcounts until the
  next report or logout. Telling this apart from a genuinely newer registration would
  need a second provider read.
- **The binary before this one does not advance `revision`.** A compare-and-set racing
  it during the deploy can overwrite its write; the device reports again.
- **Any signed-in caller can advance a fence for any id it names**, because "not on
  your user" also confirms a logout. Each advance can cost that id's first registration
  one 409, repeatedly if the caller knows the id and keeps at it; ids are not exposed.
  It also leaves one small row per id: the route's 30 requests a minute per actor bounds
  the rate, not the total. `updated_at` is there so a later retention sweep has something
  to read; none ships here.

## Migration & rollback

Forward: `0077_push-subscription-ownership.sql`, additive. Defaults keep the previous
binary's insert and upsert valid while no device-owned row exists.

**The rollback baseline for #747 is the release carrying this change, never an older
binary.** It takes over a device-owned row by writing a valid owner; the binary before
it is refused by the check constraint. Deploy this and let it run before enabling
device identities. Rolling back this release itself is safe only while no device-owned
row exists.

The schema stays on rollback. Reverting it is the `Down` script in the migration, a
separate decision with its own order, and it refuses while device-owned rows exist.
