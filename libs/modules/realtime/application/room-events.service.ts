import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import { RoomPolicy } from '../../rooms/presentation/room-policy';
import {
  ROOM_EVENT_BUS,
  type ResyncNotice,
  type RoomEventBus,
  type Subscription,
  type SubscriptionSink,
} from './room-event-bus';
import { formatCursor, parseResumePoint } from '../domain/room-event-cursor';
import type { SequencedRoomEvent } from '../domain/room-event';

/**
 * Idle connections die in proxies. 20s is comfortably under the common 30–60s
 * idle timeouts and cheap: one comment line per connection per interval.
 */
export const KEEP_ALIVE_INTERVAL_MS = 20_000;

/**
 * One member on several devices is normal; one actor holding dozens of streams
 * is not. Each connection pins a socket and a Redis listener, so the cap is
 * about what a single account can make the server hold open.
 */
export const MAX_STREAMS_PER_ACTOR = 5;

/** What the SSE layer emits, in the framework's message shape. */
export type SseMessage =
  | { id?: string; type: string; data: string }
  /** Comment-only: written as `: <comment>`, never numbered by the framework. */
  | { comment: string };

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
   *
   * ADR-0027 order on the wire: `resync` (if the resume point cannot be
   * honoured) → replay → live. Live delivery starts only when `activate()` is
   * called after the replay has been handed to the stream.
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

    // Legacy numeric and malformed cursors are accepted and answered with
    // `resync`, never rejected and never treated as a fresh stream.
    const resume = parseResumePoint(lastEventId);
    this.streamsPerActor.set(actor.id, open + 1);

    return new Observable<SseMessage>((subscriber) => {
      let closed = false;
      let keepAlive: NodeJS.Timeout | undefined;
      let subscription: Subscription | undefined;

      const release = () => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        subscription?.unsubscribe();
        const remaining = (this.streamsPerActor.get(actor.id) ?? 1) - 1;
        if (remaining <= 0) this.streamsPerActor.delete(actor.id);
        else this.streamsPerActor.set(actor.id, remaining);
      };

      /*
       * Ending, not erroring: after the headers are out the framework turns an
       * error into an `event: error` frame with a numbered id, which a browser
       * EventSource would adopt as its resume point. A completed stream makes
       * the client reconnect and run the full attach protocol (ADR-0027 D5).
       */
      const terminate = () => {
        if (closed) return;
        release();
        subscriber.complete();
      };

      const sink: SubscriptionSink = {
        event: (event) => {
          if (!closed) subscriber.next(domainFrame(event));
        },
        resync: (notice) => {
          if (!closed) subscriber.next(resyncFrame(roomId, notice));
        },
        fail: terminate,
      };

      void this.bus
        .subscribe(roomId, resume, sink)
        .then((attached) => {
          if (closed) {
            attached.unsubscribe();
            return;
          }
          subscription = attached;
          if (attached.resync) sink.resync(attached.resync);
          for (const event of attached.replay) sink.event(event);

          keepAlive = setInterval(() => {
            if (!closed) subscriber.next({ comment: 'ping' });
          }, KEEP_ALIVE_INTERVAL_MS);
          // Node keeps the process alive for a pending timer; a keep-alive
          // must not be the reason a shutdown hangs.
          keepAlive.unref?.();

          attached.activate();
        })
        .catch(terminate);

      return release;
    });
  }
}

/** A domain event: its SSE `id` is the opaque resume cursor (ADR-0027). */
export function domainFrame(event: SequencedRoomEvent): SseMessage {
  return {
    id: formatCursor({ generation: event.generation, seq: event.seq }),
    type: event.event.event_type,
    data: JSON.stringify(event.event),
  };
}

/**
 * `resync` carries no SSE `id` (contract, ADR-0027): a client's resume point
 * moves only with domain events.
 *
 * The framework's `SseStream.writeMessage` assigns a per-connection counter to
 * every non-comment message whose `id` is nil, and a browser EventSource would
 * then resume with that counter. `id` is therefore pinned to `undefined` — the
 * framework's assignment is discarded — so the frame is written with no `id:`
 * line at all and EventSource keeps the last domain cursor. Guarded by the
 * "no numeric id on non-domain frames" tests against the real framework.
 */
export function resyncFrame(roomId: string, notice: ResyncNotice): SseMessage {
  const frame = {
    type: 'resync',
    data: JSON.stringify({
      roomId,
      reason: notice.reason,
      checkpoint: {
        cursor: formatCursor(notice.checkpoint),
        generation: notice.checkpoint.generation,
        seq: notice.checkpoint.seq,
      },
    }),
  };
  Object.defineProperty(frame, 'id', {
    get: () => undefined,
    set: () => undefined,
    enumerable: false,
  });
  return frame;
}
