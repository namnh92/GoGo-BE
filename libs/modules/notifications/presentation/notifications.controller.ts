import { NOTIFICATION_KINDS, type NotificationKind } from '../domain/notification-registry';
import { Body, Controller, Get, Headers, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { ManualIdempotency, idempotencyScope } from '../../shared/idempotency.interceptor';
import { NotificationInboxService } from '../application/notification-inbox.service';
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
    private readonly inbox: NotificationInboxService,
    private readonly pushSubscriptions: PushSubscriptionsService,
  ) {}

  @Get('notifications')
  list(
    @CurrentActor() actor: Actor,
    @Query('cursor', new ZodValidationPipe(z.string().max(2048).optional())) cursor?: string,
    @Query(
      'kinds',
      new ZodValidationPipe(
        z.preprocess(
          (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]),
          z.array(z.enum(NOTIFICATION_KINDS as [NotificationKind, ...NotificationKind[]])).max(100),
        ),
      ),
    )
    kinds: NotificationKind[] = [],
  ) {
    return this.inbox.list(requireUser(actor), cursor, kinds);
  }

  @Get('notifications/summary')
  summary(@CurrentActor() actor: Actor, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'private, no-store');
    return this.inbox.summary(requireUser(actor));
  }

  @ManualIdempotency()
  @RateLimit({ action: 'me.notifications.read-all', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Post('notifications/read-all')
  async readAll(
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(z.object({ through: z.string().min(1).max(2048) }).strict()))
    body: { through: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const userId = requireUser(actor);
    const scope = idempotencyScope(Object.assign(req, { actor }), key ?? '');
    const result = await this.inbox.readAll(userId, body.through, scope);
    reply.code(result.status).header('Cache-Control', 'private, no-store');
    if (result.status === 202)
      reply.header('Location', `/v1/me/notifications/read-all/${result.body.operationId}`);
    return result.body;
  }

  @Get('notifications/read-all/:operationId')
  operation(
    @CurrentActor() actor: Actor,
    @Param('operationId', new ZodValidationPipe(z.string().uuid())) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.inbox.operation(requireUser(actor), id);
  }

  @Post('notifications/:id/read')
  markRead(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
  ) {
    return this.inbox.markRead(requireUser(actor), id);
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
