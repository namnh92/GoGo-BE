import { Global, Module } from '@nestjs/common';
import {
  AREA_AUTOCOMPLETE,
  FakeAreaAutocomplete,
  FakePlaceProvider,
  FakePush,
  FakeSheets,
  FakeStorage,
  GooglePlacesAdapter,
  GoogleSheetsAdapter,
  PLACE_PROVIDER,
  PUSH_PROVIDER,
  SHEETS_PROVIDER,
  STORAGE_PROVIDER,
} from '@gogo/providers';
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
      useFactory: (config: AppConfig) =>
        config.GOOGLE_MAPS_API_KEY
          ? new GooglePlacesAdapter(config.GOOGLE_MAPS_API_KEY)
          : new FakePlaceProvider(),
      inject: [APP_CONFIG],
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
    { provide: PUSH_PROVIDER, useClass: FakePush },
    { provide: STORAGE_PROVIDER, useClass: FakeStorage },
  ],
  exports: [PLACE_PROVIDER, AREA_AUTOCOMPLETE, SHEETS_PROVIDER, PUSH_PROVIDER, STORAGE_PROVIDER],
})
export class ProvidersModule {}
