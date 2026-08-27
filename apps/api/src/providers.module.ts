import { Global, Module } from '@nestjs/common';
import {
  AREA_AUTOCOMPLETE,
  FakeAreaAutocomplete,
  FakePlaceProvider,
  FakePush,
  FakeStorage,
  GooglePlacesAdapter,
  PLACE_PROVIDER,
  PUSH_PROVIDER,
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
    { provide: PUSH_PROVIDER, useClass: FakePush },
    { provide: STORAGE_PROVIDER, useClass: FakeStorage },
  ],
  exports: [PLACE_PROVIDER, AREA_AUTOCOMPLETE, PUSH_PROVIDER, STORAGE_PROVIDER],
})
export class ProvidersModule {}
