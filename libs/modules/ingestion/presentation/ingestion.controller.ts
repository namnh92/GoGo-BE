import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
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
  /**
   * #337 — the opaque proof returned by `POST /places/resolve-google-maps-link`.
   * Optional: a client that does not send one gets the old behaviour, which is
   * one more Google Details call.
   */
  resolutionToken: z.string().max(1024).optional(),
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
      resolutionToken: body.resolutionToken,
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

/**
 * PI-BE-031 (#528) — the GoGo-owned fields a reviewer may supplement.
 *
 * Deliberately the Place editor's own field rules, restated where the value is
 * written rather than re-derived: same lengths, same units, same nullability.
 * Nothing provider-owned is here — a rating or a review count cannot be typed
 * by a person, and opening hours keep their own editorial endpoint on the
 * place once it exists.
 */
const reviewDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).nullable(),
    addressText: z.string().max(500).nullable(),
    phone: z.string().max(40).nullable(),
    website: z.string().url().max(500).nullable(),
    avgVisitMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable(),
    suitability: z.record(z.string(), z.number().min(0).max(1)),
    taxonomyIds: z.array(z.string().uuid()).max(40),
    isLodging: z.boolean(),
    curatedRank: z.number().int().nullable(),
    // Integer minor units, like every other amount in the contract.
    priceMin: z.number().int().min(0).nullable(),
    priceMax: z.number().int().min(0).nullable(),
    priceUnit: z.enum(['per_person', 'per_item', 'per_hour', 'per_night']).nullable(),
  })
  .partial()
  .strict()
  .refine(
    (d) =>
      d.priceMin === undefined ||
      d.priceMax === undefined ||
      d.priceMin === null ||
      d.priceMax === null ||
      d.priceMax >= d.priceMin,
    { path: ['priceMax'], message: 'priceMax phải lớn hơn hoặc bằng priceMin' },
  );

const reviewSchema = z.object({
  draft: reviewDraftSchema,
  /**
   * The submission's `updatedAt` as the form was loaded. When it no longer
   * matches, another moderator has written since and this save is refused
   * rather than silently winning.
   */
  expectedUpdatedAt: z.string().datetime().optional(),
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

  /**
   * The queue lists; this is what a decision is actually made on. Stored facts
   * only — no provider request, so opening a submission costs nothing.
   */
  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.submissions.getSubmissionForReview(id);
  }

  /**
   * Google's current answer about this place, shown and discarded (#528).
   *
   * An action, not a side effect of opening a screen: it costs one `quality`
   * Details and is counted separately from the fetch approval makes. Open to
   * the same roles as the rest of the queue — a moderator cannot call
   * `POST /cms/places/resolve-link`, which needs `editor`, and moderating a
   * place you are not allowed to look at is not moderation.
   */
  @Post(':id/provider-preview')
  providerPreview(@Param('id', Uuid) id: string) {
    return this.submissions.providerPreview(id);
  }

  /**
   * Save what a reviewer supplemented. Decides nothing, creates no place.
   */
  @Put(':id/review')
  review(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: z.infer<typeof reviewSchema>,
  ) {
    return this.submissions.saveReview(actor.id, id, body.draft, body.expectedUpdatedAt);
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
