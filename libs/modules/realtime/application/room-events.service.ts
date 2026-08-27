import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import { RoomPolicy } from '../../rooms/presentation/room-policy';
import { ROOM_EVENT_BUS, type RoomEventBus } from './room-event-bus';
import type { SequencedRoomEvent } from '../domain/room-event';

/**
 * Idle connections die in proxies. 20s is comfortably under the common 30–60s
 * idle timeouts and cheap: one small frame per connection per interval.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * One member on several devices is normal; one actor holding dozens of streams
 * is not. Each connection pins a socket and a Redis listener, so the cap is
 * about what a single account can make the server hold open.
 */
export const MAX_STREAMS_PER_ACTOR = 5;

/** What the SSE layer emits, in the framework's message shape. */
export type SseMessage = { id?: string; type: string; data: string };

@Injectable()
export class RoomEventsService {
  private readonly streamsPerActor = new Map<string, number>();

  constructor(
    private readonly policy: RoomPolicy,
    @Inject(ROOM_EVENT_BUS) private readonly bus: RoomEventBus,
  ) {}

  /**
   * Authorized exactly like `GET /rooms/{id}`: members only, and a guest token
   * reaches only the room it is bound to.
   *
   * `RoomMemberGuard` already refused a non-member before the response was
   * committed; this repeats the check because the stream is what actually
   * carries other members' activity, and the cost of re-asking is one query
   * per connection.
   */
  async stream(
    actor: Actor,
    roomId: string,
    lastEventId: string | null,
  ): Promise<Observable<SseMessage>> {
    await this.policy.requireMember(actor, roomId);

    const open = this.streamsPerActor.get(actor.id) ?? 0;
    if (open >= MAX_STREAMS_PER_ACTOR) {
      throw AppError.tooManyRequests('Too many open event streams for this session');
    }

    const afterSeq = parseLastEventId(lastEventId);
    this.streamsPerActor.set(actor.id, open + 1);

    return new Observable<SseMessage>((subscriber) => {
      let closed = false;
      let heartbeat: NodeJS.Timeout | undefined;
      let unsubscribe: (() => void) | undefined;

      const release = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        const remaining = (this.streamsPerActor.get(actor.id) ?? 1) - 1;
        if (remaining <= 0) this.streamsPerActor.delete(actor.id);
        else this.streamsPerActor.set(actor.id, remaining);
      };

      void this.bus
        .subscribe(roomId, afterSeq, (event) => {
          if (!closed) subscriber.next(toMessage(event));
        })
        .then((subscription) => {
          if (closed) {
            subscription.unsubscribe();
            return;
          }
          unsubscribe = subscription.unsubscribe;

          if (subscription.resync) {
            // The gap is wider than the buffer. Say so; a client that refetches
            // is correct, a client that resumes into a hole is silently wrong.
            subscriber.next({
              type: 'resync',
              data: JSON.stringify({
                reason: 'replay_window_exceeded',
                roomId,
              }),
            });
          }
          for (const event of subscription.replay) subscriber.next(toMessage(event));

          heartbeat = setInterval(() => {
            subscriber.next({ type: 'heartbeat', data: '{}' });
          }, HEARTBEAT_INTERVAL_MS);
          // Node keeps the process alive for a pending timer; a heartbeat must
          // not be the reason a shutdown hangs.
          heartbeat.unref?.();
        })
        .catch((error: unknown) => {
          release();
          subscriber.error(error);
        });

      return release;
    });
  }
}

function toMessage(event: SequencedRoomEvent): SseMessage {
  // `id:` is the per-room sequence, which is what the client hands back as
  // Last-Event-ID. The event's own uuid stays in the payload for correlation.
  return {
    id: String(event.seq),
    type: event.event.event_type,
    data: JSON.stringify(event.event),
  };
}

/** A malformed resume point starts a fresh stream rather than failing it. */
export function parseLastEventId(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
