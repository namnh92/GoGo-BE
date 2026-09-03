import { describe, expect, it } from 'vitest';
import type { CloudflareAnalyticsPort } from '@gogo/providers';
import { COST_REGISTRY } from '../domain/registry';
import { CollectorSchedulerService } from './collector-scheduler.service';
import {
  CLOUDFLARE_R2_COLLECTOR_ID,
  CLOUDFLARE_SOURCE,
  CLOUDFLARE_WORKERS_COLLECTOR_ID,
  cloudflareCollectorOptionsFromEnv,
  cloudflareCollectors,
  listFromEnv,
  previousDay,
  r2Samples,
  workersSamples,
} from './cloudflare.collector';

/**
 * COST-BE-024 (#383) — the pure parts: usage → meter rows, and the collector
 * definitions the scheduler is handed. The database side (replace-upsert,
 * freshness rows, estimator pricing) is `cost-cloudflare.int.spec.ts`.
 */

const CTX = {
  day: '2026-09-03',
  environment: 'dev',
  now: new Date('2026-09-03T06:00:00Z'),
  scope: 'filtered' as const,
};

describe('r2Samples', () => {
  it('writes the three billed meters with day totals across buckets, GB rounded up', () => {
    const rows = r2Samples(CTX, [
      {
        bucketName: 'gogo-dev-assets',
        classA: 125,
        classB: 5_000,
        unclassified: 0,
        byAction: { PutObject: 120, ListObjects: 5, GetObject: 4_300, HeadObject: 700 },
        peakBytes: 1_502_000_000,
        peakObjects: 1_234,
      },
      {
        bucketName: 'gogo-dev-public',
        classA: 0,
        classB: 9_000,
        unclassified: 0,
        byAction: { GetObject: 9_000 },
        peakBytes: 250_000_000,
        peakObjects: 40,
      },
    ]);
    expect(rows.map((r) => [r.usageMetricId, r.billingSkuId, r.unit, r.quantity])).toEqual([
      ['class_a', 'r2.class_a', 'operation', 125],
      ['class_b', 'r2.class_b', 'operation', 14_000],
      // 1.752 GB peak → 2 GB: a ceiling, never a floor.
      ['storage_gb_month', 'r2.storage', 'gb_month', 2],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        day: '2026-09-03',
        environment: 'dev',
        providerId: 'cloudflare',
        serviceId: 'cloudflare.r2',
        operationId: null,
        source: CLOUDFLARE_SOURCE,
        confidence: 'HIGH',
        sourceAsOf: CTX.now,
      });
      expect(r.metadata).toMatchObject({
        scope: 'filtered',
        buckets: ['gogo-dev-assets', 'gogo-dev-public'],
      });
    }
    expect(rows[0]!.metadata).toMatchObject({
      byAction: { PutObject: 120, ListObjects: 5, GetObject: 13_300, HeadObject: 700 },
      unclassified: 0,
    });
    expect(rows[2]!.metadata).toMatchObject({ peakBytes: 1_752_000_000, peakObjects: 1_274 });
    // Every meter named here exists in the registry under the SKU it claims.
    for (const r of rows) {
      const meter = COST_REGISTRY.meter(`${r.serviceId}/${r.usageMetricId}`);
      expect(meter, r.usageMetricId).not.toBeNull();
      expect(meter!.billingSkuId).toBe(r.billingSkuId);
      expect(meter!.unit).toBe(r.unit);
    }
  });

  it('a day with no usage is three zero rows — measured, not unknown', () => {
    const rows = r2Samples({ ...CTX, scope: 'account' }, []);
    expect(rows.map((r) => r.quantity)).toEqual([0, 0, 0]);
    expect(rows[0]!.metadata).toMatchObject({ scope: 'account', buckets: [] });
  });

  it('an unclassified action lowers the operation rows to MEDIUM and is named', () => {
    const rows = r2Samples(CTX, [
      {
        bucketName: 'b',
        classA: 1,
        classB: 2,
        unclassified: 3,
        byAction: { PutObject: 1, GetObject: 2, FrobnicateObject: 3 },
        peakBytes: 0,
        peakObjects: 0,
      },
    ]);
    expect(rows[0]).toMatchObject({ quantity: 1, confidence: 'MEDIUM' });
    expect(rows[1]).toMatchObject({ quantity: 2, confidence: 'MEDIUM' });
    expect(rows[0]!.metadata).toMatchObject({ unclassified: 3 });
    // Storage does not depend on the operations dataset.
    expect(rows[2]).toMatchObject({ quantity: 0, confidence: 'HIGH' });
  });
});

describe('workersSamples', () => {
  it('writes the requests meter and keeps errors/subrequests as metadata', () => {
    const rows = workersSamples(CTX, [
      { scriptName: 'gogo-dev-share-link', requests: 3_210, errors: 4, subrequests: 3_300 },
      { scriptName: 'other', requests: 10, errors: 0, subrequests: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serviceId: 'cloudflare.workers',
      usageMetricId: 'requests',
      billingSkuId: 'workers.requests',
      unit: 'request',
      quantity: 3_220,
      confidence: 'HIGH',
    });
    expect(rows[0]!.metadata).toMatchObject({
      scripts: ['gogo-dev-share-link', 'other'],
      errors: 4,
      subrequests: 3_300,
    });
  });
});

describe('collector definitions', () => {
  const fake: CloudflareAnalyticsPort = {
    r2Usage: async () => [],
    workersUsage: async () => [],
  };

  it('are the issue’s settings: 6h, 15s, retry 1, 8 calls/day, FREE, non-essential', () => {
    const [r2, workers] = cloudflareCollectors({} as never, fake);
    expect(r2).toMatchObject({
      id: CLOUDFLARE_R2_COLLECTOR_ID,
      providerId: 'cloudflare',
      serviceId: 'cloudflare.r2',
      capability: 'USAGE_COLLECTOR',
      frequencyMs: 6 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retry: { maxAttemptsPerTick: 1 },
      maxCallsPerDay: 8,
      enabledEnvironments: 'all',
      essential: false,
      monitoringCost: { model: 'FREE', estimatedMonthlyMicros: 0 },
    });
    expect(workers).toMatchObject({
      id: CLOUDFLARE_WORKERS_COLLECTOR_ID,
      serviceId: 'cloudflare.workers',
      maxCallsPerDay: 8,
      monitoringCost: { model: 'FREE' },
    });
  });

  it('register on the scheduler because the registry declares USAGE_COLLECTOR for cloudflare', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    for (const def of cloudflareCollectors({} as never, fake)) s.register(def);
    expect(s.registered().map((c) => c.id)).toEqual([
      CLOUDFLARE_R2_COLLECTOR_ID,
      CLOUDFLARE_WORKERS_COLLECTOR_ID,
    ]);
    expect(s.monitoring()).toMatchObject({ knownMonthlyMicros: 0, unknown: [], overBudget: false });
  });

  it('ask for yesterday and today, passing the scope filters and the abort signal', async () => {
    const asked: { kind: string; day: string; filter: unknown; signal: boolean }[] = [];
    const recording: CloudflareAnalyticsPort = {
      r2Usage: async (q) => {
        asked.push({
          kind: 'r2',
          day: q.day,
          filter: q.buckets,
          signal: q.signal instanceof AbortSignal,
        });
        return [];
      },
      workersUsage: async (q) => {
        asked.push({
          kind: 'workers',
          day: q.day,
          filter: q.scripts,
          signal: q.signal instanceof AbortSignal,
        });
        return [];
      },
    };
    const executed: unknown[] = [];
    const db = { execute: async (q: unknown) => void executed.push(q) };
    const [r2, workers] = cloudflareCollectors(db as never, recording, {
      buckets: ['gogo-dev-assets'],
      scripts: ['gogo-dev-share-link'],
      now: () => new Date('2026-09-03T06:00:00Z'),
    });
    const ctx = {
      environment: 'dev',
      now: new Date('2026-09-03T06:00:00Z'),
      day: '2026-09-03',
      signal: new AbortController().signal,
    };
    expect(await r2!.run(ctx)).toEqual({
      sourceAsOf: new Date('2026-09-03T06:00:00Z'),
      samples: 6,
    });
    expect(await workers!.run(ctx)).toEqual({
      sourceAsOf: new Date('2026-09-03T06:00:00Z'),
      samples: 2,
    });
    expect(asked).toEqual([
      { kind: 'r2', day: '2026-09-02', filter: ['gogo-dev-assets'], signal: true },
      { kind: 'r2', day: '2026-09-03', filter: ['gogo-dev-assets'], signal: true },
      { kind: 'workers', day: '2026-09-02', filter: ['gogo-dev-share-link'], signal: true },
      { kind: 'workers', day: '2026-09-03', filter: ['gogo-dev-share-link'], signal: true },
    ]);
    // One upsert per (collector, day).
    expect(executed).toHaveLength(4);
  });
});

describe('env helpers', () => {
  it('previousDay crosses month and year boundaries in UTC', () => {
    expect(previousDay('2026-09-03')).toBe('2026-09-02');
    expect(previousDay('2026-10-01')).toBe('2026-09-30');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
  });

  it('listFromEnv splits, trims and treats blank as unset', () => {
    expect(listFromEnv(undefined)).toBeUndefined();
    expect(listFromEnv('')).toBeUndefined();
    expect(listFromEnv(' , ')).toBeUndefined();
    expect(listFromEnv('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  it('cloudflareCollectorOptionsFromEnv only sets what is present', () => {
    expect(cloudflareCollectorOptionsFromEnv({})).toEqual({});
    expect(
      cloudflareCollectorOptionsFromEnv({
        CLOUDFLARE_R2_BUCKETS: 'gogo-dev-assets,gogo-dev-public',
        CLOUDFLARE_WORKER_SCRIPTS: '',
      }),
    ).toEqual({ buckets: ['gogo-dev-assets', 'gogo-dev-public'] });
  });
});
