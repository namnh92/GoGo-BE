import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { SuggestionService } from '../application/suggestion.service';

const UuidPipe = new ZodValidationPipe(z.string().uuid());

const voteSchema = z.object({ value: z.enum(['yes', 'no', 'star']) });
const finalizeSchema = z.object({ placeId: z.string().uuid().optional() });

@Controller('rooms/:roomId')
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionService) {}

  /** Security rule: suggestion generation is rate-limited per room actor. */
  @RateLimit({ action: 'suggestions.generate', limit: 6, windowSeconds: 60, keyBy: 'actor' })
  @Post('suggestions')
  generate(@CurrentActor() actor: Actor, @Param('roomId', UuidPipe) roomId: string) {
    return this.suggestions.generate(actor, roomId);
  }

  @Get('suggestions/current')
  current(@CurrentActor() actor: Actor, @Param('roomId', UuidPipe) roomId: string) {
    return this.suggestions.current(actor, roomId);
  }

  @RateLimit({ action: 'votes.cast', limit: 60, windowSeconds: 60, keyBy: 'actor' })
  @Put('votes/:placeId')
  vote(
    @CurrentActor() actor: Actor,
    @Param('roomId', UuidPipe) roomId: string,
    @Param('placeId', UuidPipe) placeId: string,
    @Body(new ZodValidationPipe(voteSchema)) body: { value: 'yes' | 'no' | 'star' },
  ) {
    return this.suggestions.vote(actor, roomId, placeId, body.value);
  }

  @Post('votes/finalize')
  finalize(
    @CurrentActor() actor: Actor,
    @Param('roomId', UuidPipe) roomId: string,
    @Body(new ZodValidationPipe(finalizeSchema)) body: { placeId?: string },
  ) {
    return this.suggestions.finalize(actor, roomId, body.placeId);
  }
}
