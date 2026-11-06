import { Body, Controller, Delete, Get, Header, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequireRole } from '../../cms/presentation/admin.guard';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Public, RateLimit } from '../../identity/presentation/decorators';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { SubmissionPhotosService } from '../application/submission-photos.service';

const Uuid = new ZodValidationPipe(z.string().uuid());
const removal = z.object({ reason: z.string().trim().min(3).max(500) });

@RequireRole('moderator', 'editor')
@Controller('cms/place-submissions')
export class SubmissionPhotoController {
  constructor(private readonly photos: SubmissionPhotosService) {}

  @Get(':id/photos/:photoId/content')
  @Header('cache-control', 'private, no-store')
  @Header('x-content-type-options', 'nosniff')
  async content(
    @Param('id', Uuid) id: string,
    @Param('photoId', Uuid) photoId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const body = await this.photos.readForReview(id, photoId);
    // Set the binary type only after reads succeed so errors keep their JSON envelope.
    void reply.type('image/webp');
    return body;
  }

  @Delete(':id/photos/:photoId')
  remove(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Param('photoId', Uuid) photoId: string,
    @Body(new ZodValidationPipe(removal)) body: z.infer<typeof removal>,
  ) {
    return this.photos.remove(actor.id, id, photoId, body.reason);
  }
}

@Controller('places')
export class CommunityPhotoController {
  constructor(private readonly photos: SubmissionPhotosService) {}

  @Public()
  @RateLimit({ action: 'places.communityPhoto', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get(':id/photos/:photoId/content')
  @Header('cache-control', 'private, no-store')
  @Header('x-content-type-options', 'nosniff')
  async content(
    @Param('id', Uuid) id: string,
    @Param('photoId', Uuid) photoId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const body = await this.photos.readPublic(id, photoId);
    // Set the binary type only after reads succeed so errors keep their JSON envelope.
    void reply.type('image/webp');
    return body;
  }
}
