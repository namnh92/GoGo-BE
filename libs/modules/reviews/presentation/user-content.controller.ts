import { setStrongEtagHeaders } from '../../shared/strong-etag-headers';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validTimezone } from '../../notifications/domain/quiet-hours';
import { ManualIdempotency, idempotencyScope } from '../../shared/idempotency.interceptor';
import {
  settingsEtag,
  type SettingsPatch,
} from '../../notifications/application/category-preferences';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Headers,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { UserContentService } from '../application/user-content.service';

const UuidPipe = new ZodValidationPipe(z.string().uuid());
const TargetTypePipe = new ZodValidationPipe(z.enum(['place', 'plan']));

const reviewSchema = z
  .object({
    placeId: z.string().uuid().optional(),
    planId: z.string().uuid().optional(),
    rating: z.number().int().min(1).max(5),
    text: z.string().max(2000).optional(),
  })
  .refine((v) => (v.placeId !== undefined) !== (v.planId !== undefined), {
    message: 'exactly one of placeId/planId',
    path: ['placeId'],
  });
type ReviewDto = z.infer<typeof reviewSchema>;

const reviewPatchSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  text: z.string().max(2000).optional(),
});

/** NTF-BE-014 (#572) — the one push switch; nothing else is accepted. */
const categoryPatch = z
  .object({
    invite: z.boolean().optional(),
    preference_reminder: z.boolean().optional(),
    plan_ready: z.boolean().optional(),
    plan_changed: z.boolean().optional(),
    date_reminder: z.boolean().optional(),
  })
  .strict();
const settingsPatch = z
  .object({
    pushEnabled: z.boolean().optional(),
    categories: categoryPatch.optional(),
    quietHours: z
      .object({
        enabled: z.boolean().optional(),
        timezone: z
          .string()
          .min(1)
          .max(100)
          .refine(validTimezone, 'IANA timezone required')
          .optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, 'At least one quiet-hour change required')
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.pushEnabled !== undefined ||
      Object.keys(v.categories ?? {}).length > 0 ||
      v.quietHours !== undefined,
    'At least one change required',
  );
const notifSettingsSchema = z.object({ pushEnabled: z.boolean() }).strict();

// eslint-disable-next-line no-useless-assignment -- used in decorator below
const notifPrefSchema = z.object({
  channel: z.enum(['push', 'email']),
  kind: z.enum([
    'invite',
    'preference_reminder',
    'plan_ready',
    'plan_changed',
    'date_reminder',
    'moderation_update',
  ]),
  enabled: z.boolean(),
});

@Controller()
export class UserContentController {
  constructor(private readonly service: UserContentService) {}

  @Get('me/saved')
  listSaved(@CurrentActor() actor: Actor) {
    return this.service.listSaved(actor);
  }

  @Put('me/saved/:type/:id')
  save(
    @CurrentActor() actor: Actor,
    @Param('type', TargetTypePipe) type: 'place' | 'plan',
    @Param('id', UuidPipe) id: string,
  ) {
    return this.service.save(actor, type, id);
  }

  @Delete('me/saved/:type/:id')
  unsave(
    @CurrentActor() actor: Actor,
    @Param('type', TargetTypePipe) type: 'place' | 'plan',
    @Param('id', UuidPipe) id: string,
  ) {
    return this.service.unsave(actor, type, id);
  }

  @RateLimit({ action: 'reviews.create', limit: 10, windowSeconds: 60, keyBy: 'actor' })
  @Post('reviews')
  createReview(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(reviewSchema)) body: ReviewDto,
  ) {
    return this.service.createReview(actor, body);
  }

  @Patch('reviews/:id')
  updateReview(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(reviewPatchSchema)) body: { rating?: number; text?: string },
  ) {
    return this.service.updateReview(actor, id, body);
  }

  @Get('me/reviews')
  myReviews(@CurrentActor() actor: Actor) {
    return this.service.myReviews(actor);
  }

  /** Privacy rule: users can export their data… */
  @RateLimit({ action: 'me.export', limit: 3, windowSeconds: 3600, keyBy: 'actor' })
  @Get('me/export')
  exportData(@CurrentActor() actor: Actor) {
    return this.service.exportData(actor);
  }

  /** …and delete their account. */
  @Delete('me')
  deleteAccount(@CurrentActor() actor: Actor) {
    return this.service.deleteAccount(actor);
  }

  /** ADR-0050 — versioned master plus five independent category preferences. */
  @Get('me/notification-settings')
  async notificationSettings(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.service.getNotificationSettings(actor);
    setStrongEtagHeaders(reply, settingsEtag(result.version));
    return result;
  }

  @ManualIdempotency()
  @Patch('me/notification-settings')
  async patchNotificationSettings(
    @CurrentActor() actor: Actor,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(settingsPatch)) body: SettingsPatch,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.service.patchNotificationSettings(
      actor,
      body,
      ifMatch,
      idempotencyScope(Object.assign(req, { actor }), key ?? ''),
    );
    setStrongEtagHeaders(reply, settingsEtag(result.version));
    return result;
  }

  @Put('me/notification-settings')
  async setNotificationSettings(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(notifSettingsSchema)) body: { pushEnabled: boolean },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.service.setNotificationSettings(actor, body);
    setStrongEtagHeaders(reply, settingsEtag(result.version));
    return result;
  }

  @Get('me/notification-preferences')
  notificationPreferences(@CurrentActor() actor: Actor) {
    return this.service.getNotificationPreferences(actor);
  }

  @Put('me/notification-preferences')
  setNotificationPreference(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(notifPrefSchema))
    body: { channel: 'push' | 'email'; kind: string; enabled: boolean },
  ) {
    return this.service.setNotificationPreference(
      actor,
      body as { channel: 'push' | 'email'; kind: string; enabled: boolean },
    );
  }
}
