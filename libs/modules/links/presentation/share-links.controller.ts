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
   * the slug is the credential, and slugs carry 128 bits, so this limit guards
   * against a flood rather than against guessing.
   *
   * `edgeClientIp` (SEC-004) is what makes it per *visitor*. The Worker calls
   * server-to-server, so without it every click would share one Cloudflare
   * egress bucket: a ceiling for the whole product that still told no two
   * visitors apart. The forwarded address counts only on a request whose edge
   * hop authenticated; anything else falls back to the connecting address, and
   * the origin-wide flood net applies to both regardless.
   */
  @Public()
  @RateLimit({
    action: 'share_links.resolve',
    limit: 600,
    windowSeconds: 60,
    keyBy: 'ip',
    edgeClientIp: true,
  })
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
