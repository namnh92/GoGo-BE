import type { EventCursor, ResumePoint } from '../domain/room-event-cursor';
import type { SequencedRoomEvent } from '../domain/room-event';
import {
  LIVE_QUEUE_LIMIT,
  type ResyncNotice,
  type ResyncReason,
  type SubscriptionSink,
} from './room-event-bus';

/**
 * One atomic read of a room's position (ADR-0027 D3): the generation, the
 * high-water mark `high` (highest sequence published in it, 0 if none), and
 * the retained events after the requested point — only when the requested
 * generation is the current one.
 */
export type RoomSnapshot = { generation: string; high: number; events: SequencedRoomEvent[] };

/** Reads a snapshot after `after` (null: position only, no events). */
export type SnapshotReader = (after: EventCursor | null) => Promise<RoomSnapshot>;

export type ResumeDecision = { replay: SequencedRoomEvent[]; resync: ResyncNotice | null };

/**
 * ADR-0027 D2/D5 — the attach decision, as a pure function of the resume
 * point and one atomic snapshot. Generation is compared before any sequence;
 * a cursor ahead of the server is invalid; any missing sequence in
 * `(cursor.seq, high]` is a resync, never a partial replay.
 */
export function decideResume(resume: ResumePoint, snapshot: RoomSnapshot): ResumeDecision {
  const checkpoint = { generation: snapshot.generation, seq: snapshot.high };
  const resync = (reason: ResyncReason): ResumeDecision => ({
    replay: [],
    resync: { reason, checkpoint },
  });
  if (resume.kind === 'fresh') return { replay: [], resync: null };
  if (resume.kind === 'invalid') return resync('invalid_or_legacy_cursor');
  const { cursor } = resume;
  if (cursor.generation !== snapshot.generation) return resync('generation_changed');
  if (cursor.seq > snapshot.high) return resync('invalid_or_legacy_cursor');
  const replay = contiguousRange(snapshot, cursor.seq);
  return replay ? { replay, resync: null } : resync('replay_unavailable');
}

/** `(after, high]` of the snapshot's generation, complete and in order — or null. */
export function contiguousRange(
  snapshot: RoomSnapshot,
  after: number,
): SequencedRoomEvent[] | null {
  const wanted = snapshot.high - after;
  if (wanted < 0) return null;
  if (wanted === 0) return [];
  const bySeq = new Map<number, SequencedRoomEvent>();
  for (const event of snapshot.events) {
    if (event.generation !== snapshot.generation) continue;
    if (event.seq > after && event.seq <= snapshot.high) bySeq.set(event.seq, event);
  }
  if (bySeq.size !== wanted) return null;
  const out: SequencedRoomEvent[] = [];
  for (let seq = after + 1; seq <= snapshot.high; seq++) {
    const event = bySeq.get(seq);
    if (!event) return null;
    out.push(event);
  }
  return out;
}

type Phase = 'attaching' | 'paused' | 'active' | 'recovering' | 'closed';

/**
 * ADR-0027 D3 — the replay/live handoff for one stream, transport-agnostic.
 *
 * The transport installs this *before* SUBSCRIBE and feeds every live message
 * to `push`. Until `activate()` everything is queued (bounded). Ordering never
 * depends on promise or microtask scheduling: delivery happens only in
 * `activate()` and in `push` while active, both synchronous; a recovery read
 * flips the phase to `recovering` first, so anything arriving meanwhile queues.
 *
 * Dedupe: the attach replay's `event_id`s are kept for the subscription's
 * whole life (≤ 200, never deleted on first duplicate), plus the delivered
 * high-water mark of the current generation for any older copy (F-05).
 */
export class RoomSubscription {
  private phase: Phase = 'attaching';
  private queue: SequencedRoomEvent[] = [];
  private overflowed = false;
  private readonly replayIds = new Set<string>();
  /** Generations an authoritative read showed are not current; their copies drop. */
  private readonly retired = new Set<string>();
  private generation = '';
  private delivered = 0;

  constructor(
    private readonly sink: SubscriptionSink,
    private readonly read: SnapshotReader,
  ) {}

  get closed(): boolean {
    return this.phase === 'closed';
  }

  /** Test seam: how much memory this subscription holds. */
  get footprint(): { queued: number; replayIds: number } {
    return { queued: this.queue.length, replayIds: this.replayIds.size };
  }

  /** A live message from the transport. */
  push(event: SequencedRoomEvent): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'active') this.process(event);
    else this.enqueue(event);
  }

  /**
   * Applies the attach snapshot; the subscription is then paused. Returns
   * what the caller emits before `activate()`.
   */
  begin(resume: ResumePoint, snapshot: RoomSnapshot): ResumeDecision {
    const decision = decideResume(resume, snapshot);
    this.generation = snapshot.generation;
    // Every outcome continues live after `high`. A fresh stream's attach point
    // is the snapshot: it delivers what is published after it. (A position
    // from the SUBSCRIBE ACK instead would depend on which of two sockets —
    // subscriber or commands — answered first.)
    this.delivered = snapshot.high;
    for (const event of decision.replay) this.replayIds.add(event.event.event_id);
    if (this.phase === 'attaching') this.phase = 'paused';
    return decision;
  }

  activate(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'active';
    if (this.overflowed) {
      this.overflowed = false;
      this.queue = [];
      this.recover();
      return;
    }
    const pending = this.queue;
    this.queue = [];
    for (let i = 0; i < pending.length; i++) {
      if (this.phase !== 'active') {
        // A gap or a generation change mid-drain: the rest waits for recovery.
        for (const rest of pending.slice(i)) this.enqueue(rest);
        return;
      }
      this.process(pending[i]!);
    }
  }

  fail(error: Error): void {
    if (this.phase === 'closed') return;
    this.close();
    this.sink.fail(error);
  }

  close(): void {
    this.phase = 'closed';
    this.queue = [];
  }

  private enqueue(event: SequencedRoomEvent): void {
    if (this.overflowed) return;
    if (this.queue.length >= LIVE_QUEUE_LIMIT) {
      // Never a silent drop: activation runs a recovery read instead of the
      // queue, and that read either covers the gap or reports `resync`.
      this.overflowed = true;
      this.queue = [];
      return;
    }
    this.queue.push(event);
  }

  private process(event: SequencedRoomEvent): void {
    if (this.replayIds.has(event.event.event_id)) return;
    if (event.generation !== this.generation) {
      if (this.retired.has(event.generation)) return;
      // Unexplained generation: only an authoritative metadata read decides.
      this.enqueue(event);
      this.recover();
      return;
    }
    if (event.seq <= this.delivered) return;
    if (event.seq === this.delivered + 1) {
      this.delivered = event.seq;
      this.sink.event(event);
      return;
    }
    // A live gap: pause delivery and fill it from the buffer.
    this.enqueue(event);
    this.recover();
  }

  private recover(): void {
    if (this.phase !== 'active') return;
    this.phase = 'recovering';
    const from = { generation: this.generation, seq: this.delivered };
    this.read(from).then(
      (snapshot) => {
        if (this.phase !== 'recovering') return;
        const checkpoint = { generation: snapshot.generation, seq: snapshot.high };
        if (snapshot.generation !== this.generation) {
          this.retired.add(this.generation);
          this.generation = snapshot.generation;
          this.delivered = snapshot.high;
          this.sink.resync({ reason: 'generation_changed', checkpoint });
        } else {
          const missing = contiguousRange(snapshot, this.delivered);
          if (missing) {
            for (const event of missing) {
              this.delivered = event.seq;
              if (!this.replayIds.has(event.event.event_id)) this.sink.event(event);
            }
          } else {
            this.delivered = snapshot.high;
            this.sink.resync({ reason: 'replay_unavailable', checkpoint });
          }
        }
        // After an authoritative read, a queued copy from any other generation
        // is from a superseded one.
        for (const queued of this.queue) {
          if (queued.generation !== this.generation) this.retired.add(queued.generation);
        }
        this.phase = 'paused';
        this.activate();
      },
      (error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))),
    );
  }
}
