import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Public, RateLimit } from '../../identity/presentation/decorators';
import { RequireRole } from '../../cms/presentation/admin.guard';
import { PlaceSubmissionService } from '../application/place-submission.service';

const Uuid = new ZodValidationPipe(z.string().uuid());

const resolveSchema = z.object({
  url: z.string().trim().url().max(2000),
  cityHint: z.string().trim().max(80).optional(),
  roomId: z.string().uuid().optional(),
});

const submitSchema = z.object({
  googlePlaceId: z.string().trim().min(5).max(255),
  roomId: z.string().uuid().optional(),
  category: z.string().trim().max(64).optional(),
  estimatedPrice: z
    .object({
      min: z.number().int().min(0),
      max: z.number().int().min(0),
      unit: z
        .enum(['per_person', 'per_group', 'per_item', 'free', 'unknown'])
        .default('per_person'),
    })
    .optional(),
  vibes: z.array(z.string().max(40)).max(10).default([]),
  note: z.string().max(1000).optional(),
});
type SubmitDto = z.infer<typeof submitSchema>;

/** PI-BE-018/019 — Mobile add-by-link (FR-INGEST-010..012). */
@Controller()
export class IngestionController {
  constructor(private readonly submissions: PlaceSubmissionService) {}

  /**
   * Resolve is preview-only, so it stays public for the search empty state —
   * but rate-limited hard because every call may cost a provider request.
   */
  @Public()
  @RateLimit({ action: 'places.resolve_link', limit: 10, windowSeconds: 60, keyBy: 'ip' })
  @Post('places/resolve-google-maps-link')
  resolve(@Body(new ZodValidationPipe(resolveSchema)) body: z.infer<typeof resolveSchema>) {
    return this.submissions.resolveLink({ url: body.url, cityHint: body.cityHint });
  }

  @RateLimit({ action: 'places.submit', limit: 5, windowSeconds: 60, keyBy: 'ip+actor' })
  @Post('place-submissions')
  submit(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(submitSchema)) body: SubmitDto) {
    return this.submissions.submit(actor, {
      googlePlaceId: body.googlePlaceId,
      roomId: body.roomId,
      categoryKey: body.category,
      priceMin: body.estimatedPrice?.min,
      priceMax: body.estimatedPrice?.max,
      priceUnit: body.estimatedPrice?.unit,
      vibeKeys: body.vibes,
      note: body.note,
    });
  }

  @Get('place-submissions/:id')
  get(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.submissions.getSubmission(actor, id);
  }
}

const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'merged']),
  reason: z.string().trim().min(3).max(500),
  mergeIntoPlaceId: z.string().uuid().optional(),
});

const submissionListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'merged']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

/** PI-CMS-007 backend — moderation queue actions for mobile submissions. */
@RequireRole('moderator', 'editor')
@Controller('cms/place-submissions')
export class CmsSubmissionController {
  constructor(private readonly submissions: PlaceSubmissionService) {}

  /**
   * The decide endpoint existed with nothing to list what to decide on, so a
   * moderator had no way to find a submission at all.
   */
  @Get()
  list(
    @Query(new ZodValidationPipe(submissionListQuery))
    query: z.infer<typeof submissionListQuery>,
  ) {
    return this.submissions.listSubmissions(query);
  }

  @Post(':id/decide')
  decide(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ) {
    return this.submissions.decide(actor.id, id, body.decision, body.reason, body.mergeIntoPlaceId);
  }
}
