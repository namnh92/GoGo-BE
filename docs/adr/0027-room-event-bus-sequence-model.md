# ADR-0027: Room event bus sequence model and opaque resume cursor

- **Status:** proposed — the contract part needs CODEOWNER approval before any implementation (`.claude/rules/git.md`)
- **Date:** 2026-10-02
- **Deciders:** SA review (Astra, shape decided 2026-10-02 on owner assignment), product owner (CODEOWNER for the OpenAPI change), backend
- **Related:** GoGo-BE#638, GoGo-BE#608, GoGo-BE PR #649 (superseded approach, findings F-01/F-04/F-05), ADR-0005, BE-BFF-013 (#154), `.claude/rules/api-contract.md`
- **Decision source:** `dev/handoffs/codex-review-request-be-638-sa.sa.out` (workspace GoGo, DECISION 1–6). This record transcribes that decision; it does not redesign it.

## Context

`GET /v1/rooms/{id}/events` is the room realtime stream (SSE). Each domain
event is published through `RoomEventBus`; the multi-instance implementation is
`RedisRoomEventBus` (`libs/modules/realtime/infrastructure/redis-room-event-bus.ts`).

What it does on `develop` today:

- **Publish** is five separate commands on one connection: `INCR room:<id>:seq`
  (key TTL 24 h) → `ZADD room:<id>:buffer <seq> <json>` → `ZREMRANGEBYRANK` to
  200 → `EXPIRE buffer 15 min` → `PUBLISH room:<id>:events <json>`.
- **Attach** reads the buffer (`ZRANGEBYSCORE afterSeq+1 +inf`) _before_
  subscribing to the channel, then subscribes once per channel per process
  (local ref-count).
- **SSE** (`room-events.service.ts`) writes `id: String(seq)`; the resume point
  is parsed with `Number()` and a malformed one silently becomes a fresh
  stream. `resync` is sent as `{reason: 'replay_window_exceeded', roomId}` only
  when the oldest retained event is past `afterSeq + 1`.
- `heartbeat` and `resync` frames are written without an `id`, so NestJS's
  `SseStream` assigns them a **per-connection counter** (`@nestjs/core`
  `router/sse-stream.js`, `writeMessage`). A browser `EventSource` would store
  that counter as its resume point. GoGo-MobileApp ignores both frames' ids for
  this reason (`src/shared/api/realtime/transport.ts:816-822`).

Symptoms and findings that force a decision:

- **#638** — on DEV, the first event after a reconnect arrived 14.3 s after the
  mutation while the stream stayed open (AC5 of GoGo-MobileApp#286 requires
  < 8 s). Root cause unproven.
- PR #649 moved subscribe before the buffer read and added an `early` queue
  with expiring dedupe. Two DEV review rounds then found defects that are
  properties of the sequence model, not of the patch:
  - **F-01 (P1, pre-existing on develop)** — sequence assignment, buffer append
    and publish are separate commands, so two API instances can publish
    `seq 8` before `seq 7`. Sequence order ≠ publication order; a subscriber
    can see a gap or an inversion with no way to tell.
  - **F-04 (P1)** — the counter key expires (24 h) independently of the
    buffer. After a reset, a client resuming from `afterSeq = 2` can receive a
    new `seq = 1` during the attach window; the sequence filter drops it
    silently. Checking `afterSeq > currentSeq` does not catch a reset whose
    counter has already caught up.
  - **F-05 (P2)** — replay dedupe expired after 30 s, so a delayed Pub/Sub copy
    of a replayed event was delivered twice.
- **#608** — host finalize publishes nothing; the fix (post-commit
  `plan.updated` then `room.status_changed`) must ride on a bus that orders
  and resumes correctly.

The escalation rule (execution policy §6: same area failing a second fix
round) sent the shape to SA. A further patch round on the numeric model was
ruled out.

## Options considered

From the SA decision, per concern. Chosen option first.

1. **Atomic publication**
   - _Chosen:_ keep ZSET buffer + Pub/Sub; one Lua script does validation,
     sequence assignment, append, trim, TTL refresh and `PUBLISH` of the
     identical envelope. One Redis execution serializes concurrent publishers,
     so sequence order equals publication order.
   - _Rejected:_ separate commands or a pipeline (not serialized across
     instances); process-local locks (cannot serialize instances); Redis
     Streams (a reader/connection migration this bounded-replay requirement
     does not need); accept-and-resync (cannot replace correct normal
     delivery).
2. **Sequence identity across resets**
   - _Chosen:_ a non-expiring metadata hash `{generation: UUID, seq}`; cursor
     identity is `(generation, seq)`.
   - _Rejected:_ counter TTL tied to the buffer (permits reuse); a non-expiring
     numeric counter alone (cannot tell deletion/recreation); `afterSeq >
currentSeq` checks (miss a reset whose counter caught up).
3. **Replay/live handoff**
   - _Chosen:_ bounded live queue installed before SUBSCRIBE, atomic snapshot
     after the ACK, paused subscription, explicit `activate()`.
   - _Rejected:_ time-based dedupe expiry (30 s); sequence-only identity across
     generations; relying on promise/microtask scheduling for ordering.
4. **Client contract**
   - _Chosen:_ opaque `v2:<generation>:<seq>` SSE `id`; reuse `resync` with a
     reason and checkpoint.
   - _Rejected:_ a UUID-only cursor (cannot order replay); treating
     legacy/malformed cursors as a fresh stream (silently loses history); a
     20–80 s safety poll as the fix (cannot satisfy the 8 s requirement).
5. **Failure handling**
   - _Chosen:_ terminate affected streams on subscriber connection loss; client
     reconnect runs the full attach protocol.
   - _Rejected:_ transparent ioredis auto-resubscription as recovery — Pub/Sub
     does not replay what was missed while disconnected.
6. **Verification**
   - _Chosen:_ property-based state-machine tests plus Testcontainers Redis with
     two independently connected bus instances and real HTTP SSE.
   - _Rejected:_ fake-Redis-only proof (cannot establish Lua execution, socket
     ordering, reconnect behaviour or the 8 s latency bound).

## Decision

**D1 — Atomic publication.** One Lua script per publish: validate inputs and
key types, assign the sequence, append to the ZSET buffer, trim to
`REPLAY_BUFFER_SIZE` (200), refresh the buffer TTL, then `PUBLISH` the
identical envelope. All keys of one room are explicit same-slot keys (a hash
tag on the room id).

**D2 — Generation-qualified sequence.** One non-expiring metadata hash per room
holds `{generation: UUID, seq}`; `seq` increments within a generation. The
buffer TTL stays 15 minutes. Missing metadata creates a fresh generation
atomically and discards any orphaned buffer; identity is never reconstructed
from surviving buffer scores. A generation mismatch triggers `resync` before
any sequence comparison. (Resolves F-04.)

**D3 — Explicit replay/live handoff.** Attach order: install a bounded live
queue → await the SUBSCRIBE ACK → atomically read generation, high-water `H`,
retained bounds and replay → return a _paused_ subscription → the SSE service
emits the replay → calls `activate()` to drain live.

- Replay must cover `(afterSeq, H]` completely; only contiguous,
  same-generation sequences are emitted.
- A live gap pauses delivery for replay recovery; an unexplained generation
  change forces an authoritative metadata re-read.
- Replay/live overlap is deduplicated by immutable `event_id`; the ≤ 200 replay
  ids are retained for the whole subscription (not deleted on first
  duplicate), plus a same-generation delivered high-water mark for older
  copies. (Resolves F-05.)
- The early queue is bounded to 200; overflow enters recovery/resync, never a
  silent drop. Fresh connections (no cursor) keep subscribe-only semantics.

**D4 — Client contract.** SSE `id` and `Last-Event-ID` carry the opaque cursor
`v2:<generation>:<decimal-seq>`. Payload `event_id` stays the UUID;
`event_version`, `occurred_at` and the domain envelope are unchanged. The
existing `resync` frame is reused with `{roomId, reason, checkpoint}`; reasons
distinguish unavailable replay, generation change and invalid/legacy cursor.
`resync` is emitted before any subsequent domain event; `heartbeat` carries no
cursor. `checkpoint` is the atomic current `(generation, H)`. The client
refetches authoritative room/plan state while queuing later events, reconciles
by resource version, and keeps "snapshot required" across reconnects until a
refetch succeeds.

**D5 — Failure and retention boundaries.**

- Subscriber connection disconnect/reconnecting/end terminates the affected
  SSE streams and releases references; the client's reconnect runs the full
  attach protocol.
- Channel bookkeeping becomes serialized subscribe/active/unsubscribe states
  with connection-generation tokens. Kept from PR #649 head `684e5f8`: shared
  ACK promise, idempotent release, failure rollback, handled unsubscribe
  rejection. Stale completions must not affect new attachments.
- `maxRetriesPerRequest: 1` stays; add a 5 s attach deadline; disable automatic
  resend/offline queuing of publication commands. An ambiguous publication
  result must not cause a new publication with a new UUID.
- `resync` when generations differ, the cursor exceeds `H`, or any required
  sequence is unavailable — including an empty buffer with `H > afterSeq`.
  `afterSeq = H` with an empty buffer is a valid, empty replay. A partial
  replay is never returned as success.

**D6 — Verification shape.** See _Test plan_.

### Wire format (this PR)

Recorded in `openapi/gogo.v1.yaml` (`1.0.0-alpha.61`):

- `/rooms/{id}/events` description, `Last-Event-ID` header and `lastEventId`
  query: opaque cursor semantics, resume outcomes, recovery rules. The
  parameter schemas stay `type: string` with no pattern, because a legacy or
  malformed value must be _accepted_ and answered with `resync`, not rejected.
- New `RoomEventResync` `{roomId, reason, checkpoint}` — `data` of the
  `event: resync` frame.
- New `RoomEventResyncReason` — `x-extensible-enum: [replay_unavailable,
generation_changed, invalid_or_legacy_cursor]`. Extensible so a later reason
  is not an enum-growth break, and so clients refetch on an unknown reason.
- New `RoomEventCheckpoint` `{cursor, generation, seq}`. `cursor` is the
  opaque form to resume from after the refetch; `generation`/`seq` are
  informational (clients must not build a cursor from them).
- `RoomEvent` description: the frame `id` is the cursor, not `event_id`;
  `resync`/`heartbeat` frames do not carry the envelope.

Rename noted: today's `replay_window_exceeded` becomes `replay_unavailable`
(it now also covers trimmed/expired buffers and `H > afterSeq` with an empty
buffer). The old value was never declared in the spec; GoGo-MobileApp tests
use it as a fixture string only and its code does not branch on `reason`.

Not changed: the `200` response still references `RoomEvent`. Changing it to a
`oneOf` of frame payloads would correct a pre-existing mislabel (resync and
heartbeat data were never the envelope) but risks an oasdiff response-shape
finding; it is left for a separate decision (open question 3).

### Implementation constraint the contract implies

Because NestJS assigns a per-connection counter to any message without an `id`
(and not comment-only), "heartbeat carries no cursor" cannot be met by simply
omitting `id`. The implementation must make non-domain frames carry no
server-assigned numeric id; otherwise a browser `EventSource` resumes with a
counter, which v2 treats as `invalid_or_legacy_cursor` and answers with a
`resync` on every reconnect. The mechanism (comment-only heartbeat frame vs.
another way to suppress the id) is open question 1.

## Consequences

- Ordering, reset detection and overlap dedupe move from best-effort to
  defined behaviour; every case the server cannot honour is reported
  (`resync`) instead of skipped or duplicated.
- One Redis round trip per publish (the script) instead of five; attach adds
  one atomic snapshot read.
- Clients must treat the cursor as opaque and implement the snapshot-required
  rule. Exact replay holds only while history is retained; `resync` restores
  state, not evicted history. Unconditional lossless delivery would need a
  durable event log, out of scope.
- #608's post-commit `plan.updated` → `room.status_changed` publication stays
  best-effort (a failed post-commit publish is not covered by replay).
- Telemetry boundaries (`UPSTASH_REDIS_OPERATIONS.roomEventsPublish` /
  `roomEventsSubscribe`, one runtime call each) are preserved.

## Consumer migration plan

Order: **contract (this PR) → consumers updated to opaque handling → server
cutover**. The server accepts any cursor value from the first v2 deploy;
legacy numeric cursors are answered with `resync`
(`invalid_or_legacy_cursor`), never with an error or a silent fresh stream.

**GoGo-MobileApp** (`src/shared/api/realtime/transport.ts`)

- Already compatible: stores `event.id` as a string, sends it back verbatim,
  ignores ids on `heartbeat`/`resync`, clears the resume point and refetches
  on `resync`, never parses the id (verified on `origin/develop`).
- Must change:
  1. Keep a persistent _snapshot required_ flag set on `resync` and cleared
     only when the refetch succeeds. Today `refetchSubscribed` is
     fire-and-forget query invalidation (`transport.ts:636-653`); nothing
     records whether it succeeded, and once item 3 makes the stream resume
     from a cursor again, the cursor-less reconnect that currently re-triggers
     a refetch (`transport.ts:795`) no longer covers a failed one.
  2. Queue domain events received while the refetch is in flight and
     reconcile by resource version (`constraintVersion`, plan `version`)
     instead of invalidating immediately.
  3. After a successful refetch, resume from `checkpoint.cursor` rather than
     reconnecting without a cursor.
  4. Treat an unknown `reason` as a refetch; vendor `1.0.0-alpha.61`
     (`RoomEventResync`, `RoomEventCheckpoint`) and replace the
     `replay_window_exceeded` fixtures.
- Ships before the server cutover. Items 1–2 are the correctness part; 3–4 are
  efficiency/typing.

**GoGo-WebApp** — no SSE consumer exists on `develop` (scaffold only). When
built, it must use the opaque cursor and the snapshot-required rule from day
one, and must not let a browser `EventSource` adopt ids from non-domain frames
(see _Implementation constraint_).

**GoGo-CMS** — does not consume `/rooms/{id}/events`. Vendors the spec only:
take `1.0.0-alpha.61` for the version gate; no code change.

**Deprecation timeline** (owner to fill):

| Step                                                                                    | Date  |
| --------------------------------------------------------------------------------------- | ----- |
| Contract approved (CODEOWNER)                                                           | _TBD_ |
| Mobile build with items 1–2 released to testers                                         | _TBD_ |
| Server v2 cutover on DEV (publishers drained)                                           | _TBD_ |
| Legacy numeric cursor support window ends (keeps answering `resync`; no numeric resume) | _TBD_ |

There is no window in which the server _resumes_ from a numeric cursor:
mixing the two algorithms invalidates ordering (see _Migration & rollback_).

## Migration & rollback

**Cutover.**

1. Deploy the v2 bus with new metadata/buffer keys (same-slot hash-tagged).
   Old `room:<id>:seq` / `:buffer` keys are ignored and expire on their own
   (24 h / 15 min).
2. Drain old publishers first: every API instance must run the v2 publish
   script before any instance serves v2 cursors. Mixed publication algorithms
   invalidate ordering. On the single-instance DEV stack this is the deploy
   itself; with several instances it is a stop-the-old, start-the-new rollout,
   not a rolling one.
3. Every connected client reconnects (the deploy closes streams); their
   numeric cursors receive `resync` (`invalid_or_legacy_cursor`) and they
   refetch. Expected one-time cost: one refetch per open room screen.

**Redis rollback/restore.** A restored Redis can bring back an old generation
whose sequence numbers were already handed out. Recovery must rotate the
generation of affected rooms before serving (delete metadata → next publish
creates a fresh generation; clients get `generation_changed`).

**Code rollback.** Reverting to the numeric bus: v2 cursors (`v2:` prefix) fail
`Number()` parsing and the old code starts a fresh stream — a silent gap, the
pre-ADR behaviour. Mobile's safety poll covers it. The spec change is
documentation plus new components; reverting it is a version bump with no
client break.

## Test plan

Must-have (D6):

1. Two real publishers race repeatedly: every subscriber and every replay
   observes the same strictly increasing, duplicate-free sequence.
2. Resume at old `seq = 2`; delete metadata and publish a new `seq = 1` during
   attach → `resync`, never silent filtering. Repeat with the new counter
   already past 2.
3. Publish at every attach boundary, including after the snapshot and before
   `activate()`: replay precedes live, each retained event delivered once.
4. Delay and repeat a replayed Pub/Sub copy beyond 30 s: neither copy
   re-emits. Assert bounded queue/set memory.
5. Trim boundaries, buffer-only expiry, empty-buffer gaps, cursor ahead of the
   server, missing metadata, malformed and legacy cursors.
6. Concurrent SUBSCRIBE rejection, disconnect, unsubscribe rejection, late ACK,
   last-detach/new-attach race, ambiguous publish response: no leaks, no
   unhandled rejection, no heartbeating deaf stream.
7. Real SSE reconnect followed by a mutation/finalize: required domain events
   arrive once, in order, **under 8 s from the mutation**, on a continuously
   open receiving stream. Heartbeats, forced reconnects and polling do not
   count.

Plus: frames other than domain events carry no numeric SSE id (guards the
NestJS auto-id trap); #608 finalize emits `plan.updated` then
`room.status_changed` after commit.

Layers: property-based state-machine tests (unit), Testcontainers Redis with
two independently connected bus instances, HTTP SSE end-to-end.

## Risks

- Exact replay is guaranteed only while history is retained; `resync`
  restores state, not evicted event history.
- Redis restore can resurrect an old generation — rotation before serving is
  mandatory (see above).
- Mixed publication algorithms during cutover invalidate ordering — drain
  first.
- The 14.3 s cause in #638 is still unproven; the latency test (7) is the
  acceptance, not this design.
- Lua script compatibility and latency on the production Redis provider
  (Upstash) need evidence before cutover; consumer `resync` handling needs
  evidence on device.
- Failed post-commit publications (#608) remain best-effort, outside the
  replay guarantee.

## Open questions for the owner

1. Non-domain frame ids: a comment-only heartbeat (`: heartbeat`, no
   `event: heartbeat`) is the simplest way to satisfy "heartbeat carries no
   cursor" under NestJS. Clients that listen for a named `heartbeat` event
   would stop seeing it (GoGo-MobileApp only ignores it). Accept, or decide
   another mechanism (SA)?
2. `checkpoint` shape: SA specified `(generation, H)`; this contract adds an
   opaque `cursor` so clients never construct one. Confirm.
3. Correcting the `200` response schema to describe each frame type
   (`oneOf`) — separate decision, possibly breaking per oasdiff.
4. Deprecation dates in the table above.
