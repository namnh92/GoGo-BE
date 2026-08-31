import { BullMqQueueStats } from './ops/bullmq-queue-stats.adapter';
import { WORKER_QUEUES } from './ops/queues';
import { Global, Module } from '@nestjs/common';
import {
  AREA_AUTOCOMPLETE,
  FakeAreaAutocomplete,
  FakePlaceProvider,
  FakePush,
  FakeQueueStats,
  FakeSheets,
  FakeStorage,
  GooglePlacesAdapter,
  GoogleRoutesAdapter,
  GoogleSheetsAdapter,
  HaversineTravelTime,
  PLACE_PROVIDER,
  PUSH_PROVIDER,
  QUEUE_STATS,
  type QueueStatsPort,
  SHEETS_PROVIDER,
  R2StorageAdapter,
  STORAGE_PROVIDER,
  TRAVEL_TIME_PROVIDER,
} from '@gogo/providers';
import {
  LogMetrics,
  METRICS,
  MetricsRegistry,
  TeeMetrics,
  createLogger,
  type MetricsPort,
} from '@gogo/observability';
import { METRICS_REGISTRY } from './metrics.tokens';
import { APP_CONFIG, type AppConfig } from './config/env';

/**
 * BE-BFF-011 — port binding. Real adapters only when credentials exist;
 * otherwise deterministic fakes so every environment boots and every flow
 * has a fallback. (R2/push real adapters land when credentials are issued —
 * tracked on GoGo-BE#60.)
 */
@Global()
@Module({
  providers: [
    {
      provide: PLACE_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) =>
        config.GOOGLE_MAPS_API_KEY
          ? new GooglePlacesAdapter(config.GOOGLE_MAPS_API_KEY, metrics)
          : new FakePlaceProvider(),
      inject: [APP_CONFIG, METRICS],
    },
    {
      provide: AREA_AUTOCOMPLETE,
      useFactory: (config: AppConfig) =>
        config.GOOGLE_MAPS_API_KEY
          ? new GooglePlacesAdapter(config.GOOGLE_MAPS_API_KEY)
          : new FakeAreaAutocomplete(),
      inject: [APP_CONFIG],
    },
    {
      // PI-BE-012: the Sheets read uses the same Google key; without it the
      // fake keeps the import wizard exercisable end to end.
      provide: SHEETS_PROVIDER,
      useFactory: (config: AppConfig) =>
        config.GOOGLE_SHEETS_API_KEY || config.GOOGLE_MAPS_API_KEY
          ? new GoogleSheetsAdapter(config.GOOGLE_SHEETS_API_KEY || config.GOOGLE_MAPS_API_KEY)
          : new FakeSheets(),
      inject: [APP_CONFIG],
    },
    {
      // PI-SRE-001: metrics ride the log stream in the MVP stack — no collector
      // to run, and any aggregator can count and alert on them.
      provide: METRICS_REGISTRY,
      useFactory: () => new MetricsRegistry(),
    },
    {
      // Both: the log line stays the record any aggregator can read, and the
      // registry is what a scraper reads. Losing one must not lose the other.
      provide: METRICS,
      useFactory: (config: AppConfig, registry: MetricsRegistry) =>
        new TeeMetrics([
          new LogMetrics(createLogger({ level: config.LOG_LEVEL, name: 'gogo-metrics' })),
          registry,
        ]),
      inject: [APP_CONFIG, METRICS_REGISTRY],
    },
    {
      // ADR-0007: the real adapter is only bound when the flag *and* a key are
      // present. Everywhere else the straight-line estimate answers, which is
      // also the fallback path when quota runs out.
      provide: TRAVEL_TIME_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) => {
        const key = config.GOOGLE_ROUTES_API_KEY || config.GOOGLE_MAPS_API_KEY;
        return config.FLAG_ROUTES_API && key
          ? new GoogleRoutesAdapter(key, metrics)
          : new HaversineTravelTime();
      },
      inject: [APP_CONFIG, METRICS],
    },
    { provide: PUSH_PROVIDER, useClass: FakePush },
    {
      // Real R2 the moment credentials exist; the fake keeps every other
      // environment able to run the whole upload flow without them.
      provide: STORAGE_PROVIDER,
      useFactory: (config: AppConfig) =>
        config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_BUCKET
          ? new R2StorageAdapter({
              accountId: config.R2_ACCOUNT_ID,
              accessKeyId: config.R2_ACCESS_KEY_ID,
              secretAccessKey: config.R2_SECRET_ACCESS_KEY,
              bucket: config.R2_BUCKET,
            })
          : new FakeStorage(),
      inject: [APP_CONFIG],
    },
    {
      /*
       * #247 — queue depth for the ops view.
       *
       * Read-only: `Queue` handles, never a `Worker`, so an API replica
       * inspecting a queue cannot start consuming from it.
       *
       * Off in tests, where there is no Redis and a lazy connection would
       * retry in the background for the whole run. The endpoint then reports
       * redis and worker as `unknown` — which is the truth about a deployment
       * with no queue connection, and the thing the console is built to show.
       */
      provide: QUEUE_STATS,
      useFactory: (config: AppConfig): QueueStatsPort => {
        if (!config.REDIS_URL || config.NODE_ENV === 'test') return new FakeQueueStats();
        return new BullMqQueueStats([...WORKER_QUEUES], config.REDIS_URL);
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [
    METRICS_REGISTRY,
    PLACE_PROVIDER,
    AREA_AUTOCOMPLETE,
    SHEETS_PROVIDER,
    TRAVEL_TIME_PROVIDER,
    PUSH_PROVIDER,
    STORAGE_PROVIDER,
    QUEUE_STATS,
    METRICS,
  ],
})
export class ProvidersModule {}
