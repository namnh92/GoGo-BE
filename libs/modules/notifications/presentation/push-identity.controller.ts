import { Controller, Get } from '@nestjs/common';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { PushIdentityService } from '../application/push-identity.service';

/**
 * NTF-BE-008 (#199) — `GET /v1/notifications/identity`.
 *
 * Deliberately takes nothing from the request but the actor the guard
 * resolved. A `userId` in the query or body is not read, so it cannot
 * influence the token (acceptance: FR-USER-014).
 */
@Controller('notifications')
export class PushIdentityController {
  constructor(private readonly identity: PushIdentityService) {}

  @RateLimit({ action: 'notifications.identity', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Get('identity')
  issue(@CurrentActor() actor: Actor) {
    return this.identity.issue(actor);
  }
}
