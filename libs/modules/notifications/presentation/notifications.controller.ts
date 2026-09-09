import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { PushSubscriptionsService } from '../application/push-subscriptions.service';

const pushSubscriptionSchema = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  /**
   * OneSignal's subscription id for this device. Bounded like the one
   * `POST /notifications/identity/logout` already accepts, and never logged.
   */
  subscriptionId: z.string().min(1).max(64),
});

function requireUser(actor: Actor): string {
  if (actor.type !== 'user') throw AppError.forbidden('USER_ONLY', 'Login required');
  return actor.id;
}

@Controller('me')
export class NotificationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pushSubscriptions: PushSubscriptionsService,
  ) {}

  @Get('notifications')
  async list(@CurrentActor() actor: Actor, @Query('cursor') cursor?: string) {
    const userId = requireUser(actor);
    const before = cursor ? new Date(cursor) : null;
    const rows = await this.db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, userId),
          ...(before && !Number.isNaN(before.getTime())
            ? [lt(schema.notifications.createdAt, before)]
            : []),
        ),
      )
      .orderBy(desc(schema.notifications.createdAt))
      .limit(21);
    const page = rows.slice(0, 20);
    return {
      notifications: page.map((n) => ({
        id: n.id,
        kind: n.kind,
        payload: n.payload,
        readAt: n.readAt?.toISOString(),
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor: rows.length > 20 ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  }

  @Post('notifications/:id/read')
  async markRead(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
  ) {
    const userId = requireUser(actor);
    await this.db
      .update(schema.notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)));
    return { read: true };
  }

  /**
   * NTF-BE-011 (#515) — this device holds a live push subscription for me.
   *
   * Replaces `PUT /me/device-tokens`, which was the last thing in GoGo that
   * looked like an APNs/FCM registry (spec §26). It carried no weight either:
   * no screen ever called it, so the only rows it ever produced were the mobile
   * contract test's, and those rows were the entire audience of every campaign.
   *
   * The subscription id is checked against the provider before anything is
   * written — see `PushSubscriptionsService.register`.
   */
  @RateLimit({ action: 'me.push-subscriptions', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Put('push-subscriptions')
  registerPushSubscription(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(pushSubscriptionSchema))
    body: z.infer<typeof pushSubscriptionSchema>,
  ) {
    return this.pushSubscriptions.register(actor, body);
  }
}
