import { Body, Controller, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import {
  CurrentActor,
  RateLimit,
  type RateLimitSpec,
} from '../../identity/presentation/decorators';
import { PlaceReportsService } from '../application/place-reports.service';
import { placeReportBodySchema, type PlaceReportBody } from '../domain/place-report';

/**
 * security.md: reports are rate-limited separately, per actor. Five a minute
 * covers a person correcting several facts on one place; twenty an hour stops
 * one account from flooding the moderation queue.
 */
const REPORT_LIMIT: RateLimitSpec = {
  action: 'places.report',
  limit: 20,
  windowSeconds: 3600,
  burst: { limit: 5, windowSeconds: 60 },
  keyBy: 'actor',
};

/** BE-BFF-P2 (#218) — "Báo thông tin sai" on Place Detail. */
@Controller('places')
export class PlaceReportsController {
  constructor(private readonly reports: PlaceReportsService) {}

  @RateLimit(REPORT_LIMIT)
  @Post(':id/reports')
  async file(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(placeReportBodySchema)) body: PlaceReportBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { created, report } = await this.reports.file(actor, id, body);
    // 201 for a new report, 200 for the open one this actor already filed.
    reply.status(created ? 201 : 200);
    return report;
  }
}
