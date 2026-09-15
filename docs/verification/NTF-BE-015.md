# NTF-BE-015 — one inbox row for every recipient of an outbox event

Refs #584.

## Defect

`OutboxDispatcher` wrote `dedupe_key = <event id>` on the in-app notification of every recipient. Migration 0017 made `(user_id, dedupe_key)` unique, which allows that, but migration 0026 later added `notifications_dedupe_unique` on `dedupe_key` alone for campaigns. With both indexes, the first recipient's row was inserted and every other recipient's insert hit the global index and was dropped by `ON CONFLICT DO NOTHING`. Host-only events were unaffected; members events (`plan.published`, `plan.changed`, `room.status_active`) reached one member's inbox.

Reproduced on `origin/develop` da6a89e with the dispatcher unchanged: five failures, each `expected [ 1, +0, +0 ] to deeply equal [ 1, 1, 1 ]`.

## How outbox events are claimed and retried

Facts from develop da6a89e, unchanged on this branch:

- `OutboxDispatcher.dispatchBatch` (`libs/modules/notifications/application/outbox-dispatcher.ts`) selects due, unpublished, not dead-lettered events **without a row lock** (no `FOR UPDATE`, no `SKIP LOCKED`), fans each one out, then sets `published_at`. A failure increments `attempts` with backoff (5 s up to 20 min) and dead-letters after six attempts. Delivery is at-least-once: an event is redelivered when its fan-out throws, or when the process dies between the inbox writes and `published_at`.
- The worker runs it as the periodic job `gogo:worker:outbox` (`apps/worker/src/main.ts`, job list around line 470). `startPeriodic` (`apps/worker/src/periodic.ts`, `tick`) takes a `worker_leases` row per tick and releases it after the tick (`libs/database/src/worker-lease.ts`; TTL 90 s renewed every 30 s, `main.ts` `LEASE_TTL_MS` and the `WorkerLease` options). Two processes run the tick at the same time only when a holder loses its lease mid-tick (no renewal for 90 s, or the database unreachable) — `dispatchBatch` does not stop on the lease's abort signal.
- Shutdown (`main.ts`, `shutdown`): SIGTERM stops scheduling and waits for the in-flight tick before closing the pool. The image `exec`s node (`docker/Dockerfile`, `CMD`), so the signal reaches the process.

## How DEV replaces the worker

- `GoGo-Infra/scripts/deploy/deploy-vps.sh` builds, runs the `migrate` job, then `docker compose up -d` on the named services. Compose stops the old worker container (SIGTERM, Docker's 10 s default grace — `docker/docker-compose.prod.yml` sets no `stop_grace_period`) before it starts the new one. There is one worker replica.
- A tick still running after 10 s is killed. Its lease is not released and expires within 90 s; the new worker then redelivers every event left unpublished.
- The automatic rollback after a failed health check checks out the previous revision and runs the same `up -d`.

So two releases meet on one event **sequentially** in ordinary deploys and rollbacks (a killed or failed fan-out redelivered by the other release) and **concurrently** only after a lost lease.

## Fix

For each event:

1. Read the rows that already exist under this event's keys (the bare event id and each recipient's `outbox:<event id>:<user id>`).
2. Write the first recipient that has no row under the **bare event id** — the key the previous release used — with `ON CONFLICT DO NOTHING`.
3. Read who owns the bare-key row.
4. Write everyone else under `outbox:<event id>:<user id>`.

Once the bare-key row exists, every insert the previous release makes for that event conflicts on the global index and writes nothing. If the previous release got there first, its first recipient owns the bare key and this release skips them. Campaign keys (`campaign:<dispatch key>:<user id>`) cannot collide with either key. The push call is unchanged (one provider request per event, idempotency key derived from the event id). No migration and no contract change; `dedupe_key` is not exposed by the API.

## Interleavings with the previous release

`apps/api/test/outbox-release-overlap.int.spec.ts` runs the previous release's inbox loop — copied verbatim from `outbox-dispatcher.ts` lines 142–153 on develop da6a89e — and this release against one database, for an event with three recipients.

| Case                                                                                                              | Per-recipient keys only (fd846ce)                    | This change                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| (a) This release fans out and is killed before marking; the previous release retries after a rollback             | first recipient has 2 rows                           | one row each                                                                              |
| (b) The previous release fans out and is killed before marking; this release retries after the deploy             | one row each                                         | one row each                                                                              |
| (c) Both at once, with the previous release run at each pause point before this release's 1st, 2nd and 3rd insert | a recipient has 2 rows (pause before the 1st insert) | one row each at every pause point                                                         |
| (c) Both racing freely on 12 events                                                                               | no duplicate observed (timing, not guaranteed)       | no duplicate; a redelivery completes every inbox                                          |
| (d) This release is killed after one insert; the previous release retries after a rollback                        | duplicate                                            | no duplicate; one row in total until this release runs the event again, then one row each |
| (e) The previous release is killed after one insert; this release retries                                         | one row each                                         | one row each                                                                              |
| The previous release reached an out-of-order recipient first, then both releases retry                            | one row each                                         | one row each                                                                              |
| (f) The bare-key owner deletes their account before this release retries                                          | not covered                                          | remaining recipients one row each, nobody a second                                        |

## Boundary

- **Duplicates.** None in any interleaving above. One narrow exception remains: if the bare-key owner deletes their account while the event is still unpublished, this release completes the event without a bare-key row, and if the **previous** release then retries that same event after a rollback, it writes a bare-key row for its first recipient, who already has a row. It needs an account deletion and a rollback to meet on one unfinished event; the rollback procedure below removes it.
- **Missing rows.** The previous release can write only one recipient per event — that is the defect this change fixes — so rolling back reintroduces #584 for every new event. An event this release left partly written and the previous release then retries keeps its unwritten recipients empty until this release runs it again (case d).

## Deploy and rollback procedure

**Deploy (previous release → this release).** No extra step. Every interleaving is duplicate-free, and this release completes fan-outs the previous release left unfinished (cases b and e).

**Rollback (this release → previous release).** Leaves no event partly written and removes the account-deletion exception:

1. While this release's worker is still running, count unfinished events that already have inbox rows, and wait until it returns 0. A healthy event clears within one tick; an event that keeps failing waits for its backoff.

   ```sql
   select count(*) as unfinished_with_rows
   from outbox_events e
   where e.published_at is null
     and e.failed_at is null
     and exists (
       select 1 from notifications n
       where n.dedupe_key = e.id::text
          or n.dedupe_key like 'outbox:' || e.id::text || ':%'
     );
   ```

2. Stop the worker gracefully with the same compose files the deploy uses (`docker compose … stop worker`). It finishes the tick in flight before it exits.
3. Confirm nothing holds the outbox lease and nothing unfinished appeared since step 1:

   ```sql
   select expires_at > now() as held
   from worker_leases
   where name = 'gogo:worker:outbox';
   ```

   `held` must be false (or no row), and the step 1 query must still return 0.

4. Deploy the previous revision.

If step 1 never reaches 0 because an event keeps failing, fix or dead-letter that event deliberately first; do not delete its inbox rows. The automatic rollback inside `deploy-vps.sh` does not run these steps. It fires only when the new release fails its health check, so the new worker has usually run for under a minute; its exposure is limited to the boundary above. A manual rollback follows this procedure.

## Push locale groups across a release boundary (GoGo-BE#594)

Since #594 the dispatcher sends one provider call per recipient locale:

- **`vi`** carries idempotency key `event.id`, which is the only key the previous release ever sent.
- **`en`** carries `event.id:en`.

Inbox rows are unaffected. Push for `en` recipients can go wrong when an event is retried by the other release:

- **Duplicate (previous → this release).** The previous release sends its single call under `event.id` to every recipient, `en` included, and is killed before marking the event. This release's retry of the `vi` call is a provider-side replay. Its `en` call carries a new key, so `en` recipients get a second push.
- **Missing (this release → previous).** This release's `vi` call succeeds, then its `en` call fails transiently. The previous release's retry after a rollback sends everyone under `event.id`, which the provider treats as a replay of the `vi` message, so `en` recipients get no push.

**Exposure today is none.** Every account is `vi` (the column default, and no client writes `en`). Check before a deploy or rollback:

```sql
select count(*) as en_accounts from users where lower(locale) like 'en%';
```

If it is non-zero:

- **Rollback:** the procedure above already closes the missing case. Step 1 waits until no unfinished event has inbox rows, and the push always follows the inbox rows.
- **Deploy:** the duplicate case needs the previous worker killed mid-fan-out. Stop it gracefully (steps 2–3) before deploying.

## Not run

DEV deploy, a real multi-member room on DEV, and a real rolling replacement of the DEV worker. Command output for this head is in the pull request.
