import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import {
  AREA_AUTOCOMPLETE,
  FakeAreaAutocomplete,
  FakePlaceProvider,
  FakePush,
  FakeSheets,
  FakeStorage,
  GooglePlacesAdapter,
  GoogleRoutesAdapter,
  GoogleSheetsAdapter,
  HaversineTravelTime,
  METRICS_QUERY,
  PLACE_PROVIDER,
  PrometheusQueryAdapter,
  PUSH_PROVIDER,
  SHEETS_PROVIDER,
  R2StorageAdapter,
  STORAGE_PROVIDER,
  TRAVEL_TIME_PROVIDER,
  UnconfiguredPlaceProvider,
  placeProviderStatus,
  warnFakedProviders,
} from '@gogo/providers';
import {
  LogMetrics,
  METRICS,
  MetricsRegistry,
  TeeMetrics,
  createLogger,
  type MetricsPort,
} from '@gogo/observability';
import { type Db } from '@gogo/database';
import { DB, DbUsageLedger } from '@gogo/modules';
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
      // #279: the mode decides, not the presence of a secret. `google` with no
      // key binds a provider that refuses — never the fake, which would answer
      // a real Google Maps link with "no such place".
      provide: PLACE_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) => {
        const status = placeProviderStatus(config);
        if (status.provider === 'fake') return new FakePlaceProvider();
        if (status.provider === 'unconfigured') return new UnconfiguredPlaceProvider();
        return new GooglePlacesAdapter(config.GOOGLE_PLACES_API_KEY, metrics);
      },
      inject: [APP_CONFIG, METRICS],
    },
    {
      provide: AREA_AUTOCOMPLETE,
      // #321: `metrics` was missing here while the PLACE_PROVIDER binding above
      // had it, so every `google.autocomplete` call — a billed SKU — went
      // uncounted, unlatched from the failure counter and absent from the cost
      // total. Two adapters, one of them instrumented, is worse than neither:
      // the number that exists looks complete.
      useFactory: (config: AppConfig, metrics: MetricsPort) => {
        const status = placeProviderStatus(config);
        if (status.provider === 'fake') return new FakeAreaAutocomplete();
        if (status.provider === 'unconfigured') return new UnconfiguredPlaceProvider();
        return new GooglePlacesAdapter(config.GOOGLE_PLACES_API_KEY, metrics);
      },
      inject: [APP_CONFIG, METRICS],
    },
    {
      // PI-BE-012: the Sheets read takes its own key and no other. PI-BE-021:
      // without it the fake is bound and every import fails — exercisable end
      // to end is what it does in a test, not what it does in a deployed
      // environment. onModuleInit says so out loud.
      provide: SHEETS_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) =>
        config.GOOGLE_SHEETS_API_KEY
          ? new GoogleSheetsAdapter(config.GOOGLE_SHEETS_API_KEY, metrics)
          : new FakeSheets(),
      inject: [APP_CONFIG, METRICS],
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
      useFactory: (config: AppConfig, registry: MetricsRegistry, db: Db) => {
        const tee = new TeeMetrics([
          new LogMetrics(createLogger({ level: config.LOG_LEVEL, name: 'gogo-metrics' })),
          registry,
        ]);
        // #335 — the durable ledger wraps the metrics port rather than sitting
        // beside it, so every adapter is accounted for without any adapter
        // knowing, and a future adapter is covered by construction. It writes
        // on an interval, never on the request path (plan §2.3, option A).
        const ledger = new DbUsageLedger(tee, db, {
          environment: config.APP_ENV,
          enabled: config.COST_LEDGER_ENABLED,
          flushMs: config.COST_LEDGER_FLUSH_MS,
        });
        ledger.start();
        return ledger;
      },
      inject: [APP_CONFIG, METRICS_REGISTRY, DB],
    },
    {
      // ADR-0007: the real adapter is only bound when the flag *and* the Routes
      // key are present. Everywhere else the straight-line estimate answers,
      // which is also the fallback path when quota runs out.
      provide: TRAVEL_TIME_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) =>
        config.FLAG_ROUTES_API && config.GOOGLE_ROUTES_API_KEY
          ? new GoogleRoutesAdapter(config.GOOGLE_ROUTES_API_KEY, metrics)
          : new HaversineTravelTime(),
      inject: [APP_CONFIG, METRICS],
    },
    {
      /**
       * #315 — reading the store back, for the CMS ops dashboard only.
       *
       * Bound to `null` when unconfigured rather than to a fake: a fake would
       * answer a dashboard with invented traffic, and the one thing this
       * screen must never do is show a number nobody measured. The service
       * reports `backend.status: "unavailable"` instead.
       *
       * `metrics:read`, never the collector's `metrics:write` token.
       */
      provide: METRICS_QUERY,
      useFactory: (config: AppConfig) =>
        config.GRAFANA_PROM_URL && config.GRAFANA_PROM_USER && config.GRAFANA_READ_TOKEN
          ? new PrometheusQueryAdapter({
              url: config.GRAFANA_PROM_URL,
              username: config.GRAFANA_PROM_USER,
              token: config.GRAFANA_READ_TOKEN,
            })
          : null,
      inject: [APP_CONFIG],
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
  ],
  exports: [
    METRICS_REGISTRY,
    METRICS_QUERY,
    PLACE_PROVIDER,
    AREA_AUTOCOMPLETE,
    SHEETS_PROVIDER,
    TRAVEL_TIME_PROVIDER,
    PUSH_PROVIDER,
    STORAGE_PROVIDER,
    METRICS,
  ],
})
export class ProvidersModule implements OnModuleInit {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * PI-BE-021 — a fake bound in a deployed environment is a defect, and it used
   * to be an invisible one. Boot is the only moment the choice is still cheap
   * to notice; after that it surfaces as a support ticket about someone's
   * spreadsheet.
   */
  onModuleInit(): void {
    const logger = createLogger({ level: this.config.LOG_LEVEL, name: 'gogo-api' });
    const status = placeProviderStatus(this.config);
    warnFakedProviders({ ...this.config, PLACE_PROVIDER_MODE: status.mode }, (meta, message) =>
      logger.warn(meta, message),
    );
    // #279 — the ops signal. Always emitted, ready or not: "which provider is
    // this process on" is the first question every one of these incidents has
    // started with, and it was never written down anywhere. Carries the mode
    // and a reason code, never a key.
    const line = {
      port: 'PLACE_PROVIDER',
      mode: status.mode,
      provider: status.provider,
      ready: status.ready,
      ...(status.reason ? { reason: status.reason } : {}),
    };
    if (status.ready) logger.info(line, 'place provider ready');
    else logger.error(line, 'place provider NOT ready — place resolution will answer 503');
  }
}
