import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { PlansService } from '../application/plans.service';

const UuidPipe = new ZodValidationPipe(z.string().uuid());

const editStopsSchema = z.object({
  expectedVersion: z.number().int().min(1),
  stops: z
    .array(
      z.object({
        placeId: z.string().uuid(),
        durationMinutes: z
          .number()
          .int()
          .min(10)
          .max(12 * 60)
          .optional(),
        isLocked: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(8),
});
type EditStopsDto = z.infer<typeof editStopsSchema>;

const regenerateSchema = z.object({
  excludePlaceIds: z.array(z.string().uuid()).max(20).optional(),
  /**
   * SG-009 — the member's own words. Turned into structured constraints by
   * the feedback parser, validated against the candidate allowlist and the
   * room's constraints, and only then handed to the deterministic pipeline.
   */
  feedbackText: z.string().min(1).max(500).optional(),
});

const lockSchema = z.object({ locked: z.boolean() });

const checkinSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    tags: z.array(z.string().max(40)).max(10).default([]),
    note: z.string().max(1000).optional(),
    photoKeys: z.array(z.string().max(300)).max(3).default([]),
    billTotal: z.number().int().min(0).optional(),
    billPeopleCount: z.number().int().min(1).max(50).optional(),
    billPhotoKey: z.string().max(300).optional(),
  })
  .refine((v) => v.billTotal === undefined || v.billPhotoKey !== undefined, {
    message: 'billPhotoKey is required when billTotal is provided',
    path: ['billPhotoKey'],
  });
type CheckinDto = z.infer<typeof checkinSchema>;

@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get('rooms/:roomId/plans/current')
  currentForRoom(@CurrentActor() actor: Actor, @Param('roomId', UuidPipe) roomId: string) {
    return this.plans.getCurrentForRoom(actor, roomId);
  }

  @Get('plans/:id')
  get(@CurrentActor() actor: Actor, @Param('id', UuidPipe) id: string) {
    return this.plans.getPlan(actor, id);
  }

  @Patch('plans/:id')
  edit(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(editStopsSchema)) body: EditStopsDto,
  ) {
    return this.plans.editStops(actor, id, body);
  }

  @RateLimit({ action: 'plans.regenerate', limit: 6, windowSeconds: 60, keyBy: 'actor' })
  @Post('plans/:id/regenerate')
  regenerate(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(regenerateSchema))
    body: { excludePlaceIds?: string[]; feedbackText?: string },
  ) {
    return this.plans.regenerate(actor, id, body);
  }

  @Patch('plans/:id/stops/:stopId/lock')
  lock(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('stopId', UuidPipe) stopId: string,
    @Body(new ZodValidationPipe(lockSchema)) body: { locked: boolean },
  ) {
    return this.plans.lockStop(actor, id, stopId, body.locked);
  }

  @Post('plans/:id/stops/:stopId/complete')
  complete(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('stopId', UuidPipe) stopId: string,
  ) {
    return this.plans.completeStop(actor, id, stopId);
  }

  /** FR-PLAN-008/009 — check-in; photo upload keys come from the media flow. */
  @Post('plans/:id/stops/:stopId/checkin')
  checkin(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('stopId', UuidPipe) stopId: string,
    @Body(new ZodValidationPipe(checkinSchema)) body: CheckinDto,
  ) {
    return this.plans.checkin(actor, id, stopId, body);
  }
}
