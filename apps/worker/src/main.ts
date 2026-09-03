import os from 'node:os';
import { createDb } from '@gogo/database';
import {
  CampaignDispatcher,
  DbUsageLedger,
  OutboxDispatcher,
  PlaceDedupService,
  PlaceImportJobService,
  PlaceRefreshService,
  PlaceResolverService,
  PrivacyJobs,
  ProviderBudgetService,
  budgetLimitsFrom,
  CostEstimatorService,
  defaultRecomputeRange,
  COST_REGISTRY,
  CollectorSchedulerService,
  ledgerFreshnessCollector,
  ManualCostService,
  cloudflareCollectorOptionsFromEnv,
  cloudflareCollectors,
  upstashRedisCollector,
} from '@gogo/modules';
import { TeeMetrics, createLogger } from '@gogo/observability';
import {
  FakePush,
  FakeSheets,
  FakePlaceProvider,
  UnconfiguredPlaceProvider,
  placeProviderStatus,
  GooglePlacesAdapter,
  GoogleSheetsAdapter,
  warnFakedProviders,
  cloudflareAnalyticsFromEnv,
  upstashDeveloperApiFromEnv,
} from '@gogo/providers';
import { AdvisoryLock, startPeriodic } from './periodic';
import { createWorkerMetrics, startMetricsEndpoint } from './metrics';

/**
 * Poll intervals, in milliseconds.
 *
 * Each tick is a Postgres query to find work, so the interval is the ceiling
 * on dispatch latency and the floor on idle database load — nothing else. It
 * used to also be the dominant Redis cost of the worker, back when a BullMQ
 * scheduler created and completed a job every tick; the worker no longer holds
 * a Redis connection at all (see periodic.ts).
 *
 * The trade is dispatch latency: at 60s a notification waits up to a minute
 * before the outbox relay picks it up. Acceptable on DEV, tuned down for
 * production through the same variables.
 */
const pollIntervalMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1000) {
    throw new Error(`${name} must be a number of milliseconds >= 1000, received "${raw}"`);
  }
  return value;
};

const OUTBOX_POLL_MS = pollIntervalMs('OUTBOX_POLL_MS', 5000);
/**
 * COST-BE-016 (#368): how often the estimator re-prices this month's and last
 * month's usage. Idempotent and bounded, so a short interval only costs a
 * small query; 15 minutes keeps the cost screen within a quarter hour of the
 * ledger without adding load. `COST_ESTIMATE_ENABLED=false` is the kill switch.
 */
const COST_ESTIMATE_POLL_MS = Number(process.env.COST_ESTIMATE_POLL_MS ?? 15 * 60 * 1000);
const COST_ESTIMATE_ENABLED = process.env.COST_ESTIMATE_ENABLED !== 'false';
/**
 * COST-BE-017 (#369): the collector scheduler tick — freshness rows, paid
 * collector guardrails, cost-of-cost. Every collector decides for itself
 * whether it is due; the tick only asks. `COST_COLLECTORS_ENABLED=false`
 * stops the whole thing; `COST_MONITORING_BUDGET_MICROS` overrides epic §20's
 * per-environment default ($1 DEV, $5 PROD, per month).
 */
const COST_COLLECTOR_POLL_MS = Number(process.env.COST_COLLECTOR_POLL_MS ?? 5 * 60 * 1000);
const COST_COLLECTORS_ENABLED = process.env.COST_COLLECTORS_ENABLED !== 'false';
const COST_MONITORING_BUDGET_MICROS = process.env.COST_MONITORING_BUDGET_MICROS
  ? Number(process.env.COST_MONITORING_BUDGET_MICROS)
  : undefined;
const INGEST_POLL_MS = pollIntervalMs('INGEST_POLL_MS', 5000);
/**
 * #340 — how often the liveness refresh looks for due rows. Plan §2.5 sets DEV
 * to 15 minutes: the work is due-work on a 30-day cadence, so the interval
 * decides how finely a day's worth of rows is spread, not how fresh anything
 * is. Nothing is spent on an empty tick — the due query answers first, and the
 * budget reservation only happens when there are rows.
 */
const PLACE_REFRESH_POLL_MS = pollIntervalMs('PLACE_REFRESH_POLL_MS', 15 * 60 * 1000);
const PRIVACY_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * How often this process says it is alive. Its own job, on its own cadence:
 * tying it to a business tick would make "worker alive" mean "outbox tick
 * ran", and those stop being the same thing the day the outbox tick hangs.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Dead-man-switch heartbeats (healthchecks.io style): ping ONLY after a
 * successful run, throttled — the monitor alerts when pings stop, covering
 * silent worker death that process-level monitoring misses.
 */
const lastPing = new Map<string, number>();
async function heartbeat(url: string | undefined, throttleMs = 60_000): Promise<void> {
  if (!url) return;
  const now = Date.now();
  if (now - (lastPing.get(url) ?? 0) < throttleMs) return;
  lastPing.set(url, now);
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  } catch {
    // Heartbeat failure must never break job processing.
  }
}

/**
 * Worker process (BE-BFF-010 + DB-010): periodic processors for outbox
 * fan-out, place import and privacy/retention. Each tick is at-least-once and
 * idempotent (outbox marks published per event; import advances chunks it
 * finds pending; privacy jobs are pure re-runnable SQL), and a Postgres
 * advisory lock keeps two replicas from running the same tick together.
 */
async function bootstrap(): Promise<void> {
  const logger = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'gogo-worker',
    pretty: process.env.NODE_ENV === 'development',
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const { db, pool } = createDb(databaseUrl);
  // The container id under compose, the machine name elsewhere. Stable for the
  // life of the process, which is what makes one row per process work.
  const WORKER_ID = process.env.HOSTNAME || os.hostname();
  const STARTED_AT = new Date();
  // #318: both sinks, like the API. Bulk import runs in this process, so the
  // registry below is the only place its provider, cost and row counters can
  // be scraped from.
  const { metrics: baseMetrics, registry } = createWorkerMetrics(logger);
  /**
   * #335 — the worker's half of durable usage accounting.
   *
   * Bulk import runs in this process, not in the API, so this is where the
   * largest share of Google spend is actually incurred. A ledger wired only
   * into `apps/api` would under-report by its biggest component and still look
   * like a complete answer, which is the failure #318 already had to fix for
   * the scrape endpoint.
   */
  const usageLedger = new DbUsageLedger(db, {
    environment: process.env.APP_ENV ?? 'dev',
    enabled: process.env.COST_LEDGER_ENABLED !== 'false',
    ...(process.env.COST_LEDGER_FLUSH_MS
      ? { flushMs: Number(process.env.COST_LEDGER_FLUSH_MS) }
      : {}),
    metrics: baseMetrics,
  });
  usageLedger.start();
  const metrics = new TeeMetrics([baseMetrics, usageLedger]);
  const metricsEndpoint = await startMetricsEndpoint({
    registry,
    token: process.env.METRICS_TOKEN,
    logger,
  });
  // Real push provider lands with credentials (GoGo-BE#60); fake logs sends.
  const push = new FakePush();
  const dispatcher = new OutboxDispatcher(db, push, metrics);
  // BE-CMS-G4e (#226): campaigns are sent here, never from a request. Same
  // tick as the outbox rather than a schedule of their own.
  const campaigns = new CampaignDispatcher(db, push, metrics);
  const privacy = new PrivacyJobs(db);

  // PI-BE-015: bulk import chunks run here, not in the API process. The tick
  // polls for jobs an admin has started rather than consuming an enqueue, so a
  // start survives an API restart and no message can strand a job.
  const placesKey = process.env.GOOGLE_PLACES_API_KEY ?? '';
  const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY ?? '';
  const routesKey = process.env.GOOGLE_ROUTES_API_KEY ?? '';
  // PI-BE-021: the worker runs the import chunks, so a missing Sheets key
  // strands jobs here as surely as it rejects them in the API. Same warning,
  // because this process makes the same choice from its own copy of the env.
  // #279: the worker resolves rows through the same port, so it must make the
  // same choice from its own copy of the env — a worker quietly on the fake
  // while the API is on Google marks good rows unresolvable in bulk.
  const placeStatus = placeProviderStatus({
    ...(process.env.PLACE_PROVIDER_MODE === 'google' || process.env.PLACE_PROVIDER_MODE === 'fake'
      ? { PLACE_PROVIDER_MODE: process.env.PLACE_PROVIDER_MODE }
      : {}),
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    GOOGLE_PLACES_API_KEY: placesKey,
  });
  warnFakedProviders(
    {
      GOOGLE_PLACES_API_KEY: placesKey,
      GOOGLE_SHEETS_API_KEY: sheetsKey,
      GOOGLE_ROUTES_API_KEY: routesKey,
      // The worker binds no travel-time provider, but it reads the same env and
      // a warn here is what an operator sees when only the worker is restarted.
      FLAG_ROUTES_API: process.env.FLAG_ROUTES_API === 'true',
      PLACE_PROVIDER_MODE: placeStatus.mode,
    },
    (meta, message) => logger.warn(meta, message),
  );
  if (!placeStatus.ready) {
    logger.error(
      { port: 'PLACE_PROVIDER', mode: placeStatus.mode, reason: placeStatus.reason },
      'place provider NOT ready — import rows will pause instead of resolving',
    );
  }
  const placeProvider =
    placeStatus.provider === 'google'
      ? new GooglePlacesAdapter(placesKey, metrics)
      : placeStatus.provider === 'unconfigured'
        ? new UnconfiguredPlaceProvider()
        : new FakePlaceProvider();
  const imports = new PlaceImportJobService(
    db,
    new PlaceResolverService(placeProvider, db, metrics),
    new PlaceDedupService(db),
    sheetsKey ? new GoogleSheetsAdapter(sheetsKey, metrics) : new FakeSheets(),
    // Which deployment's `feature_flags` rows apply — the same value the API
    // resolves flags against, so a switch thrown in the CMS reaches both.
    {
      APP_ENV: (process.env.APP_ENV as 'dev' | 'staging' | 'prod' | 'production') ?? 'dev',
      // Same default as the API's zod schema. The worker's DB-first answers are
      // all identity, so this window changes nothing here today — it is passed
      // so the lookup cannot mean two things in two processes (#337).
      PLACE_RESOLUTION_TTL_S: Number(process.env.PLACE_RESOLUTION_TTL_S ?? 600),
    },
    metrics,
  );

  /**
   * #340 — PR7's liveness refresh.
   *
   * Two independent switches have to be on for this to call Google at all: the
   * `place_refresh.enabled` flag (default off, `FLAG_PLACE_REFRESH` as the
   * deploy-time default) and a configured `google.places.refresh` budget. The
   * budget guard is default-deny, so an environment with no ceilings runs the
   * job, reserves nothing and spends nothing — which is exactly what DEV does
   * until INF-057's values are written.
   */
  const refresh = new PlaceRefreshService(
    db,
    placeProvider,
    new ProviderBudgetService(db),
    metrics,
    {
      appEnv: process.env.APP_ENV ?? 'dev',
      flagDefault: process.env.FLAG_PLACE_REFRESH === 'true',
      limits: budgetLimitsFrom('google.places.refresh', process.env),
    },
  );

  const estimator = new CostEstimatorService(db, { environment: process.env.APP_ENV ?? 'dev' });
  const collectors = new CollectorSchedulerService(db, COST_REGISTRY, {
    environment: process.env.APP_ENV ?? 'dev',
    metrics,
    logger,
    ...(COST_MONITORING_BUDGET_MICROS !== undefined
      ? { monitoringBudgetMicros: COST_MONITORING_BUDGET_MICROS }
      : {}),
  }).register(ledgerFreshnessCollector(db));
  // COST-BE-024 (#383): Cloudflare R2 + Workers usage from the GraphQL
  // Analytics API. Registered only when INF-060's credentials are present;
  // without them the provider stays visible with freshness UNKNOWN — the
  // truthful state — and nothing errors.
  const cloudflare = cloudflareAnalyticsFromEnv(process.env);
  if (cloudflare) {
    const options = cloudflareCollectorOptionsFromEnv(process.env);
    for (const def of cloudflareCollectors(db, cloudflare, options)) collectors.register(def);
    logger.info(
      {
        collectors: ['cloudflare_r2', 'cloudflare_workers'],
        buckets: options.buckets ?? 'account',
        scripts: options.scripts ?? 'account',
      },
      'cloudflare cost collectors registered',
    );
  } else {
    logger.info(
      { provider: 'cloudflare', missing: 'CLOUDFLARE_ANALYTICS_TOKEN / CLOUDFLARE_ACCOUNT_ID' },
      'cloudflare cost collectors not registered — credentials absent',
    );
  }
  // COST-BE-025 (#384): Upstash Redis usage from the Developer API stats
  // endpoint. Same gate: registered only when INF-060's three values are
  // present; absent, the provider stays visible with freshness UNKNOWN.
  const upstash = upstashDeveloperApiFromEnv(process.env);
  if (upstash) {
    collectors.register(upstashRedisCollector(db, upstash));
    logger.info({ collectors: ['upstash_redis'] }, 'upstash cost collector registered');
  } else {
    logger.info(
      {
        provider: 'upstash',
        missing: 'UPSTASH_API_EMAIL / UPSTASH_API_KEY / UPSTASH_DATABASE_ID',
      },
      'upstash cost collector not registered — credentials absent',
    );
  }
  // COST-BE-023 (#382): manual / fixed costs are materialised into
  // `provider_cost_daily` on every CMS write, and once per UTC day here so
  // today's share of a subscription appears without anyone touching the
  // item. Free (one Postgres round trip per item), so it does not answer to
  // `COST_COLLECTORS_ENABLED` — that flag gates collectors that call out.
  const manualCosts = new ManualCostService(db, COST_REGISTRY, {
    environment: process.env.APP_ENV ?? 'dev',
  });
  let manualCostsDay: string | null = null;

  const periodic = startPeriodic(
    [
      {
        name: 'gogo:worker:outbox',
        schedule: { everyMs: OUTBOX_POLL_MS },
        run: async () => {
          const handled = await dispatcher.dispatchBatch(100);
          if (handled > 0) logger.info({ handled }, 'outbox batch dispatched');
          const sent = await campaigns.tick();
          if (sent.campaigns > 0 || sent.testSends > 0) logger.info(sent, 'campaigns dispatched');
          await heartbeat(process.env.HEARTBEAT_URL_OUTBOX);
        },
      },
      {
        name: 'gogo:worker:ingest',
        schedule: { everyMs: INGEST_POLL_MS },
        // Serial by design: chunks already batch 50 rows and each row may cost
        // a provider call, so parallel ticks would only race the quota.
        run: async () => {
          const advanced = await imports.processPendingJobs(5);
          if (advanced.length > 0) logger.info({ advanced }, 'place import chunks processed');
          await heartbeat(process.env.HEARTBEAT_URL_INGEST);
        },
      },
      {
        name: 'gogo:worker:privacy',
        // Every six hours rather than nightly at 03:00. The sweep is due-work
        // — `delete … where day < current_date - 90` — so each run touches
        // only what crossed the line since the last one, and a restart delays
        // it by at most six hours instead of skipping a day.
        schedule: { everyMs: PRIVACY_INTERVAL_MS },
        run: async () => {
          const report = await privacy.run(false);
          logger.info({ report }, 'privacy retention run complete');
          // #255 — a lapsed review date is a person's job, not the job's. It is
          // never auto-released or auto-deleted; it is made loud.
          if (report.privacyHoldReviewsOverdue > 0) {
            logger.warn(
              { count: report.privacyHoldReviewsOverdue },
              'privacy retention holds past review date — HOLD_REVIEW_OVERDUE',
            );
          }
          await heartbeat(process.env.HEARTBEAT_URL_PRIVACY, 0);
        },
      },
      {
        name: 'gogo:worker:place-refresh',
        schedule: { everyMs: PLACE_REFRESH_POLL_MS },
        run: async () => {
          const report = await refresh.tick();
          // A tick that found nothing due is the common case and says nothing
          // worth a line; everything else is either spend or a reason there was
          // none, and both are what an operator reads this log for.
          if (report.tick !== 'nothing_due') logger.info({ report }, 'place refresh tick');
        },
      },
      {
        name: 'gogo:worker:cost-estimate',
        schedule: { everyMs: COST_ESTIMATE_POLL_MS },
        run: async () => {
          if (!COST_ESTIMATE_ENABLED) return;
          const result = await estimator.recompute(defaultRecomputeRange());
          if (result.rowsWritten > 0 || result.unpriced.length > 0) {
            logger.info(
              {
                from: result.from,
                to: result.to,
                rowsWritten: result.rowsWritten,
                rowsDeleted: result.rowsDeleted,
                unpricedSkus: [...new Set(result.unpriced.map((u) => u.billingSkuId))],
              },
              'cost estimate recomputed',
            );
          }
        },
      },
      {
        name: 'gogo:worker:cost-collectors',
        schedule: { everyMs: COST_COLLECTOR_POLL_MS },
        run: async () => {
          const today = new Date().toISOString().slice(0, 10);
          if (manualCostsDay !== today) {
            try {
              const built = await manualCosts.materialise();
              manualCostsDay = today;
              if (built.rowsWritten > 0 || built.rowsDeleted > 0) {
                logger.info(built, 'manual costs materialised');
              }
            } catch (err) {
              logger.error({ err }, 'manual cost materialisation failed');
            }
          }
          if (!COST_COLLECTORS_ENABLED) return;
          const report = await collectors.tick();
          await collectors.writeMonitoringCostRow();
          const ran = report.results.filter((r) => !r.outcome.startsWith('skipped'));
          if (ran.length > 0 || report.monitoring.overBudget) {
            logger.info({ results: ran, monitoring: report.monitoring }, 'cost collectors ticked');
          }
        },
      },
      {
        name: 'gogo:worker:heartbeat',
        schedule: { everyMs: HEARTBEAT_INTERVAL_MS },
        run: async () => {
          await pool.query(
            `insert into worker_heartbeats (worker_id, started_at, last_seen_at)
             values ($1, $2, now())
             on conflict (worker_id) do update set last_seen_at = now()`,
            [WORKER_ID, STARTED_AT],
          );
        },
      },
    ],
    { lock: new AdvisoryLock(pool), logger, metrics },
  );

  logger.info(
    {
      outboxPollMs: OUTBOX_POLL_MS,
      ingestPollMs: INGEST_POLL_MS,
      placeRefreshPollMs: PLACE_REFRESH_POLL_MS,
      placeRefreshFlagDefault: process.env.FLAG_PLACE_REFRESH === 'true',
    },
    'worker booted: privacy sweep every 6h',
  );

  const shutdown = async () => {
    logger.info('worker shutting down');
    await periodic.stop();
    // Before the pool: a scrape in flight reads memory, not the database, but
    // an open socket would still hold the process past the ticks stopping.
    await metricsEndpoint?.close();
    // #335: after the ticks stop and before the pool closes — the flush is a
    // database write, and it is the difference between a graceful stop losing
    // nothing and losing a flush window.
    await usageLedger.stop().catch((err) => {
      logger.error({ err }, 'usage ledger flush failed on shutdown');
    });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
