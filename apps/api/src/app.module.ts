import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  IdentityModule,
  PlacesModule,
  PreferencesModule,
  RoomsModule,
  SearchModule,
} from '@gogo/modules';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { APP_CONFIG, loadEnv } from './config/env';
import { DatabaseModule } from './database.module';
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
    IdentityModule,
    RoomsModule,
    PreferencesModule,
    PlacesModule,
    SearchModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
})
export class AppModule {}
