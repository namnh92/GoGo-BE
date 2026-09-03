import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import {
  flagEnvironmentOf,
  resolveBooleanFlag,
  type FlagPlatform,
} from '../../shared/feature-flags';
import {
  MOBILE_USAGE_CONFIDENCE,
  MOBILE_USAGE_PLATFORMS,
  MOBILE_USAGE_SOURCE,
  MOBILE_USAGE_STALE_AFTER_MS,
  foldMobileUsage,
  foldQuantity,
  type ClientUsageEvent,
  type MobileUsageFold,
  type MobileUsageRejection,
} from '../domain/mobile-usage';
import { COST_REGISTRY, type CostRegistry } from '../domain/registry';

/**
 * COST-BE-028 (#387) — epic §18, the ingest behind
 * `POST /v1/telemetry/provider-usage`.
 *
 * Three things happen per accepted batch, and each exists for a reason:
 *
 * - **Usage rows accumulate.** Unlike a collector, which re-reads a provider's
 *   own total and therefore *replaces* the day's row, a batch is an increment:
 *   the phone is telling us about map loads we have never seen and will never
 *   see again. So the upsert adds, exactly as the in-process ledger's does.
 *   A replayed batch would double-count, which is what `Idempotency-Key` is
 *   for — the global interceptor replays the stored response instead of
 *   running this twice.
 * - **A freshness row is written.** `MEASURED_ZERO` requires a source that is
 *   FRESH or STALE (epic §23); without one, a quiet day and a broken uploader
 *   look identical on the cost screen, and the epic is emphatic that they must
 *   not. The source is per service, so iOS going quiet does not make Android
 *   look stale.
 * - **A bounded counter is emitted.** `mobile_provider_usage_total{service}` —
 *   the service id, which is a registry literal. Not the platform (it is
 *   implied by the service), not the app version, not a day. #319's rule.
 *
 * When the flag is off nothing is written and the response says so, rather
 * than 404-ing a route that exists or 200-ing a request that did nothing. A
 * client that is told `enabled: false` can stop uploading; a client told
 * "success" would keep spending battery to be ignored.
 */

export type MobileUsageIngestResult = {
  /** Whether `mobile_provider_usage.enabled` let anything be recorded. */
  enabled: boolean;
  /** Events folded into rows. */
  accepted: number;
  /** Events refused, with the reason each was refused for. */
  discarded: number;
  rejected: { index: number; reason: MobileUsageRejection }[];
  /** Units recorded — map loads, not events. */
  quantity: number;
};

/**
 * Whether client-reported usage is being accepted for `platform` (#387).
 *
 * The flag is platform-scoped because its primary reader is the app, which
 * needs to know whether *its* build should emit — and the two platforms do not
 * become ready together (Android is still waiting on its own Maps key,
 * Mobile#127 / Infra#102).
 */
export function isClientTelemetryEnabled(
  db: Pick<Db, 'execute'>,
  environment: string,
  platform: FlagPlatform,
): Promise<boolean> {
  return resolveBooleanFlag(db, 'mobile_provider_usage.enabled', {
    environment: flagEnvironmentOf(environment),
    platform,
  });
}

/**
 * Whether *anything* is counting the client-reported operations — the question
 * a cost report asks before deciding they are a measurement gap.
 *
 * Deliberately "any platform", not "every platform". `not_instrumented` means
 * nobody is set up to count this at all; once the ingest path is open, the
 * operations are counted, and whether a particular platform's build has
 * shipped its emitter yet is a rollout fact, carried by that service's source
 * freshness (UNKNOWN — nobody has reported) rather than by the gap list.
 *
 * Querying `ios` and `android` covers an unscoped (`all`) row too: a row
 * scoped to `all` applies to every platform target.
 */
export async function isClientTelemetryEnabledAnywhere(
  db: Pick<Db, 'execute'>,
  environment: string,
): Promise<boolean> {
  const results = await Promise.all(
    MOBILE_USAGE_PLATFORMS.map((platform) => isClientTelemetryEnabled(db, environment, platform)),
  );
  return results.some(Boolean);
}

export type MobileUsageOptions = {
  /** `dev` | `staging` | `prod` — which deployment's rows these are. */
  environment: string;
  now?: () => Date;
};

export class MobileProviderUsageService {
  constructor(
    private readonly db: Db,
    private readonly registry: CostRegistry = COST_REGISTRY,
    private readonly options: MobileUsageOptions = { environment: 'dev' },
    private readonly metrics: MetricsPort | null = null,
  ) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /**
   * Whether client-reported usage is being accepted for `platform`.
   *
   * Platform-scoped because the two do not become ready together: Android is
   * still waiting on its own Maps key (Mobile#127 / Infra#102), and switching
   * iOS on must not imply Android is being measured.
   */
  enabledFor(platform: FlagPlatform): Promise<boolean> {
    return isClientTelemetryEnabled(this.db, this.options.environment, platform);
  }

  async ingest(events: readonly ClientUsageEvent[]): Promise<MobileUsageIngestResult> {
    const now = this.now();
    // One batch is one platform's uploader; the schema pins that, so a single
    // flag read answers for the whole batch.
    const platform: FlagPlatform = events[0]?.platform ?? 'all';
    const enabled = await this.enabledFor(platform);
    if (!enabled) {
      return {
        enabled: false,
        accepted: 0,
        discarded: events.length,
        rejected: [],
        quantity: 0,
      };
    }

    const fold = foldMobileUsage(events, now, this.registry);
    if (fold.rows.length > 0) {
      await this.persist(fold, now);
      for (const row of fold.rows) {
        this.metrics?.increment(
          'mobile_provider_usage_total',
          { service: row.serviceId },
          row.quantity,
        );
      }
    }
    return {
      enabled: true,
      accepted: events.length - fold.rejected.length,
      discarded: fold.rejected.length,
      rejected: fold.rejected,
      quantity: foldQuantity(fold),
    };
  }

  /**
   * Usage rows and the freshness of the source that produced them, in one
   * transaction: a cost screen that shows the units but calls the source
   * UNKNOWN, or calls it FRESH with nothing behind it, is worse than either
   * fact alone. The unit specs' fake `db` has no `transaction`, so the two
   * statements fall back to running in sequence there.
   */
  private async persist(fold: MobileUsageFold, now: Date): Promise<void> {
    const values = fold.rows.map(
      (r) =>
        sql`(${r.day}::date, ${this.options.environment}, ${r.providerId}, ${r.serviceId}, ${r.operationId}, ${r.usageMetricId}, ${r.billingSkuId}, ${r.quantity}, ${r.unit}, ${MOBILE_USAGE_SOURCE}, ${MOBILE_USAGE_CONFIDENCE}, ${now.toISOString()}, now(), ${JSON.stringify(r.metadata)}::jsonb, now())`,
    );
    const staleAfterS = Math.round(MOBILE_USAGE_STALE_AFTER_MS / 1000);
    const sources = [...new Set(fold.rows.map((r) => `${r.providerId}|${r.serviceId}`))].map(
      (key) => {
        const [providerId, serviceId] = key.split('|') as [string, string];
        return sql`(${this.options.environment}, ${`${MOBILE_USAGE_SOURCE}:${serviceId}`}, ${providerId}, ${serviceId}, ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()}, ${staleAfterS}, 'FRESH', null, 0, now())`;
      },
    );

    const write = async (exec: Pick<Db, 'execute'>) => {
      await exec.execute(sql`
        insert into provider_usage_meter_daily
          (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
           quantity, unit, source, confidence, source_as_of, collected_at, metadata, updated_at)
        values ${sql.join(values, sql`, `)}
        on conflict (day, environment, provider_id, service_id, coalesce(operation_id, ''),
                     usage_metric_id, coalesce(billing_sku_id, ''), source)
        do update set
          quantity     = provider_usage_meter_daily.quantity + excluded.quantity,
          unit         = excluded.unit,
          confidence   = excluded.confidence,
          source_as_of = excluded.source_as_of,
          metadata     = excluded.metadata,
          collected_at = now(),
          updated_at   = now()
      `);
      await exec.execute(sql`
        insert into cost_source_freshness
          (environment, source_id, provider_id, service_id, last_successful_at, last_attempt_at,
           source_as_of, stale_after_s, status, last_error_code, consecutive_failures, updated_at)
        values ${sql.join(sources, sql`, `)}
        on conflict (environment, source_id) do update set
          provider_id = excluded.provider_id,
          service_id = excluded.service_id,
          last_successful_at = excluded.last_successful_at,
          last_attempt_at = excluded.last_attempt_at,
          source_as_of = excluded.source_as_of,
          stale_after_s = excluded.stale_after_s,
          status = excluded.status,
          last_error_code = null,
          consecutive_failures = 0,
          updated_at = now()
      `);
    };

    if (typeof (this.db as { transaction?: unknown }).transaction === 'function') {
      await this.db.transaction(async (tx) => write(tx));
    } else {
      await write(this.db);
    }
  }
}
