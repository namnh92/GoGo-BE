import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from '@gogo/modules';
import {
  CmsModule,
  FeedbackModule,
  IdentityModule,
  IngestionModule,
  NotificationsModule,
  PlacesModule,
  PlansModule,
  PreferencesModule,
  RealtimeBusModule,
  ReviewsModule,
  RoomEventsModule,
  RoomsModule,
  SearchModule,
  ShareLinksModule,
  SuggestionsModule,
  TravelModule,
  UploadsModule,
} from '@gogo/modules';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { APP_CONFIG, loadEnv } from './config/env';
import { DatabaseModule } from './database.module';
import { ProvidersModule } from './providers.module';
import { DocsController } from './health/docs.controller';
import { HealthController } from './health/health.controller';
import { MetricsController } from './health/metrics.controller';

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
    RealtimeBusModule,
    FeedbackModule,
    IdentityModule,
    RoomsModule,
    RoomEventsModule,
    PreferencesModule,
    PlacesModule,
    SearchModule,
    SuggestionsModule,
    PlansModule,
    ReviewsModule,
    NotificationsModule,
    ShareLinksModule,
    CmsModule,
    IngestionModule,
    UploadsModule,
  ],
  controllers: [HealthController, DocsController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
