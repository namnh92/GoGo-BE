import { Controller, Headers, Inject, Param, Query, Sse, UseGuards } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { uuidSchema } from '../../rooms/presentation/dtos';
import { RoomEventsService, type SseMessage } from '../application/room-events.service';
import { RoomMemberGuard } from './room-member.guard';
import { REALTIME_ENABLED } from './realtime.tokens';

const UuidPipe = new ZodValidationPipe(uuidSchema);

@Controller('rooms')
export class RoomEventsController {
  constructor(
    private readonly events: RoomEventsService,
    @Inject(REALTIME_ENABLED) private readonly enabled: boolean,
  ) {}

  /**
   * #154 — room realtime. Server → client only, so SSE rather than a
   * WebSocket: nothing here is bidirectional, and this keeps the same bearer
   * auth as every other route.
   *
   * `Last-Event-ID` is the standard resume header; `lastEventId` is accepted
   * as a query parameter too, because EventSource in a browser cannot set
   * headers and would otherwise have no way to resume at all.
   */
  @UseGuards(RoomMemberGuard)
  @RateLimit({ action: 'rooms.events', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Sse(':id/events')
  stream(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Headers('last-event-id') headerId: string | undefined,
    @Query('lastEventId') queryId: string | undefined,
  ): Promise<Observable<SseMessage>> {
    if (!this.enabled) {
      // Not a 404: the route exists, the transport is off for this
      // environment. Clients are told to keep polling rather than to retry.
      throw new AppError(
        'REALTIME_DISABLED',
        'Realtime streaming is disabled in this environment; poll instead',
        503,
      );
    }
    return this.events.stream(actor, id, headerId ?? queryId ?? null);
  }
}

export { REALTIME_ENABLED };
