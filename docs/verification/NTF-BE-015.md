# NTF-BE-015 — one inbox row for every recipient of an outbox event

Refs #584.

## Defect

`OutboxDispatcher` wrote `dedupe_key = <event id>` on the in-app notification of every recipient. Migration 0017 made `(user_id, dedupe_key)` unique, which allows that, but migration 0026 later added `notifications_dedupe_unique` on `dedupe_key` alone for campaigns. With both indexes, the first recipient's row was inserted and every other recipient's insert hit the global index and was dropped by `ON CONFLICT DO NOTHING`. Host-only events were unaffected; members events (`plan.published`, `plan.changed`, `room.status_active`) reached one member's inbox.

Reproduced on `origin/develop` da6a89e with the new tests and the dispatcher unchanged: five failures, each `expected [ 1, +0, +0 ] to deeply equal [ 1, 1, 1 ]`.

## Fix

- The dedupe key is `outbox:<event id>:<user id>`, so each recipient has its own key under the global index. Campaign keys (`campaign:<dispatch key>:<user id>`) cannot collide with it.
- Before inserting, the dispatcher reads the rows that carry the bare event id (the key the previous release wrote, which belongs to at most one recipient) and skips those recipients. An event retried across the deploy therefore does not give its first recipient a second row.
- The push call is unchanged: one provider request per event, idempotency key derived from the event id.
- No migration and no contract change. `dedupe_key` is not exposed by the API.

## Behaviour covered

`apps/api/test/user-providers.int.spec.ts`, outbox block:

- every member of a members event gets exactly one row, and one push request names all of them;
- a redelivery after a complete fan-out adds no row for anyone;
- a fan-out that failed after the first insert is completed by the retry with one row each;
- a legacy row keyed by the bare event id is kept and not duplicated;
- two dispatchers racing on the same event still write one row per member.

The existing single-recipient, backoff, dead-letter, refused-payload, no-target and outage cases still pass. See the pull request for command output.

## Rollback

Revert the commit. The previous release reads nothing by `dedupe_key`, so rows written with the new key stay valid inbox rows. One residual case: an event fanned out by this release and then retried by the reverted code writes a bare-event-id row for its first recipient, which duplicates that recipient's row. Only events still unpublished at the moment of the rollback can hit it.

## Not run

DEV deploy and a real multi-member room on DEV. CI did not run (GitHub Actions billing).
