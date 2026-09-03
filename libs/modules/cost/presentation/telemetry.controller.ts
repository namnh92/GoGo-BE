import { Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@gogo/database';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { VERSION_PATTERN } from '../../shared/feature-flags';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { RateLimit } from '../../identity/presentation/decorators';
import {
  MOBILE_USAGE_MAX_BATCH,
  MOBILE_USAGE_PLATFORMS,
  type ClientUsageEvent,
} from '../domain/mobile-usage';
import { COST_REGISTRY } from '../domain/registry';
import {
  MobileProviderUsageService,
  type MobileUsageIngestResult,
} from '../application/mobile-usage.service';

/**
 * The services a client may report for, and the metrics each accepts — read
 * from the registry at module load, not typed out here.
 *
 * That is the difference between a bounded schema and a hard-coded one: the
 * set is closed (a caller cannot invent a service), but closing it costs no
 * edit to this file when a second client-reported service is registered. Epic
 * §44.3 — generic code contains no provider switch/case.
 */
const CLIENT_REPORTED = COST_REGISTRY.operations().filter((o) => o.clientReported === true);
const SERVICE_IDS = [...new Set(CLIENT_REPORTED.map((o) => o.serviceId))];
const METRIC_IDS = [...new Set(CLIENT_REPORTED.flatMap((o) => o.usageMeters.map((m) => m.metric)))];
const PROVIDER_IDS = [
  ...new Set(
    SERVICE_IDS.map((id) => COST_REGISTRY.service(id)?.providerId).filter(
      (id): id is string => id !== undefined,
    ),
  ),
];

const nonEmptyEnum = (values: string[]): z.ZodType<string> =>
  values.length === 0 ? z.never() : z.enum(values as [string, ...string[]]);

/**
 * `.strict()` is the privacy control, not a nicety. Epic §18 lists what must
 * never travel with a usage event — user id, place id, lat/lng, URL, tracking
 * id, session id — and a schema that *ignores* unknown keys accepts all of
 * them into the request log before dropping them. Refusing the request is what
 * makes "we never receive it" true rather than aspirational.
 */
const eventSchema = z
  .object({
    providerId: nonEmptyEnum(PROVIDER_IDS),
    serviceId: nonEmptyEnum(SERVICE_IDS),
    usageMetricId: nonEmptyEnum(METRIC_IDS),
    /**
     * A ceiling, because this is a write into the cost ledger from an
     * untrusted client. One handset cannot plausibly render a hundred maps in
     * a flush window, and 100 × the 100-event batch cap is 10,000 loads per
     * request — one month's free allowance, which is as far as a single
     * request should ever be able to move the screen.
     */
    quantity: z.number().int().min(1).max(100),
    occurredAt: z.string().datetime({ offset: true }).max(40),
    platform: z.enum(MOBILE_USAGE_PLATFORMS),
    appVersion: z.string().regex(VERSION_PATTERN, 'expected a version like 1.2.3'),
  })
  .strict();

const batchSchema = z
  .object({
    events: z.array(eventSchema).min(1).max(MOBILE_USAGE_MAX_BATCH),
  })
  .strict()
  .refine((body) => new Set(body.events.map((e) => e.platform)).size === 1, {
    path: ['events'],
    message: 'one batch reports one platform',
  });

type BatchDto = z.infer<typeof batchSchema>;

/**
 * COST-BE-028 (#387), epic §18 — client-reported provider usage.
 *
 * Authenticated: deny-by-default, like every route that is not explicitly
 * `@Public()`. A guest session is enough, which is what the app has on the
 * screens that render a map — but an anonymous caller is not, because an
 * unattributable write into the cost ledger is a number no operator can chase.
 *
 * Rate-limited on `ip+actor` so neither a single account nor a single network
 * can outrun the uploader's own cadence (a flush per 60 seconds, or one on
 * background). `Idempotency-Key` is honoured by the global interceptor, which
 * is what makes an uploader safe to retry: these rows *add*, so a replay that
 * re-ran would double-count.
 */
@Controller('telemetry')
export class TelemetryController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: { APP_ENV?: string },
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  @RateLimit({
    action: 'telemetry.provider_usage',
    limit: 30,
    windowSeconds: 60,
    keyBy: 'ip+actor',
  })
  @Post('provider-usage')
  providerUsage(
    @Body(new ZodValidationPipe(batchSchema)) body: BatchDto,
  ): Promise<MobileUsageIngestResult> {
    const service = new MobileProviderUsageService(
      this.db,
      COST_REGISTRY,
      { environment: this.config.APP_ENV ?? 'dev' },
      this.metrics,
    );
    return service.ingest(body.events as ClientUsageEvent[]);
  }
}
