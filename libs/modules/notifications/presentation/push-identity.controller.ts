import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { PushIdentityService } from '../application/push-identity.service';
import { PushSubscriptionsService } from '../application/push-subscriptions.service';

/**
 * NTF-BE-008 (#199) — `GET /v1/notifications/identity`.
 *
 * Deliberately takes nothing from the request but the actor the guard
 * resolved. A `userId` in the query or body is not read, so it cannot
 * influence the token (acceptance: FR-USER-014).
 */
/**
 * The OneSignal subscription id of the device asking. Only ever checked against
 * the caller's own user, so it cannot address anyone else's device.
 */
const confirmUnsubscribedSchema = z.object({ subscriptionId: z.string().min(1).max(64) });

@Controller('notifications')
export class PushIdentityController {
  constructor(
    private readonly identity: PushIdentityService,
    private readonly subscriptions: PushSubscriptionsService,
  ) {}

  @RateLimit({ action: 'notifications.identity', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Get('identity')
  issue(@CurrentActor() actor: Actor) {
    return this.identity.issue(actor);
  }

  /**
   * NTF-APP-004 (#160) — the client asks whether this device is really
   * unsubscribed before it clears the local session.
   *
   * A read, not a command: it disables nothing and deletes nothing. The user
   * read is the caller's own, taken from the guard-resolved actor, so no body
   * field can point it at another person's devices.
   */
  @RateLimit({ action: 'notifications.identity', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Post('identity/logout')
  async confirmUnsubscribed(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(confirmUnsubscribedSchema))
    body: z.infer<typeof confirmUnsubscribedSchema>,
  ) {
    const confirmation = await this.identity.confirmDeviceUnsubscribed(actor, body.subscriptionId);
    // NTF-BE-011 (#515): the provider has just agreed this device can no longer
    // be delivered to for this person, so they stop being reachable on it.
    // Only on a confirmation — a device that is still enabled stays in the
    // audience, and only the caller's own row is ever touched.
    if (confirmation.confirmed) await this.subscriptions.revoke(actor, body.subscriptionId);
    return confirmation;
  }
}
