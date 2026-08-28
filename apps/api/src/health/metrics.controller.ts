import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { AppError, Public } from '@gogo/modules';
import type { MetricsRegistry } from '@gogo/observability';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { METRICS_REGISTRY } from '../metrics.tokens';

/**
 * PI-SRE-001 (#120) — the scrape endpoint.
 *
 * The alert table has existed with a note saying the metric destination was
 * undecided. Exposing the standard text format takes that decision off the
 * critical path: any scraper can read it, and picking one stops being a
 * prerequisite for having alerts at all.
 *
 * Guarded by a token rather than left open. The series names and label values
 * describe internal structure — which providers are called, which admin
 * actions happen, how much a room costs — and none of that belongs to the
 * public internet. With no token configured the route answers 404, so an
 * unconfigured deployment does not quietly publish it.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS_REGISTRY) private readonly registry: MetricsRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): string {
    const expected = this.config.METRICS_TOKEN;
    // 404 rather than 401: an unconfigured endpoint should not advertise that
    // it exists and is merely locked.
    if (!expected) throw AppError.notFound('NOT_FOUND', 'Not found');

    const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!constantTimeEquals(presented, expected)) {
      throw AppError.unauthorized('UNAUTHORIZED', 'Metrics token required');
    }

    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return this.registry.render();
  }
}

/** Length is compared first because timingSafeEqual throws on a mismatch. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
