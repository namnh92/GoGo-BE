import { Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import {
  CurrentActor,
  RateLimit,
  type RateLimitSpec,
} from '../../identity/presentation/decorators';
import { ReviewReactionsService } from '../application/review-reactions.service';

const Uuid = new ZodValidationPipe(z.string().uuid());

/**
 * ADR-0026 (PROPOSAL). Idempotency already makes repetition harmless; this
 * bounds churn — an hourly cap, and a burst window so the hour cannot be spent
 * by a script in seconds. Add and remove share one bucket.
 */
const REACT_LIMIT: RateLimitSpec = {
  action: 'reviews.react',
  limit: 120,
  windowSeconds: 3600,
  burst: { limit: 30, windowSeconds: 60 },
  keyBy: 'actor',
};

/** BE-BFF-019 (#571) — `helpful` reactions on published reviews. */
@Controller()
export class ReviewReactionsController {
  constructor(private readonly reactions: ReviewReactionsService) {}

  @RateLimit(REACT_LIMIT)
  @Put('reviews/:id/reactions/helpful')
  mark(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.reactions.set(actor, id, true);
  }

  @RateLimit(REACT_LIMIT)
  @Delete('reviews/:id/reactions/helpful')
  unmark(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.reactions.set(actor, id, false);
  }

  @Get('me/review-reactions')
  mine(@CurrentActor() actor: Actor, @Query('placeId', Uuid) placeId: string) {
    return this.reactions.mine(actor, placeId);
  }
}
