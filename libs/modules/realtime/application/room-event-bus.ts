import type { EventCursor, ResumePoint } from '../domain/room-event-cursor';
import type { PublishInput, SequencedRoomEvent } from '../domain/room-event';

export const ROOM_EVENT_BUS = Symbol('ROOM_EVENT_BUS');

/** Bounded on purpose: a resume buffer, not an event store. */
export const REPLAY_BUFFER_SIZE = 200;

/**
 * ADR-0027 D3 — live events held while a subscription is attaching, paused or
 * recovering. Bounded like the replay buffer; overflow enters recovery (and
 * `resync` if recovery cannot cover the gap), never a silent drop.
 */
export const LIVE_QUEUE_LIMIT = REPLAY_BUFFER_SIZE;

export type ResyncReason = 'replay_unavailable' | 'generation_changed' | 'invalid_or_legacy_cursor';

/**
 * The stream cannot honour the resume point exactly. `checkpoint` is the
 * room's position read atomically with that decision: the cursor that is valid
 * once the client has refetched.
 */
export type ResyncNotice = { reason: ResyncReason; checkpoint: EventCursor };

/**
 * Where a subscription delivers once active. Calls are synchronous and in
 * order; the SSE layer writes each one as a frame.
 */
export interface SubscriptionSink {
  event(event: SequencedRoomEvent): void;
  /** A gap found after activation (live gap, generation change, overflow). */
  resync(notice: ResyncNotice): void;
  /**
   * Terminal: delivery can no longer be guaranteed — the subscriber connection
   * was lost, or a recovery read failed. The stream must end so the client's
   * reconnect runs the full attach protocol (ADR-0027 D5). May be called while
   * `subscribe` is still pending.
   */
  fail(error: Error): void;
}

/**
 * A paused subscription (ADR-0027 D3). The caller emits `resync` (if any), then
 * `replay`, then calls `activate()`; only then does live delivery reach the
 * sink. Nothing is delivered between the snapshot and `activate()` — it is
 * queued and deduplicated against the replay.
 */
export type Subscription = {
  /** Contiguous `(cursor.seq, H]` of the current generation; empty on fresh or resync. */
  replay: SequencedRoomEvent[];
  /** Set when the resume point cannot be honoured exactly; `replay` is then empty. */
  resync: ResyncNotice | null;
  activate(): void;
  /** Idempotent. */
  unsubscribe(): void;
};

export interface RoomEventBus {
  /**
   * Never retried: an ambiguous result must not become a second publication
   * with a new event id (ADR-0027 D5).
   */
  publish(input: PublishInput): Promise<SequencedRoomEvent>;
  subscribe(roomId: string, resume: ResumePoint, sink: SubscriptionSink): Promise<Subscription>;
}
