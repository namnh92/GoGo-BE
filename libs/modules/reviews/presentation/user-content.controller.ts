import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
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
