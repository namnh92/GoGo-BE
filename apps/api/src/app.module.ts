import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { APP_CONFIG, loadEnv } from './config/env';
import { HealthController } from './health/health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadEnv() },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
  exports: [APP_CONFIG],
})
export class AppModule {}
