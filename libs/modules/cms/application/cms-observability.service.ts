import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  breakerSnapshots,
  QUEUE_STATS,
  type QueueStats,
  type QueueStatsPort,
} from '@gogo/providers';
import { type Db } from '@gogo/database';
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

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(QUEUE_STATS) private readonly queues?: QueueStatsPort,
  ) {}

  async health(): Promise<{ services: ServiceHealth[] }> {
    if (this.cached && Date.now() - this.cached.at < HEALTH_CACHE_MS) {
      return { services: this.cached.services };
    }
    const checkedAt = new Date().toISOString();

    const db = await this.probe('db', () => this.db.execute(sql`select 1`));
    // Answering at all is the only claim this row makes, and it is a true one.
    const api: ServiceHealth = { key: 'api', status: 'healthy', checkedAt };

    /*
     * Redis and the worker come out of one queue read rather than two checks.
     * A successful `list()` is already a Redis round-trip, so opening a second
     * connection to ping would add a failure mode without adding information —
     * and would let the two rows disagree about the same server.
     */
    const queues = await this.readQueues();
    const services: ServiceHealth[] = [
      api,
      db,
      this.redisHealth(queues, checkedAt),
      this.workerHealth(queues, checkedAt),
    ];

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

  /** One queue read, shared by the redis row, the worker row and `/queues`. */
  private async readQueues(): Promise<QueueStats[] | 'unconfigured' | 'unreachable'> {
    // A port with no broker behind it measures nothing about Redis, whatever
    // it returns. Treating its empty answer as a successful round-trip is how
    // a deployment with no queue connection reports itself healthy.
    if (!this.queues || this.queues.backend === 'none') return 'unconfigured';
    try {
      return await this.queues.list();
    } catch {
      return 'unreachable';
    }
  }

  private redisHealth(
    queues: QueueStats[] | 'unconfigured' | 'unreachable',
    checkedAt: string,
  ): ServiceHealth {
    if (queues === 'unconfigured') {
      return {
        key: 'redis',
        status: 'unknown',
        checkedAt,
        detail: 'No queue connection configured for this deployment',
      };
    }
    if (queues === 'unreachable') {
      return { key: 'redis', status: 'down', checkedAt, detail: 'Queue backend did not answer' };
    }
    return { key: 'redis', status: 'healthy', checkedAt };
  }

  /**
   * Worker liveness from the queues it consumes. A queue with work and no
   * connected consumer is the shape of a dead worker, and it is a fact read
   * from Redis rather than a claim the worker makes about itself — a heartbeat
   * the worker writes stops being evidence exactly when the worker stops.
   *
   * Idle with an empty queue is not evidence either way, so it stays
   * `healthy`: a correctly-running deployment with nothing to do must not page
   * anyone.
   */
  private workerHealth(
    queues: QueueStats[] | 'unconfigured' | 'unreachable',
    checkedAt: string,
  ): ServiceHealth {
    if (queues === 'unconfigured') {
      return {
        key: 'worker',
        status: 'unknown',
        checkedAt,
        detail: 'No queue connection configured for this deployment',
      };
    }
    if (queues === 'unreachable') {
      return { key: 'worker', status: 'unknown', checkedAt, detail: 'Queue backend unreachable' };
    }
    const measurable = queues.filter((q) => q.workers !== null);
    if (measurable.length === 0) {
      return { key: 'worker', status: 'unknown', checkedAt, detail: 'Consumer count not reported' };
    }
    const idle = measurable.filter((q) => q.workers === 0 && q.pending > 0);
    return {
      key: 'worker',
      status: idle.length > 0 ? 'down' : 'healthy',
      checkedAt,
      ...(idle.length > 0
        ? { detail: `No consumer on: ${idle.map((q) => q.name).join(', ')}` }
        : {}),
    };
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
   * Queue depth, plus the transactional outbox — which is a queue in every
   * sense that matters here and lives in Postgres, so BullMQ cannot see it.
   * Leaving it out would hide the backlog that actually delays notifications.
   */
  async queueStats(): Promise<{ queues: QueueStats[] }> {
    const [fromBroker, outbox] = await Promise.all([this.readQueues(), this.outboxStats()]);
    // A broker that is unconfigured or unreachable contributes no rows rather
    // than rows of zeros; `/health` is where that distinction is reported.
    return { queues: [...(Array.isArray(fromBroker) ? fromBroker : []), outbox] };
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
