import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from '@gogo/modules';
import {
  CmsModule,
  IdentityModule,
  IngestionModule,
  NotificationsModule,
  PlacesModule,
  PlansModule,
  PreferencesModule,
  ReviewsModule,
  RoomsModule,
  SearchModule,
  SuggestionsModule,
  TravelModule,
} from '@gogo/modules';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { APP_CONFIG, loadEnv } from './config/env';
import { DatabaseModule } from './database.module';
import { ProvidersModule } from './providers.module';
import { DocsController } from './health/docs.controller';
import { HealthController } from './health/health.controller';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadEnv() }],
  exports: [APP_CONFIG],
})
class ConfigModule {}

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ProvidersModule,
    TravelModule,
    IdentityModule,
    RoomsModule,
    PreferencesModule,
    PlacesModule,
    SearchModule,
    SuggestionsModule,
    PlansModule,
    ReviewsModule,
    NotificationsModule,
    CmsModule,
    IngestionModule,
  ],
  controllers: [HealthController, DocsController],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
