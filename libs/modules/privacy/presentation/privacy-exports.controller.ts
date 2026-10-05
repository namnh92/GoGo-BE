import { Controller, Get, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import {
  ManualIdempotency,
  NoIdempotencyReplay,
  idempotencyScope,
} from '../../shared/idempotency.interceptor';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { PRIVACY_EXPORT_DEFAULTS } from '../application/export-artifacts';
import { PrivacyExportService, type RedeemedExport } from '../application/privacy-export.service';
import { transferExport } from './export-transfer';

const UuidPipe = new ZodValidationPipe(z.string().uuid());

/**
 * GoGo-BE#256, ADR-0031 — self-service secure export.
 *
 * The export id addresses an artifact; it authorizes nothing. Only the
 * subject's own active session can redeem it, once, through the explicit POST
 * below. GET and HEAD never consume.
 */
@Controller('me/exports')
export class PrivacyExportsController {
  constructor(private readonly exports: PrivacyExportService) {}

  /**
   * 202: accepted for generation. `Idempotency-Key` is required and completed
   * inside the creating transaction; a replay answers the same export's
   * current status and never another generation. The per-subject allowance
   * (three per hour) is counted in the service from the table, so a replay
   * does not spend it; this limiter is only the flood net.
   */
  @ManualIdempotency()
  @RateLimit({ action: 'me.exports.create', limit: 20, windowSeconds: 3600, keyBy: 'actor' })
  @Post()
  @HttpCode(202)
  async create(
    @CurrentActor() actor: Actor,
    @Req() req: FastifyRequest & { actor?: Actor },
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', [
        { field: 'Idempotency-Key', code: 'required', message: 'expected [A-Za-z0-9_-]{8,128}' },
      ]);
    }
    const result = await this.exports.createForSelf(actor, idempotencyScope(req, idempotencyKey));
    if (result.replayed) void reply.header('x-idempotent-replay', 'true');
    void reply.header('cache-control', 'no-store');
    return result.export;
  }

  @Get(':id')
  async status(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.exports.status(actor, id);
  }

  /**
   * The one consuming verb. The response body is the export itself, so it
   * stays out of everything that stores or captures responses: no replay
   * record (`NoIdempotencyReplay`), `Cache-Control: no-store`, no ranges, and
   * the request logger records method/status only (never bodies). The
   * transfer itself — disconnects before and after admission, the deadline,
   * exactly-once finalization — is `transferExport` (PR #677 A-F-02).
   */
  @NoIdempotencyReplay()
  @RateLimit({ action: 'me.exports.download', limit: 10, windowSeconds: 3600, keyBy: 'ip+actor' })
  @Post(':id/download')
  async download(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await transferExport(
      {
        raw: reply.raw,
        send: (redeemed: RedeemedExport) =>
          reply
            .status(200)
            .header('content-type', 'application/json; charset=utf-8')
            .header('content-disposition', `attachment; filename="${redeemed.filename}"`)
            .header('content-length', String(redeemed.body.byteLength))
            .header('cache-control', 'no-store, private, max-age=0')
            .header('pragma', 'no-cache')
            .header('x-content-type-options', 'nosniff')
            .header('accept-ranges', 'none')
            .send(redeemed.body),
      },
      (clientGone) => this.exports.redeem(actor, id, clientGone),
      PRIVACY_EXPORT_DEFAULTS.transferDeadlineMs,
    );
  }
}
