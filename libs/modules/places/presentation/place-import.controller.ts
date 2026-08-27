import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { PlaceImportService } from '../application/place-import.service';

const submitSchema = z.object({
  url: z.string().trim().url().max(2000),
  roomId: z.string().uuid().optional(),
});
type SubmitDto = z.infer<typeof submitSchema>;

@Controller('places/imports')
export class PlaceImportController {
  constructor(private readonly imports: PlaceImportService) {}

  /** FR-PLACE-001 — paste/share a Google Maps link. */
  @RateLimit({ action: 'places.import', limit: 10, windowSeconds: 60, keyBy: 'actor' })
  @Post()
  submit(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(submitSchema)) body: SubmitDto) {
    return this.imports.submit(actor, { url: body.url, roomId: body.roomId });
  }

  /** FR-PLACE-004 — polling endpoint for pending → verified | rejected. */
  @Get(':importId')
  get(
    @CurrentActor() actor: Actor,
    @Param('importId', new ZodValidationPipe(z.string().uuid())) importId: string,
  ) {
    return this.imports.getImport(actor, importId);
  }
}
