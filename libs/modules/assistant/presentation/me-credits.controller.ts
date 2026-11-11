import { Controller, Get, Header, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AssistantCreditsService } from '../application/assistant-credits.service';

export const creditHistoryQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .refine((value) => value === 10)
      .default(10),
    // Decode in the use case so every malformed cursor uses INVALID_CURSOR.
    cursor: z.string().optional(),
  })
  .strict();

@Controller('me/credits')
export class MeCreditsController {
  constructor(private readonly credits: AssistantCreditsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @RateLimit({ action: 'me.credits', limit: 60, windowSeconds: 60, keyBy: 'actor' })
  summary(@CurrentActor() actor: Actor) {
    return this.credits.summary(actor);
  }

  @Get('ledger')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit({ action: 'me.credits.ledger', limit: 60, windowSeconds: 60, keyBy: 'actor' })
  history(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(creditHistoryQuery)) query: z.infer<typeof creditHistoryQuery>,
  ) {
    return this.credits.history(actor, query);
  }
}
