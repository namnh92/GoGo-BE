import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { UPSTASH_REDIS_OPERATIONS } from '@gogo/cost-observability';
import {
  NoopMetrics,
  recordRuntimeCall,
  RUNTIME_METRICS,
  RUNTIME_STATE,
  type MetricsPort,
  type RuntimeCallStatus,
  type RuntimeStateStore,
} from '@gogo/observability';
import IORedis from 'ioredis';
import type { RedisLike } from './redis-rate-limit.store';

/**
 * COST-BE-037 (#424) — the rate-limit store's Redis client, connected before
 * the first request instead of by the first request.
 *
 * The client is `lazyConnect` with the offline queue **off**: a command that
 * arrives while the socket is still coming up is refused at once rather than
 * held, and `FallbackRateLimitStore` answers from memory. That is the right
 * behaviour during an outage (a rate-limit check must never wait on Redis),
 * but it also made the very first hit after every boot an `error` — the
 * telemetry from #414 showed one `status="error"` per process start, and
 * that one request was limited per process only.
 *
 * So the connection is opened at bootstrap, bounded by `RATE_LIMIT_REDIS_WARMUP_MS`,
 * and never fatal: Redis down at startup logs a warning and the store fails
 * open per hit exactly as before, reconnecting in the background under
 * ioredis's retry strategy. Readiness (`/v1/health/ready`) is unchanged and
 * still gates on the database alone.
 */
export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');

/** What the warm-up needs from a client: the store's slice plus ioredis's lazy `connect()`. */
export type RateLimitRedis = RedisLike & { connect(): Promise<void>; status?: string };

export const RATE_LIMIT_REDIS_WARMUP_MS = 2_000;

export function createRateLimitRedis(url: string): IORedis {
  const redis = new IORedis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on('error', () => {
    /* handled by the fallback wrapper per hit */
  });
  return redis;
}

export type WarmupOutcome = 'ready' | 'already' | 'unavailable' | 'timeout';

/** #427 — how the one boot attempt is recorded: a ready connection is `ok`, whoever opened it. */
export function warmupStatus(outcome: WarmupOutcome): RuntimeCallStatus {
  return outcome === 'ready' || outcome === 'already' ? 'ok' : outcome;
}

/**
 * Connect, bounded, never throwing. `ready` when the connection came up in
 * time, `already` when it was up, `unavailable` when Redis refused or the
 * client rejected, `timeout` when it is still connecting — the last two both
 * leave the client reconnecting on its own; the store fails open meanwhile.
 */
export async function warmRateLimitRedis(
  redis: RateLimitRedis,
  timeoutMs = RATE_LIMIT_REDIS_WARMUP_MS,
): Promise<WarmupOutcome> {
  if (redis.status === 'ready') return 'already';
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([redis.connect().then(() => 'ready' as const), expiry]);
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class RateLimitRedisWarmup implements OnApplicationBootstrap {
  private readonly logger = new Logger(RateLimitRedisWarmup.name);

  constructor(
    @Optional() @Inject(RATE_LIMIT_REDIS) private readonly redis: RateLimitRedis | null = null,
    /** #427 — one `upstash.redis.rate_limit.connect` record per boot, on the runtime series. */
    @Optional() @Inject(RUNTIME_METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    /** #427 — this process's last outcome, for the Cost API's `runtime.connection`. */
    @Optional() @Inject(RUNTIME_STATE) private readonly state: RuntimeStateStore | null = null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.redis) return;
    const started = Date.now();
    const outcome = await warmRateLimitRedis(this.redis);
    const status = warmupStatus(outcome);
    recordRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.rateLimitConnect, status, started);
    this.state?.record(UPSTASH_REDIS_OPERATIONS.rateLimitConnect, status);
    if (status === 'ok') {
      this.logger.log('rate-limit Redis connected before the first request');
      return;
    }
    this.logger.warn(
      `rate-limit Redis not ready at startup (${outcome}); limits fail open to memory until it connects`,
    );
  }
}
