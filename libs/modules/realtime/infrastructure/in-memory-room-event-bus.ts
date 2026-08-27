import { randomUUID } from 'node:crypto';
import {
  REPLAY_BUFFER_SIZE,
  type RoomEventBus,
  type Subscription,
} from '../application/room-event-bus';
import type { PublishInput, RoomEvent, SequencedRoomEvent } from '../domain/room-event';

type RoomState = {
  seq: number;
  buffer: SequencedRoomEvent[];
  listeners: Set<(event: SequencedRoomEvent) => void>;
  touchedAt: number;
};

/**
 * How long a room's sequence and replay buffer outlive the last connection.
 *
 * Dropping them the moment nobody is listening defeats the whole point: the
 * reconnect this endpoint exists for is exactly the one where the client was
 * *not* connected while things happened. Worse, a fresh state restarts the
 * sequence at 1, so a resuming client would be handed ids it had already seen.
 * Matches the Redis buffer TTL.
 */
export const ROOM_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Single-process bus: correct for dev, tests and a one-instance deployment,
 * and wrong for more than one api instance — a member connected to instance B
 * would never see an event published on instance A. The Redis bus is what
 * makes it multi-instance; this one is the fallback so the feature works
 * without Redis rather than half-working with it.
 */
export class InMemoryRoomEventBus implements RoomEventBus {
  private readonly rooms = new Map<string, RoomState>();

  private state(roomId: string): RoomState {
    this.prune();
    let state = this.rooms.get(roomId);
    if (!state) {
      state = { seq: 0, buffer: [], listeners: new Set(), touchedAt: Date.now() };
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
      if (state.listeners.size === 0 && state.touchedAt < cutoff) this.rooms.delete(roomId);
    }
  }

  async publish(input: PublishInput): Promise<SequencedRoomEvent> {
    const state = this.state(input.roomId);
    state.seq += 1;
    const sequenced: SequencedRoomEvent = {
      seq: state.seq,
      event: buildEvent(input),
    };
    state.buffer.push(sequenced);
    if (state.buffer.length > REPLAY_BUFFER_SIZE) state.buffer.shift();
    for (const listener of state.listeners) listener(sequenced);
    return sequenced;
  }

  async subscribe(
    roomId: string,
    afterSeq: number | null,
    listener: (event: SequencedRoomEvent) => void,
  ): Promise<Subscription> {
    const state = this.state(roomId);
    const oldest = state.buffer[0]?.seq ?? state.seq + 1;
    // A gap the buffer cannot cover is reported, never skipped.
    const resync = afterSeq !== null && afterSeq + 1 < oldest;
    const replay =
      afterSeq !== null && !resync ? state.buffer.filter((item) => item.seq > afterSeq) : [];

    state.listeners.add(listener);
    return {
      replay,
      resync,
      unsubscribe: () => {
        state.listeners.delete(listener);
        // Deliberately keeps the state: the room is pruned later, by idle age,
        // so a client that reconnects within the window can still resume.
        state.touchedAt = Date.now();
      },
    };
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
