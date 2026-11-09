import { Controller, Get, Header, Param } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { OptionalAuth, RateLimit } from '../../identity/presentation/decorators';
import { ProviderPhotosService } from '../application/provider-photos.service';

@Controller('places')
export class ProviderPhotosController {
  constructor(private readonly photos: ProviderPhotosService) {}

  @OptionalAuth()
  @RateLimit({ action: 'places.candidatePhoto', limit: 120, windowSeconds: 60, keyBy: 'actorOrIp' })
  @Header('cache-control', 'private, no-store')
  @Get('google-provider-photo/:googlePlaceId')
  candidatePhoto(
    @Param('googlePlaceId', new ZodValidationPipe(z.string().regex(/^[A-Za-z0-9_-]{5,255}$/)))
    id: string,
  ) {
    return this.photos.firstForProvider(id);
  }
}
