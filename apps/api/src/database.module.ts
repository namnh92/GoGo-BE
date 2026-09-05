import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@gogo/database';
import { DB, NEON_POSTGRES_OPERATIONS } from '@gogo/modules';
import { RUNTIME_METRICS, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG, type AppConfig } from './config/env';

type PoolLike = { end(): Promise<void> };

const DB_POOL = Symbol('DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      // #414 — every statement timed as `neon.postgres.query`, into the
      // registry sink when the process has one (optional: a test module or a
      // script builds a pool with no metrics and measures nothing).
      useFactory: (config: AppConfig, metrics?: MetricsPort) =>
        createDb(config.DATABASE_URL, {
          max: config.DB_POOL_MAX,
          ...(metrics ? { runtime: { metrics, operation: NEON_POSTGRES_OPERATIONS.query } } : {}),
        }),
      inject: [APP_CONFIG, { token: RUNTIME_METRICS, optional: true }],
    },
    {
      provide: DB,
      useFactory: (bundle: { db: Db }) => bundle.db,
      inject: [DB_POOL],
    },
  ],
  exports: [DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly bundle: { pool: PoolLike }) {}

  async onApplicationShutdown(): Promise<void> {
    await this.bundle.pool.end();
  }
}
