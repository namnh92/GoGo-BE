import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor } from '../../identity/presentation/decorators';
import { PreferencesService } from '../application/preferences.service';

const UuidPipe = new ZodValidationPipe(z.string().uuid());

const savePreferencesSchema = z.object({
  selections: z.record(z.string().max(32), z.array(z.string().max(64)).max(30)),
  weights: z.record(z.string().max(64), z.number().min(0).max(10)).optional(),
  expectedVersion: z.number().int().min(0),
});
type SavePreferencesDto = z.infer<typeof savePreferencesSchema>;

@Controller('rooms/:roomId/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get('me')
  getMine(@CurrentActor() actor: Actor, @Param('roomId', UuidPipe) roomId: string) {
    return this.preferences.getMine(actor, roomId);
  }

  @Put('me')
  saveMine(
    @CurrentActor() actor: Actor,
    @Param('roomId', UuidPipe) roomId: string,
    @Body(new ZodValidationPipe(savePreferencesSchema)) body: SavePreferencesDto,
  ) {
    return this.preferences.saveMine(actor, roomId, {
      selections: body.selections,
      ...(body.weights ? { weights: body.weights } : {}),
      expectedVersion: body.expectedVersion,
    });
  }

  // 200, not Nest's default 201 for POST: the OpenAPI contract declares 200 and
  // the generated clients type the response off that, so a 201 here is a
  // response shape no consumer has a branch for. Completing is also not a
  // creation — it flips a flag on a row that already exists.
  @Post('complete')
  @HttpCode(200)
  completeMine(@CurrentActor() actor: Actor, @Param('roomId', UuidPipe) roomId: string) {
    return this.preferences.completeMine(actor, roomId);
  }
}
