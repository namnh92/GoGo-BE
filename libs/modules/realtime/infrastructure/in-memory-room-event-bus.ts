import { randomUUID } from 'node:crypto';
import {
  REPLAY_BUFFER_SIZE,
  type RoomEventBus,
  type Subscription,
  type SubscriptionSink,
} from '../application/room-event-bus';
import { RoomSubscription, type RoomSnapshot } from '../application/room-subscription';
import type { EventCursor, ResumePoint } from '../domain/room-event-cursor';
import type { PublishInput, RoomEvent, SequencedRoomEvent } from '../domain/room-event';

type RoomState = {
  /** ADR-0027 D2 — a pruned and recreated room is a new generation. */
  generation: string;
  seq: number;
  buffer: SequencedRoomEvent[];
  subscriptions: Set<RoomSubscription>;
  touchedAt: number;
};

/**
 * How long a room's sequence and replay buffer outlive the last connection.
 *
 * Dropping them the moment nobody is listening defeats the whole point: the
 * reconnect this endpoint exists for is exactly the one where the client was
 * *not* connected while things happened. When a room is pruned anyway, its
 * next state starts a new generation, so a resuming client is told
 * (`generation_changed`) instead of handed reused sequence numbers.
 * Matches the Redis buffer TTL.
 */
export const ROOM_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Single-process bus: correct for dev, tests and a one-instance deployment,
 * and wrong for more than one api instance — a member connected to instance B
 * would never see an event published on instance A. The Redis bus is what
 * makes it multi-instance; this one is the fallback so the feature works
 * without Redis rather than half-working with it. Same attach protocol and
 * subscription state machine as the Redis bus (ADR-0027).
 */
export class InMemoryRoomEventBus implements RoomEventBus {
  private readonly rooms = new Map<string, RoomState>();

  private state(roomId: string): RoomState {
    this.prune();
    let state = this.rooms.get(roomId);
    if (!state) {
      state = {
        generation: randomUUID(),
        seq: 0,
        buffer: [],
        subscriptions: new Set(),
        touchedAt: Date.now(),
      };
      this.rooms.set(roomId, state);
    }
    state.touchedAt = Date.now();
    return state;
  }

  /**
   * Lazy expiry rather than a timer: a background interval would keep the
   * process alive and has to be torn down on shutdown, for a map that is only
   * ever read here.
   */
  private prune(): void {
    const cutoff = Date.now() - ROOM_STATE_TTL_MS;
    for (const [roomId, state] of this.rooms) {
      if (state.subscriptions.size === 0 && state.touchedAt < cutoff) this.rooms.delete(roomId);
    }
  }

  /** Test seam: what a Redis metadata reset does — the next state is a new generation. */
  resetRoom(roomId: string): void {
    const state = this.rooms.get(roomId);
    this.rooms.delete(roomId);
    if (state && state.subscriptions.size > 0) {
      const next = this.state(roomId);
      for (const subscription of state.subscriptions) next.subscriptions.add(subscription);
    }
  }

  async publish(input: PublishInput): Promise<SequencedRoomEvent> {
    const state = this.state(input.roomId);
    state.seq += 1;
    const sequenced: SequencedRoomEvent = {
      generation: state.generation,
      seq: state.seq,
      event: buildEvent(input),
    };
    state.buffer.push(sequenced);
    if (state.buffer.length > REPLAY_BUFFER_SIZE) state.buffer.shift();
    for (const subscription of [...state.subscriptions]) subscription.push(sequenced);
    return sequenced;
  }

  async subscribe(
    roomId: string,
    resume: ResumePoint,
    sink: SubscriptionSink,
  ): Promise<Subscription> {
    const read = async (after: EventCursor | null) => this.snapshot(roomId, after);
    const subscription = new RoomSubscription(sink, read);
    const state = this.state(roomId);
    state.subscriptions.add(subscription);
    const after = resume.kind === 'cursor' ? resume.cursor : null;
    const decision = subscription.begin(resume, this.snapshot(roomId, after));
    let released = false;
    return {
      ...decision,
      activate: () => subscription.activate(),
      unsubscribe: () => {
        if (released) return;
        released = true;
        subscription.close();
        const current = this.rooms.get(roomId);
        current?.subscriptions.delete(subscription);
        // Deliberately keeps the state: the room is pruned later, by idle age,
        // so a client that reconnects within the window can still resume.
        if (current) current.touchedAt = Date.now();
      },
    };
  }

  private snapshot(roomId: string, after: EventCursor | null): RoomSnapshot {
    const state = this.state(roomId);
    const events =
      after && after.generation === state.generation
        ? state.buffer.filter((item) => item.seq > after.seq)
        : [];
    return { generation: state.generation, high: state.seq, events };
  }
}

export function buildEvent(input: PublishInput): RoomEvent {
  return {
    event_id: randomUUID(),
    event_type: input.type,
    event_version: 1,
    occurred_at: new Date().toISOString(),
    actor_id: input.actorId ?? null,
    resource_type: input.resourceType ?? 'room',
    resource_id: input.resourceId ?? input.roomId,
    correlation_id: input.correlationId ?? null,
    payload_schema_version: 1,
    payload: input.payload ?? {},
  };
}
