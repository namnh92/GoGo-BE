import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { breakerSnapshots, type QueueStats } from '@gogo/providers';
import { type Db } from '@gogo/database';
import { APP_CONFIG } from '../../shared/config';
import { DB } from '../../shared/tokens';

/**
 * `unknown` is a first-class answer, not a fallback.
 *
 * A dependency nobody has checked is not healthy. Reporting it as healthy is
 * how a dashboard becomes the last place to learn about an outage, and it is
 * the failure this whole endpoint exists to avoid — GoGo-CMS deliberately
 * renders "chưa nối" today rather than a hard-coded green tick (GoGo-CMS#71).
 */
export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export type ServiceHealth = {
  key: string;
  status: ServiceStatus;
  latencyMs?: number;
  checkedAt: string;
  /** Why it is `unknown` or `degraded`, in words the console can show. */
  detail?: string;
};

export type CostLine = {
  key: string;
  today: number;
  monthToDate: number;
  currency: string;
  basis: 'billed' | 'estimated';
  quotaUsedRatio?: number;
};

/** How long a health snapshot is reused. This is a screen, not an alerting path. */
const HEALTH_CACHE_MS = 20_000;

/**
 * A worker whose newest heartbeat is older than this is down. The worker
 * writes every 60s; three missed beats is a stop, not a slow tick.
 */
export const WORKER_HEARTBEAT_STALE_MS = 3 * 60_000;

export type HeartbeatRow = { worker_id: string; last_seen_at: Date | string };

/**
 * Worker liveness from the heartbeats it writes. Pure, so the thresholds can
 * be tested without a database.
 *
 * This replaced an inference from BullMQ — "a queue with work and no
 * consumer" — which stopped meaning anything when the worker stopped using a
 * broker (#262) and reported healthy unconditionally from then on. A heartbeat
 * that stops being written exactly when the worker stops is not a weakness of
 * the method; it is the whole method.
 */
export function workerHealthFrom(
  rows: readonly HeartbeatRow[],
  now: number,
  checkedAt: string,
): ServiceHealth {
  if (rows.length === 0) {
    return {
      key: 'worker',
      status: 'unknown',
      checkedAt,
      detail: 'No worker has written a heartbeat yet',
    };
  }
  const ages = rows.map((r) => now - new Date(r.last_seen_at).getTime());
  const newest = Math.min(...ages);
  if (newest <= WORKER_HEARTBEAT_STALE_MS) {
    return { key: 'worker', status: 'healthy', checkedAt };
  }
  return {
    key: 'worker',
    status: 'down',
    checkedAt,
    detail: `Last heartbeat ${Math.round(newest / 60_000)} min ago`,
  };
}

type ObservabilityConfig = { REDIS_URL?: string; NODE_ENV?: string };

/**
 * BE-CMS-G8 (#247) — the operations view.
 *
 * `/health` and `/metrics` already exist, but neither is reachable from the
 * console: the CMS Worker proxies `/v1/*` only, and Prometheus text is not
 * something a client should be parsing. This is the same information, inside
 * the contract, shaped for a screen.
 */
@Injectable()
export class CmsObservabilityService {
  private cached: { at: number; services: ServiceHealth[] } | null = null;
  private redis: IORedis | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: ObservabilityConfig,
  ) {}

  async health(): Promise<{ services: ServiceHealth[] }> {
    if (this.cached && Date.now() - this.cached.at < HEALTH_CACHE_MS) {
      return { services: this.cached.services };
    }
    const checkedAt = new Date().toISOString();

    const [db, redis, worker] = await Promise.all([
      this.probe('db', () => this.db.execute(sql`select 1`)),
      this.redisHealth(checkedAt),
      this.workerHealth(checkedAt),
    ]);
    // Answering at all is the only claim this row makes, and it is a true one.
    const api: ServiceHealth = { key: 'api', status: 'healthy', checkedAt };

    const services: ServiceHealth[] = [api, db, redis, worker];

    /*
     * Providers come from the circuit breaker rather than from live calls.
     * Probing Google to colour a dashboard would spend quota on a screen
     * refresh — and quota exhaustion is itself one of the outages this is
     * supposed to show. The breaker already knows what real traffic found.
     */
    for (const snapshot of breakerSnapshots()) {
      services.push({
        key: snapshot.name,
        status: snapshot.open ? 'down' : snapshot.consecutiveFailures > 0 ? 'degraded' : 'healthy',
        checkedAt,
        ...(snapshot.open
          ? { detail: 'Circuit open — calls are failing fast into the deterministic fallback' }
          : snapshot.consecutiveFailures > 0
            ? {
                detail: `${snapshot.consecutiveFailures} consecutive failures since the last success`,
              }
            : {}),
      });
    }

    this.cached = { at: Date.now(), services };
    return { services };
  }

  /**
   * One PING, behind the 20-second cache above. That is the entire Redis cost
   * of an open dashboard — it used to read three broker queues per refresh.
   */
  private async redisHealth(checkedAt: string): Promise<ServiceHealth> {
    if (!this.config.REDIS_URL || this.config.NODE_ENV === 'test') {
      return {
        key: 'redis',
        status: 'unknown',
        checkedAt,
        detail: 'No Redis configured for this deployment',
      };
    }
    if (!this.redis) {
      this.redis = new IORedis(this.config.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 800,
        enableOfflineQueue: true,
        retryStrategy: (times) => (times > 2 ? null : 200),
      });
      this.redis.on('error', () => undefined);
    }
    const client = this.redis;
    return this.probe('redis', async () => {
      const pong = await Promise.race([
        client.ping(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 800)),
      ]);
      if (pong !== 'PONG') throw new Error('unexpected reply');
    });
  }

  private async workerHealth(checkedAt: string): Promise<ServiceHealth> {
    try {
      const result = await this.db.execute(
        sql`select worker_id, last_seen_at from worker_heartbeats`,
      );
      return workerHealthFrom(result.rows as HeartbeatRow[], Date.now(), checkedAt);
    } catch {
      return { key: 'worker', status: 'unknown', checkedAt, detail: 'Heartbeat table unreadable' };
    }
  }

  private async probe(key: string, fn: () => Promise<unknown>): Promise<ServiceHealth> {
    const started = Date.now();
    try {
      await fn();
      return {
        key,
        status: 'healthy',
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        key,
        status: 'down',
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Queue depth. Only the transactional outbox — a queue in every sense that
   * matters here, living in Postgres. The worker stopped using a broker
   * (#262), so there is nothing else to report.
   */
  async queueStats(): Promise<{ queues: QueueStats[] }> {
    return { queues: [await this.outboxStats()] };
  }

  private async outboxStats(): Promise<QueueStats> {
    const result = await this.db.execute(sql`
      select
        count(*) filter (where published_at is null and failed_at is null)::int as pending,
        count(*) filter (where failed_at is not null)::int as dead_letter,
        count(*) filter (where failed_at is not null and failed_at > now() - interval '24 hours')::int as failed_24h,
        extract(epoch from (now() - min(occurred_at) filter (where published_at is null and failed_at is null)))::int as oldest_seconds
      from outbox_events
    `);
    const row = result.rows[0] as {
      pending: number;
      dead_letter: number;
      failed_24h: number;
      oldest_seconds: number | null;
    };
    return {
      name: 'outbox_events',
      source: 'database',
      pending: row.pending,
      // The relay claims a batch inside one statement; nothing is observably
      // "running" from outside it, and reporting a guess would be worse than
      // reporting zero with this comment next to it.
      running: 0,
      failed24h: row.failed_24h,
      failed24hTruncated: false,
      deadLetter: row.dead_letter,
      oldestPendingSeconds: row.oldest_seconds ?? null,
      workers: null,
    };
  }

  /**
   * Cost and quota.
   *
   * **Returns only providers with a real source, and today there are none.**
   * That is the honest answer, not a gap in the implementation:
   *
   * - No provider billing API is wired up, so nothing is `billed`.
   * - `places_provider_cost_units` counts SKU *units*, not money, and lives in
   *   an in-process registry that resets on deploy. It cannot answer "today"
   *   or "month to date" — a number derived from it would be an arbitrary
   *   fraction of the truth, wearing a currency symbol.
   *
   * An empty list must render as "no cost source connected", never as a zero.
   * `0 ₫` spent is a very different claim from "we do not know", and the one
   * this endpoint can support is the second.
   *
   * Turning this into real numbers needs persisted per-day provider usage —
   * tracked separately, not faked here.
   */
  async costs(): Promise<{ providers: CostLine[]; sourcesConfigured: boolean }> {
    const providers: CostLine[] = [];
    return { providers, sourcesConfigured: providers.length > 0 };
  }
}
