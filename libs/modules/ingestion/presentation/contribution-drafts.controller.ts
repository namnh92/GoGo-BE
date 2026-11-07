import { Body, Controller, Delete, Get, Header, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { NoIdempotencyReplay } from '../../shared/idempotency.interceptor';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import {
  saveContributionDraftSchema,
  type SaveContributionDraft,
} from '../domain/contribution-enrichment';
import { ContributionDraftsService } from '../application/contribution-drafts.service';

@Controller('place-contribution-drafts')
export class ContributionDraftsController {
  constructor(private readonly drafts: ContributionDraftsService) {}
  @Get()
  @Header('cache-control', 'private, no-store')
  list(@CurrentActor() actor: Actor) {
    return this.drafts.list(actor);
  }
  @Get(':id')
  @Header('cache-control', 'private, no-store')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
  ) {
    return this.drafts.get(actor, id);
  }
  // PUT + version is the retry boundary; replay storage must not retain free text
  // after deletion, expiry or account erasure.
  @Put(':id')
  @NoIdempotencyReplay()
  @Header('cache-control', 'private, no-store')
  @RateLimit({ action: 'places.draft_save', limit: 30, windowSeconds: 60, keyBy: 'ip+actor' })
  save(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(saveContributionDraftSchema)) body: SaveContributionDraft,
  ) {
    return this.drafts.save(actor, id, body);
  }
  @Delete(':id')
  @NoIdempotencyReplay()
  delete(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Query('version', new ZodValidationPipe(z.coerce.number().int().min(1))) version: number,
  ) {
    return this.drafts.delete(actor, id, version);
  }
}
