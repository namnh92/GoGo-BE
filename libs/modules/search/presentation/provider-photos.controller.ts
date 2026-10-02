import { Controller, Get, Header, Param } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import { ProviderPhotosService } from '../application/provider-photos.service';

@Controller('places')
export class ProviderPhotosController {
  constructor(private readonly photos: ProviderPhotosService) {}

  /**
   * GoGo-BE#509 — transient Google photos for one Place Detail view.
   *
   * Public like Place Detail, with a tighter bucket of its own: each call can
   * spend real money, so it is bounded three ways — this rate limit, the
   * `google.places.display` daily budget, and the kill switch. `no-store` and
   * `private` because Google forbids caching photo names and the bytes are
   * served for this view only — no CDN, proxy or client cache may keep them.
   */
  @Public()
  @RateLimit({ action: 'places.providerPhotos', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  @Header('cache-control', 'private, no-store')
  @Get(':id/provider-photos')
  providerPhotos(@Param('id', new ZodValidationPipe(z.string().uuid())) id: string) {
    return this.photos.photos(id);
  }
}
