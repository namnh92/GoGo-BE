import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { type Db } from '@gogo/database';
import { AppError, DB, Public } from '@gogo/modules';
import { APP_CONFIG, type AppConfig } from '../config/env';

@Controller('health')
export class HealthController {
  private redis: IORedis | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness — process is up. Cheap; used by container healthcheck. */
  @Public()
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness — dependencies actually answer. Uptime monitors point HERE so
   * downtime alerts cover DB/Redis, not just the Node process. 503 on failure.
   */
  @Public()
  @Get('ready')
  async readiness() {
    const checks: Record<string, 'ok' | 'failed' | 'skipped'> = {
      db: 'failed',
      redis: 'skipped',
    };

    try {
      await this.db.execute(sql`select 1`);
      checks.db = 'ok';
    } catch {
      checks.db = 'failed';
    }

    if (this.config.REDIS_URL && this.config.NODE_ENV !== 'test') {
      try {
        this.redis ??= new IORedis(this.config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 800,
          enableOfflineQueue: false,
        });
        this.redis.on('error', () => undefined);
        const pong = await Promise.race([
          this.redis.ping(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 800)),
        ]);
        checks.redis = pong === 'PONG' ? 'ok' : 'failed';
      } catch {
        checks.redis = 'failed';
      }
    }

    // Redis degrades gracefully (rate limits fail open, queues catch up), so
    // only the database gates readiness hard.
    if (checks.db !== 'ok') {
      throw new AppError(
        'NOT_READY',
        `dependencies failing: db=${checks.db} redis=${checks.redis}`,
        503,
        {
          retryable: true,
        },
      );
    }
    return { status: 'ready', checks };
  }
}
