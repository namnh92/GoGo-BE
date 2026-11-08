# Shared notification inbox — #811 PR1 / #809

ADR-0050 defines the four-PR shape. This release implements only shared inbox
storage and read APIs; §6 remains **pending owner**. Category choices, delivery
filtering, sourced payload facts, scheduling and retention belong to later PRs.

`GET /v1/me/notifications/summary` is the shared source for every unread badge,
including #809. It counts all account-owned unread inbox rows, regardless of push
settings or kind. Use one account-scoped client cache, clear it on account change,
and invalidate/refetch after single-read or completed read-all. Responses are
`Cache-Control: private, no-store`. A replayed mutation is never a current count.

## Storage and cutover

Migration **0091_notification-shared-inbox** is short transactional DDL. It adds
nullable historical sequences, account counters, a rollout gate and durable read
operations. Migration **0092_notification-erasure-fence** adds the shared
producer-side guard for erased accounts. The common `BEFORE INSERT` trigger allocates every notification's
sequence under the account counter row lock, held until the outer insert commits.
It covers raw SQL, campaigns, privacy exports and old worker binaries without
changing delivery behavior. Supplied sequence values are overwritten. Existing
unique dedupe constraints still decide whether a row exists; safe sequence gaps
are expected on dedupe retries. Multi-account transactional writers must acquire
account locks in sorted user-id order (current producers insert one account at a
time, except privacy publication, which inserts one row in its transaction).

1. Apply `pnpm db:migrate`. DDL waits for old insertion transactions before the
   trigger is installed, so old insert work is drained at this boundary. Schedule
   the DDL in a short-lock window; use the deployment's statement/lock timeouts
   and retry on contention. No data backfill or notifications index build runs in
   the migration transaction.
2. Run **one** operator process: `pnpm inbox:backfill` with the deployment's
   `DATABASE_URL`. Each commit assigns at most 500 historical rows for one
   account using the same account lock. New inserts continue. Kill/restart is
   safe: assigned rows are not selected again. Existing readAt, payload and
   dedupe markers stay unchanged. This command builds the unique, unread and
   page indexes with `CREATE INDEX CONCURRENTLY`, repairs invalid indexes left
   by interruption, then enables the cutoff gate only when no null sequences
   remain. Do not run simultaneous rollout CLI instances.
3. Deploy the API and worker together after that command completes. Summary,
   read-all and the corrected list return standard 503 until the gate is ready.
   Sequence assignment is already active before APIs can issue cutoffs. A
   summary statement reads count and committed sequence in one MVCC snapshot;
   an uncommitted insert cannot enter its cutoff. Display ordering stays
   `(created_at DESC, id DESC)` and uses full database microsecond precision.
4. Verify summary, read-all >500 rows and status polling. Run the Testcontainers
   suite `apps/api/test/notification-inbox.int.spec.ts` in CI/Claude's environment.

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
Legacy ISO timestamp cursors remain accepted during transition with their old
exclusive timestamp boundary. New arrivals above a page snapshot stay out of its
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
membership or invitation state. User deletion cascades inbox, counters and
operations. No new retention policy is introduced.

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
