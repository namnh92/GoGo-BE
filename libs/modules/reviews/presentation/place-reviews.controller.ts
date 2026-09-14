import { Controller, Get, Header, Param } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import { PlaceReviewsService } from '../application/place-reviews.service';

@Controller('places')
export class PlaceReviewsController {
  constructor(private readonly reviews: PlaceReviewsService) {}

  /**
   * BE-BFF-018 (#570). Public like Place Detail, with its own bucket so the two
   * reads a detail screen makes do not halve each other's budget. `no-store`
   * because a moderator's takedown must hold on the next read, not whenever an
   * intermediary's copy happens to expire.
   */
  @Public()
  @RateLimit({ action: 'places.reviews', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Header('cache-control', 'no-store')
  @Get(':id/reviews')
  latest(@Param('id', new ZodValidationPipe(z.string().uuid())) id: string) {
    return this.reviews.latest(id);
  }
}
