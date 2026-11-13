# Room host transfer — #879

`POST /v1/rooms/{id}/host-transfer` accepts `{memberId, expectedHostVersion}` and
required `Idempotency-Key` (8–128 ASCII letters, digits, `_` or `-`). Read current
`hostMemberId` and `hostVersion` from room detail. The target is an active user
RoomMember in the same room, including pending/in-progress preferences. Self,
guest, removed and inactive accounts are refused. Only the four planning states,
before room expiry judged using DB clock after locking, accept transfer.

The 200 response is a fixed operation receipt with event ID and timestamp, two
membership IDs and new term, with `Cache-Control: no-store`. It exposes no user
ID, credential or room code. Retain one key per user operation; replay within
24 hours returns exactly that receipt with `x-idempotent-replay: true` even after
demotion/state changes. Auth is still mandatory. A changed request is 422;
a bounded lock wait/in-flight is retryable 409 with `Retry-After: 1`.

Transfer preserves membership, selections, votes, constraints, stale flags and
plans. Independent ownership terms reject computations from earlier terms,
including A→B→A. Host-only requests already in progress either commit before
transfer or fail their transaction guard afterwards. Original invite/link issuers
and expiry/use counts remain unchanged; ADR-0018 creators can revoke their own
links and the new host manages room invitations. No revoke-all is performed.

Clients refetch room/members/lists/capabilities after success/replay/conflict/403
and on `room.host_transferred` SSE. Payload: `transferId`,
`previousHostMemberId`, `newHostMemberId`, `hostVersion`. Ignore older terms.
SSE failure never undoes ownership: snapshots/polling are the fallback. Existing
member streams stay valid. Notification `host_transferred` opens the room and
uses normal master opt-out, quiet hours and account eligibility.

## Rollout

### API-deploy prerequisite: global idempotency cutover

The shared idempotency change (`20100c5f`) applies immediately on API deploy,
including while host transfer is disabled; it is not gated by transfer activation
or the `clients_ready` attestation. On all routes using the shared idempotency
scope, legacy body-only request hashes stop replaying. The existing records are
retained until their 24-hour TTL from claim creation expires
(`KEY_TTL_HOURS = 24` in `libs/modules/shared/idempotency.interceptor.ts`).

If a client mutation committed before deploy but its response was lost, an
identical retry after deploy returns non-retryable `422 IDEMPOTENCY_KEY_REUSED`
(`retryable: false`). Before issuing a new key, refetch the affected resource and
reconcile whether the original operation committed. A new key could duplicate
the mutation; neither this error nor record expiry proves that it failed. Do not
automatically rotate keys or wait for expiry and blindly resubmit.

Verify this client recovery behavior **before deploying the API**, separately
from the SSE/notification compatibility checks before transfer activation. Old
and new API instances must not serve the same keys concurrently. Use a single
cutover: drain/stop old requests before allowing new instances to serve traffic.
DEV and production both invoke GoGo-Infra's `scripts/deploy/deploy-vps.sh`, whose
`docker compose up -d` replaces the single API container by stopping the old
container before starting the new one. Preserve that stop-before-start boundary;
no rolling/canary overlap or extra old replicas may share the keys. Record fleet
revisions and verify no old API instance remains. See also the
[release runbook](runbooks.md#879--global-idempotency-cutover).

### Transfer activation

1. Apply migration 0105 with the transfer fence off. Invalid existing ownership
   stops activation; preflight names affected rooms. Resolve data explicitly,
   never pick a new host automatically. DDL has a 3 second lock timeout. Inventory identifiers using
   `scripts/ops/preflight-room-host-transfer.sql` in a restricted ops session.
2. Run `scripts/ops/backfill-room-creators.sql` in AUTOCOMMIT repeatedly until
   UPDATE 0. Batch size 1000, ordered and skip-locked, while transfer is disabled.
   Mixed old creates fill creator via the insert trigger. Measure duration/locks
   on a representative production-sized snapshot; the integration fixture's
   2500 rows proves correctness only. Do not equate it with production timing.
3. Run `scripts/ops/index-room-active-host.sql` in AUTOCOMMIT. It builds the partial
   unique index and the CMS creator-count expression index CONCURRENTLY. An existing name is insufficient: readiness checks
   uniqueness, table/key/predicate, validity and readiness. If interrupted or
   malformed, keep transfer off, DROP INDEX CONCURRENTLY and rebuild. No large
   index build is inside the migration transaction.
   Run `scripts/ops/validate-room-host-transfer.sql` after expansion/backfill;
   validation scans outside the expansion transaction and readiness requires it.
4. Deploy worker understanding the new event/kind/audience before producers.
   Old workers mark unknown events published without notification. Deploy all
   APIs with ownership guards and invite preview compatibility; fence/drain
   old host writers before enabling. Record actual fleet revisions.
5. Verify the pinned mobile build: closed SSE enum accepts/ignores the new event,
   notification fallback works, and refresh/polling converges. This implementation
   does not establish mobile compatibility or DEV acceptance. Obtain implementation
   Astra and mapped CODEOWNER review for contract/schema/permissions.
6. Record deployment attestations in `room_host_transfer_rollout`:
   `api_guards_ready`, `workers_ready`, `clients_ready`. Then run
   `scripts/ops/activate-room-host-transfer.sql`. It validates creator/ownership
   in one repeatable-read snapshot without blocking room writers, checks catalog
   readiness and atomically enables. Installed constraints protect new writes.
   Any failed condition rolls back activation. Keep the producer disabled until
   contract compatibility, CI and review gates are satisfied.
7. DEV smoke: A→B, B edit/kick/finalize, A receives 403, original key replays,
   B receives one notification, old invite previews/joins and creator revokes.
   Record tested/deployed revision and evidence; do not close #879 before acceptance.

## Rollback and recovery

Run `scripts/ops/disable-room-host-transfer.sql` first. A transfer already holding
the rollout row's shared lock may commit before the disabling update completes;
after it completes, new mutations are fenced. Authenticated completed receipts
remain replayable. Keep a binary that understands ownership and old invite issuers;
drain/reconcile queued notifications. Retain creator, host term, role/pointer,
receipts, audit and notification history. Do not auto-transfer back or drop an enum
value. Deep schema removal follows ADR-0002 only after every producer is fenced,
data verified, and a reviewed compatibility patch exists. No automatic destructive
reverse SQL is provided, because it would discard historical ownership.

## Verification and operations

Run `room-host-transfer.int.spec.ts` and `room-host-transfer-migration.int.spec.ts`
with Docker/Testcontainers, plus rooms, suggestion-plan, plan-optional-stops,
room-events-reconnect, notification-event-facts, notification-scheduling,
notification-inbox and credit-event-prerequisites integration suites. Regression
unit evidence, command exits and sandbox limitations live in the task evidence
directory. PostgreSQL lock barriers and trigger failure injection prove database
interleavings; mocks alone do not establish concurrency.

Metrics have bounded labels: `room_host_transfer_total{result,reason}`,
`room_host_transfer_duration_seconds`, `room_host_transfer_replay_total`,
`room_host_transfer_sse_failure_total`. Success counts after commit, replay counts
separately; no IDs, keys or request text become labels. Use existing outbox retries,
dead-letter and notification suppression metrics for delivery failures.
