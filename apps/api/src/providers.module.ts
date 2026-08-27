import { Global, Module } from '@nestjs/common';
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
  STORAGE_PROVIDER,
  TRAVEL_TIME_PROVIDER,
} from '@gogo/providers';
import { LogMetrics, METRICS, createLogger, type MetricsPort } from '@gogo/observability';
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
      provide: METRICS,
      useFactory: (config: AppConfig) =>
        new LogMetrics(createLogger({ level: config.LOG_LEVEL, name: 'gogo-metrics' })),
      inject: [APP_CONFIG],
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
    { provide: STORAGE_PROVIDER, useClass: FakeStorage },
  ],
  exports: [
    PLACE_PROVIDER,
    AREA_AUTOCOMPLETE,
    SHEETS_PROVIDER,
    TRAVEL_TIME_PROVIDER,
    PUSH_PROVIDER,
    STORAGE_PROVIDER,
    METRICS,
  ],
})
export class ProvidersModule {}
