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
  PLACE_PROVIDER,
  PUSH_PROVIDER,
  SHEETS_PROVIDER,
  R2StorageAdapter,
  STORAGE_PROVIDER,
  TRAVEL_TIME_PROVIDER,
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
        config.GOOGLE_PLACES_API_KEY
          ? new GooglePlacesAdapter(config.GOOGLE_PLACES_API_KEY, metrics)
          : new FakePlaceProvider(),
      inject: [APP_CONFIG, METRICS],
    },
    {
      provide: AREA_AUTOCOMPLETE,
      useFactory: (config: AppConfig) =>
        config.GOOGLE_PLACES_API_KEY
          ? new GooglePlacesAdapter(config.GOOGLE_PLACES_API_KEY)
          : new FakeAreaAutocomplete(),
      inject: [APP_CONFIG],
    },
    {
      // PI-BE-012: the Sheets read takes its own key and no other. PI-BE-021:
      // without it the fake is bound and every import fails — exercisable end
      // to end is what it does in a test, not what it does in a deployed
      // environment. onModuleInit says so out loud.
      provide: SHEETS_PROVIDER,
      useFactory: (config: AppConfig) =>
        config.GOOGLE_SHEETS_API_KEY
          ? new GoogleSheetsAdapter(config.GOOGLE_SHEETS_API_KEY)
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
    warnFakedProviders(this.config, (meta, message) => logger.warn(meta, message));
  }
}
