import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { MAX_UPLOAD_BYTES, UPLOAD_PURPOSES, UploadsService } from '../application/uploads.service';

const createUploadSchema = z.object({
  purpose: z.enum(UPLOAD_PURPOSES),
  contentType: z.string().min(1).max(100),
  /**
   * Declared up front so an oversized file is refused before a URL exists,
   * rather than after the bytes have crossed the network.
   */
  contentLength: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * #171 — check-in accepted `photoKeys` with no way to produce one, so the
   * mobile check-in sheet shipped without photos or the verified bill.
   *
   * Rate-limited per actor: each call costs a signature and a row, and an
   * unbounded loop would let one account fill the pending table.
   */
  @RateLimit({ action: 'uploads.create', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createUploadSchema)) body: z.infer<typeof createUploadSchema>,
  ) {
    return this.uploads.createUpload(actor, body);
  }
}
