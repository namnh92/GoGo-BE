import type { PublishInput, SequencedRoomEvent } from '../domain/room-event';

export const ROOM_EVENT_BUS = Symbol('ROOM_EVENT_BUS');

/**
 * What a reconnecting subscriber gets back.
 *
 * `replay` are the events it missed, in order. `resync` is true when the
 * requested resume point is older than the buffer still holds — the client
 * must refetch, because the alternative is handing it a stream with a silent
 * hole in it.
 */
export type Subscription = {
  replay: SequencedRoomEvent[];
  resync: boolean;
  unsubscribe(): void;
};

export interface RoomEventBus {
  publish(input: PublishInput): Promise<SequencedRoomEvent>;
  /**
   * `afterSeq` is the `Last-Event-ID` the client reconnected with, or null on
   * a fresh connection (which replays nothing — the client just fetched).
   */
  subscribe(
    roomId: string,
    afterSeq: number | null,
    listener: (event: SequencedRoomEvent) => void,
  ): Promise<Subscription>;
}

/** Bounded on purpose: a resume buffer, not an event store. */
export const REPLAY_BUFFER_SIZE = 200;
