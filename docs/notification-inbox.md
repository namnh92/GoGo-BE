# Shared notification inbox — #811 PR1 / #809

ADR-0050 defines the four-PR shape. This release implements only shared inbox
storage and read APIs. Owner decisions dated **2026-11-08** are recorded in
workspace `.claude/rules/execution-policy.md` §8 (BE#811) and ADR-0050 §6:
one reminder **120 minutes** before confirmed start (no start, no reminder;
reschedule/cancel on changes; newly confirmed inside the window sends once
immediately before start); quiet hours **default off**, opt-in **23:00–07:00**
in the stored timezone, defer push while inbox stays immediate; **no emergency
exception**; **no automatic cleanup**, including no seven-day deletion.
Replace Stitch's automatic sound-muting and seven-day cleanup claims.

The four PRs remain ordered: (1) shared inbox, **MINOR**; (2) category preferences
and filtering, semantic contract **MAJOR 5.0.0**; (3) sourced payload facts;
(4) approved scheduling and quiet-hour policies, with no emergency bypass or
cleanup job. These product policies are implemented in **PR4**, not this release.
Contract/migration CODEOWNER approval remains separate and required.

`GET /v1/me/notifications/summary` is the shared source for every unread badge,
including #809. It counts all account-owned unread inbox rows, regardless of push
settings or kind. Use one account-scoped client cache, clear it on account change,
and invalidate/refetch after single-read or completed read-all. Responses are
`Cache-Control: private, no-store`. A replayed mutation is never a current count.

## Storage and cutover

Migration **0091_notification-shared-inbox** is short transactional DDL. It adds
nullable historical sequences, account counters, a rollout gate and durable read
operations. The common `BEFORE INSERT` trigger allocates every notification's
sequence under the account counter row lock, held until the outer insert commits.
It covers raw SQL, campaigns, privacy exports and old worker binaries without
changing delivery behavior. Supplied sequence values are overwritten. Existing
unique dedupe constraints still decide whether a row exists; safe sequence gaps
are expected on dedupe retries. Multi-account transactional writers must acquire
account locks in sorted user-id order (current producers insert one account at a
time, except privacy publication, which inserts one row in its transaction).
Migration **0080_notification-erasure-fence** drains in-flight inserts before
replacing the allocator function under the same five-second lock timeout. It
retains the guard on binary rollback; a lock timeout rolls back the migration
and requires draining contention before retry.

1. Apply `pnpm db:migrate`. DDL waits for old insertion transactions before the
   trigger is installed, so old insert work is drained at this boundary. Schedule
   the DDL in a short-lock window. Migration 0079 enforces **SET LOCAL
   lock_timeout = '5s'** for its DDL, then restores the default. On PostgreSQL
   **55P03** (lock timeout), the transactional runner rolls back 0079, leaving
   it unapplied. Identify/drain the blocking transaction, then rerun the same
   migrate command; do not mark it applied or increase the timeout to force
   hot-table access. No data backfill or notifications index build runs in the
   migration transaction.
2. Deploy this release's API and worker together. Before backfill completes,
   the existing list stays available using full-precision `(createdAt,id)` fallback
   cursors, including historical rows with null sequences. Only summary/read-all
   return standard 503 until the gate is ready.
3. Run **one** operator process: `pnpm inbox:backfill` with the deployment's
   `DATABASE_URL`. First it repairs inbox remnants belonging to already-deleted
   accounts, including NULL-sequence rows recreated by old workers before 0079.
   Each repair commit removes at most 500 rows for one deleted account: read
   operations first, then notifications (with or without sequences), then its
   counter after both are empty. Accounts with only operations or a counter are
   also repaired. Each batch commits independently; interruption resumes from
   the remaining rows. Active accounts are excluded from erasure repair.
   This is rollout-time erasure repair, not an age-based retention policy.
   After repair, each commit assigns at most 500 historical rows for one
   account using the same account lock. New inserts continue. Kill/restart is
   safe: assigned rows are not selected again. Existing readAt, payload and
   dedupe markers stay unchanged. This command builds the unique, unread and
   page indexes with `CREATE INDEX CONCURRENTLY`, repairs invalid indexes left
   by interruption, then enables the cutoff gate only when no null sequences
   remain. Do not run simultaneous rollout CLI instances. Once ready, new list pages issue
   signed sequence-snapshot cursors; previously issued fallback tuple and legacy
   timestamp cursors still work through cutover.
   Sequence assignment is already active before APIs can issue cutoffs. A
   summary statement reads count and committed sequence in one MVCC snapshot;
   an uncommitted insert cannot enter its cutoff. Display ordering stays
   `(created_at DESC, id DESC)` and uses full database microsecond precision.
4. Verify summary, read-all >500 rows and status polling. Run the Testcontainers
   suite `apps/api/test/notification-inbox.int.spec.ts` in CI/Claude's environment.

### Exact deployed-image invocation

The operator entrypoint lives in `apps/worker/src/backfill-notification-inbox.ts`,
which the shared api/worker Docker image packages under `COPY apps`. It uses the
image's existing TypeScript loader; no checkout, bind mount, build output, or
`scripts/` directory is required. To run inside the **currently deployed api
container**, from the deployment repository root (DEV example):

```sh
ENV_FILE=.env.dev docker compose -f docker/docker-compose.prod.yml \
  --env-file .env.dev exec -T api pnpm inbox:backfill
```

Alternatively run the **same deployed image digest** as a one-off container on
the deployment network, with the deployment runtime env file (`DATABASE_URL`
must be reachable from that network):

```sh
docker run --rm --network "$DEPLOY_NETWORK" --env-file .env.dev \
  -e PROCESS=inbox-backfill "$DEPLOYED_API_IMAGE"
```

Both commands exit 0 only after backfill/index creation and gate enablement.
On interruption/failure, resolve contention/connectivity and rerun exactly one
operator process. Image-only packaging smoke: `bash scripts/ci/docker-inbox-backfill.test.sh`.

Indexes built outside the transactional migration runner:

- `notifications_user_sequence_unique`: UNIQUE (user_id, inbox_sequence).
- `notifications_unread_sequence_idx`: (user_id, inbox_sequence) WHERE read_at IS NULL.
- `notifications_inbox_page_idx`: (user_id, created_at DESC, id DESC).

## Read and cursor behavior

Read-through and page tokens are signed with a domain-separated key derived from
`AUTH_JWT_SECRET` (at least 32 characters). An unavailable key fails closed with
503; rotation invalidates existing tokens and clients should refetch. Tokens bind
account, purpose, schema version, all-kinds filter, committed sequence cutoff,
capture time and a 24-hour expiry. Page tokens also carry `(createdAt,id)`.
Before cutover, the list requires no signing key and returns unsigned, strictly
validated `before:<full-precision UTC timestamp>:<UUID>` tuple cursors. These retain
their tuple boundary and include historical rows regardless of gate activation;
they carry no sequence snapshot. Legacy ISO timestamp cursors retain their old
exclusive timestamp boundary and remain accepted after cutover. Once enabled, new arrivals above a page snapshot stay out of its
later pages, even with a backdated createdAt. Never log cursor values.

POST read-all requires `Idempotency-Key` and `{ through: readThroughCursor }`.
The idempotency claim, durable operation, first batch and stored response commit
in one transaction. Failure before commit leaves none of them. A completed replay
precedes token validation/expiry and returns the original 200/202 response for
the existing 24-hour idempotency lifetime. A changed body returns 422. Replayed
202 responses retain Location; poll it for current progress.

The first transaction and each worker transaction change at most 500 unread
rows at/below the cutoff. The worker polls every second, at most ten transactions
per tick, using locked durable operations; crashes resume from committed state.
Changed counts and progress commit with read markers. Concurrent reads lock rows
in sequence order and count only their own updates. All rows changed by one
operation receive its fixed action timestamp. Existing readAt never changes.
Missing and foreign single-read IDs return the existing `{ read: true }`/201;
foreign and missing operation IDs both return 404. No read action changes room
membership or invitation state. Self-service and CMS account erasure explicitly
delete inbox rows, counters and operations in their shared transaction; accounts
are soft-deleted, so FK cascades alone do not erase these records. Migration 0080
fences every notification insert with a user row SHARE lock before allocating a
sequence, suppressing deleted recipients for campaigns, privacy exports, raw SQL
and old workers as well. Backfill and read-all operation creation take the same
user-first lock; read-all rejects an already-erased account before claiming
idempotency. Erasure either
waits for insertion and removes it, or commits first and prevents recreation. No automatic
retention cleanup is introduced.

Metrics have bounded labels only: `notification_inbox_summary_total`,
`notification_read_all_requests_total{status=200|202}`,
`notification_read_all_batches_total{status=running|completed}` and
`notification_read_all_changed_total`. Batch/change metrics describe committed initial and resumed
batches; request metrics include replays. Monitor tick failures through the
existing periodic-worker error reporting; never add account, operation or cursor
labels. Provider acceptance/delivery metrics are unchanged.

## Rollback

Disable new cutoff traffic and stop read-all worker ticks before rolling back the
binary. Retain additive tables, the allocation trigger, indexes and all read
markers; old binaries continue inserting safely. Running operations remain
resumable on roll-forward. Do not reverse readAt or resequence rows. A physical
schema removal needs a later maintenance migration after clients and operations
have drained. This PR does not activate category policies or ADR-0050's later
category rollback procedure.
