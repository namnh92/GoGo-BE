import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@gogo/database';
import { DB } from '@gogo/modules';
import { APP_CONFIG, type AppConfig } from './config/env';

type PoolLike = { end(): Promise<void> };

const DB_POOL = Symbol('DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      useFactory: (config: AppConfig) => createDb(config.DATABASE_URL),
      inject: [APP_CONFIG],
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
