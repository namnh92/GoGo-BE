import { Queue, type ConnectionOptions } from 'bullmq';
import type { QueueStats, QueueStatsPort } from '@gogo/providers';

/**
 * BullMQ builds its own client from these parts rather than being handed an
 * `ioredis` instance. `apps/api` is on ioredis 6 and BullMQ 5 is typed against
 * 5, so passing an instance is a type error — and, worse, would be two client
 * majors talking to one server if the cast were forced.
 */
export function redisConnectionFrom(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    // `rediss://` is TLS. Upstash and every managed provider serve it.
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    // This process only reads counts; it must never hold a command waiting for
    // a reconnect that a dashboard refresh does not care about.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  };
}

/**
 * How many recent failed jobs are scanned to count the last 24 hours.
 *
 * BullMQ counts *retained* failures, which is a different number: retention is
 * a configuration, so "failed" answers "how many are still on disk", not "how
 * many broke today". Getting the real answer means reading job timestamps, and
 * reading all of them on a large queue would make a dashboard refresh a Redis
 * problem. Capped, and the cap is reported.
 */
const FAILED_SCAN_CAP = 1000;

/**
 * #247 — queue depth for the ops view, read through BullMQ's own API.
 *
 * Not by reading `bull:*` keys directly: the key layout is BullMQ's internal
 * business and has changed between majors, so a dashboard built on it breaks
 * on an upgrade that the type checker sees nothing wrong with.
 *
 * This adapter only reads. It creates `Queue` handles, never a `Worker`, so an
 * API replica inspecting a queue cannot start consuming from it.
 */
export class BullMqQueueStats implements QueueStatsPort {
  readonly backend = 'broker' as const;

  private readonly queues: Queue[];

  constructor(names: string[], redisUrl: string) {
    const connection = redisConnectionFrom(redisUrl);
    this.queues = names.map((name) => new Queue(name, { connection }));
  }

  async list(): Promise<QueueStats[]> {
    return Promise.all(this.queues.map((queue) => this.statsFor(queue)));
  }

  async close(): Promise<void> {
    await Promise.all(this.queues.map((q) => q.close()));
  }

  private async statsFor(queue: Queue): Promise<QueueStats> {
    const [counts, waiting, failed, workers] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      queue.getWaiting(0, 0),
      queue.getFailed(0, FAILED_SCAN_CAP - 1),
      // Connected consumers. Zero on a queue that has work is the signal worth
      // waking someone for, and no count of jobs shows it.
      queue.getWorkers().catch(() => null),
    ]);

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = failed.filter((job) => (job.finishedOn ?? job.timestamp) >= since);
    const oldest = waiting[0];

    return {
      name: queue.name,
      source: 'bullmq',
      pending: (counts.waiting ?? 0) + (counts.delayed ?? 0),
      running: counts.active ?? 0,
      failed24h: recent.length,
      failed24hTruncated: failed.length === FAILED_SCAN_CAP,
      // BullMQ retries in place and keeps the job in `failed` once its
      // attempts run out, so the exhausted ones are the dead letter.
      deadLetter: counts.failed ?? 0,
      oldestPendingSeconds: oldest
        ? Math.max(0, Math.round((Date.now() - oldest.timestamp) / 1000))
        : null,
      workers: workers ? workers.length : null,
    };
  }
}
