import type { OnModuleDestroy } from '@nestjs/common';
import type { SubmissionDisplaySnapshot } from '@gogo/database';
import { UPSTASH_REDIS_OPERATIONS } from '@gogo/cost-observability';
import { meterRuntimeCall, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { submissionDisplaySnapshotSchema } from '../domain/submission-display-snapshot';

type ResolutionRecord = {
  googlePlaceId: string;
  expiresAt: string;
  snapshot: SubmissionDisplaySnapshot;
};

/** Shared Redis connection, owned and warmed by IdentityModule. */
export type ResolutionRedis = {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

/** #801: one record per resolution, never a reusable cache keyed by Place ID. */
export class ResolutionSnapshotStore implements OnModuleDestroy {
  private readonly memory = new Map<string, { value: string; timer: NodeJS.Timeout }>();

  constructor(
    private readonly redis: ResolutionRedis | null,
    private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async put(id: string, record: ResolutionRecord): Promise<void> {
    const snapshot = submissionDisplaySnapshotSchema.parse(record.snapshot);
    const expiresAt = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new Error('Resolution expired');
    const value = JSON.stringify({ ...record, snapshot });
    const redis = this.redis;
    if (redis) {
      await meterRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.resolutionSnapshotPut, () =>
        redis.eval(
          "return redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[2])",
          1,
          `place-resolution:${id}`,
          value,
          expiresAt,
        ),
      );
      return;
    }
    // Test/single-instance dev only. No local fallback during Redis outages.
    if (this.memory.size >= 1000) throw new Error('Resolution store full');
    const timer = setTimeout(() => this.memory.delete(id), expiresAt - Date.now());
    timer.unref();
    clearTimeout(this.memory.get(id)?.timer);
    this.memory.set(id, { value, timer });
  }

  async get(
    id: string,
    expected: { googlePlaceId: string; verifiedAt: string; expiresAt: string },
  ) {
    const redis = this.redis;
    const value = redis
      ? await meterRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.resolutionSnapshotGet, () =>
          redis.eval("return redis.call('GET', KEYS[1])", 1, `place-resolution:${id}`),
        )
      : this.memory.get(id)?.value;
    if (typeof value !== 'string') return undefined;
    try {
      const record = JSON.parse(value) as ResolutionRecord;
      const snapshot = submissionDisplaySnapshotSchema.safeParse(record.snapshot);
      if (
        record.googlePlaceId !== expected.googlePlaceId ||
        record.expiresAt !== expected.expiresAt ||
        Date.now() >= Date.parse(record.expiresAt) ||
        !snapshot.success ||
        snapshot.data.fetchedAt !== expected.verifiedAt
      )
        return undefined;
      return snapshot.data;
    } catch {
      return undefined;
    }
  }

  onModuleDestroy(): void {
    for (const entry of this.memory.values()) clearTimeout(entry.timer);
    this.memory.clear();
  }
}
