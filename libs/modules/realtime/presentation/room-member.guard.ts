import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Actor } from '../../identity/domain/actor';
import { RoomPolicy } from '../../rooms/presentation/room-policy';

/**
 * Membership check for the SSE route, as a guard rather than a check inside
 * the handler.
 *
 * `@Sse()` commits the response — status 200 and the event-stream headers —
 * before it subscribes, so a handler that throws afterwards cannot produce a
 * 403; a non-member got a successful stream that then errored. A guard runs
 * before any of that, which is the only place a refusal is still expressible
 * as an HTTP status.
 */
@Injectable()
export class RoomMemberGuard implements CanActivate {
  constructor(private readonly policy: RoomPolicy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const actor = request.actor;
    if (!actor) return false;
    const roomId = (request.params as { id?: string }).id;
    if (!roomId) return false;
    // Throws 403/404 with the same codes as every other room read.
    await this.policy.requireMember(actor, roomId);
    return true;
  }
}
