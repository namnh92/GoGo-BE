import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Public, RateLimit } from '../../identity/presentation/decorators';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { ShareLinksService } from '../application/share-links.service';
import { createShareLinkSchema, shareSlugSchema, type CreateShareLinkDto } from './dtos';

const SlugPipe = new ZodValidationPipe(shareSlugSchema);

@Controller('share-links')
export class ShareLinksController {
  constructor(private readonly links: ShareLinksService) {}

  @RateLimit({ action: 'share_links.create', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createShareLinkSchema)) body: CreateShareLinkDto,
  ) {
    return this.links.create(actor, body);
  }

  /**
   * Edge resolve (the share-link Worker calls this on every click). Public:
   * the slug is the credential. Slugs carry 128 bits, so the limit here guards
   * against a flood, not against guessing — and it is per client IP, which for
   * the Worker means per Cloudflare egress, so it is deliberately generous.
   */
  @Public()
  @RateLimit({ action: 'share_links.resolve', limit: 600, windowSeconds: 60, keyBy: 'ip' })
  @Get(':slug')
  resolve(@Param('slug', SlugPipe) slug: string) {
    return this.links.resolve(slug);
  }

  @RateLimit({ action: 'share_links.revoke', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Delete(':slug')
  revoke(@CurrentActor() actor: Actor, @Param('slug', SlugPipe) slug: string) {
    return this.links.revoke(actor, slug);
  }
}
