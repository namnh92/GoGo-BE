import { describe, expect, it } from 'vitest';
import type { UpstashPoint, UpstashRedisStats, UpstashRedisStatsPort } from '@gogo/providers';
import { COST_REGISTRY } from '../../domain/registry';
import { CollectorSchedulerService } from '../../application/collector-scheduler.service';
import {
  UPSTASH_REDIS_COLLECTOR_ID,
  UPSTASH_SOURCE,
  coveredByWindow,
  redisSamples,
  upstashRedisCollector,
} from './upstash.collector';

/**
 * COST-BE-025 (#384) — the pure parts: stats → meter rows, and the collector
 * definition the scheduler is handed. The database side (replace-upsert,
 * freshness rows, estimator pricing) is `cost-upstash.int.spec.ts`.
 */

const NOW = new Date('2026-09-03T06:00:00Z');
const TODAY = { day: '2026-09-03', today: '2026-09-03', environment: 'dev', now: NOW };
const YESTERDAY = { ...TODAY, day: '2026-09-02' };

const pt = (day: string, value: number, time = '12:00:00'): UpstashPoint => ({
  day,
  at: new Date(`${day}T${time}Z`),
  value,
});

function stats(over: Partial<UpstashRedisStats> = {}): UpstashRedisStats {
  return {
    dailyNetCommands: 4_200,
    dailyBandwidthBytes: 9_000_000,
    currentStorageBytes: 12_000_000,
    totalMonthlyRequests: 10_000,
    totalMonthlyBandwidthBytes: 30_000_000,
    totalMonthlyStorageBytes: 12_000_000,
    dailyRequests: [pt('2026-09-02', 3_100), pt('2026-09-03', 4_200)],
    dailyBandwidth: [pt('2026-09-02', 7_000_000), pt('2026-09-03', 9_000_000)],
    diskUsage: [
      pt('2026-09-02', 11_000_000, '03:00:00'),
      pt('2026-09-02', 11_500_000, '15:00:00'),
      pt('2026-09-03', 11_900_000, '03:00:00'),
    ],
    windowDays: 7,
    ...over,
  };
}

const byMetric = (rows: ReturnType<typeof redisSamples>) =>
  Object.fromEntries(rows.map((r) => [r.usageMetricId, r]));

describe('redisSamples — today', () => {
  it('writes commands, bandwidth and storage from the scalars and charts, HIGH where documented', () => {
    const rows = redisSamples(TODAY, stats());
    expect(
      rows.map((r) => [r.usageMetricId, r.billingSkuId, r.unit, r.quantity, r.confidence]),
    ).toEqual([
      ['commands', 'redis.commands', 'command', 4_200, 'HIGH'],
      ['bandwidth_bytes', null, 'byte', 9_000_000, 'HIGH'],
      // Peak of the day's samples and the live figure: 12.0 MB beats 11.9 MB.
      ['storage_bytes', null, 'byte', 12_000_000, 'MEDIUM'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        day: '2026-09-03',
        environment: 'dev',
        providerId: 'upstash',
        serviceId: 'upstash.redis',
        operationId: null,
        source: UPSTASH_SOURCE,
        sourceAsOf: NOW,
      });
      // Every meter named here exists in the registry under the SKU it claims.
      const meter = COST_REGISTRY.meter(`${r.serviceId}/${r.usageMetricId}`);
      expect(meter, r.usageMetricId).not.toBeNull();
      expect(meter!.billingSkuId).toBe(r.billingSkuId);
      expect(meter!.unit).toBe(r.unit);
    }
    const m = byMetric(rows);
    expect(m['commands']!.metadata).toEqual({
      from: 'dailyrequests',
      windowDays: 7,
      dailyNetCommands: 4_200,
      totalMonthlyRequests: 10_000,
    });
    expect(m['bandwidth_bytes']!.metadata).toEqual({
      from: 'dailybandwidth',
      windowDays: 7,
      seriesBandwidthBytes: 9_000_000,
      totalMonthlyBandwidthBytes: 30_000_000,
    });
    expect(m['storage_bytes']!.metadata).toEqual({
      definition: 'peak of point-in-time samples',
      samples: 2,
      currentStorageBytes: 12_000_000,
      totalMonthlyStorageBytes: 12_000_000,
    });
  });

  it('falls back to the live counter when the chart has no point for today', () => {
    const rows = redisSamples(TODAY, stats({ dailyRequests: [pt('2026-09-02', 3_100)] }));
    expect(byMetric(rows)['commands']).toMatchObject({ quantity: 4_200, confidence: 'HIGH' });
    expect(byMetric(rows)['commands']!.metadata).toMatchObject({ from: 'daily_net_commands' });
  });

  it('drops to MEDIUM when the chart and the live counter disagree, and keeps both', () => {
    const rows = redisSamples(TODAY, stats({ dailyNetCommands: 4_150 }));
    expect(byMetric(rows)['commands']).toMatchObject({ quantity: 4_200, confidence: 'MEDIUM' });
    expect(byMetric(rows)['commands']!.metadata).toMatchObject({
      from: 'dailyrequests',
      dailyNetCommands: 4_150,
    });
  });

  it('uses the bandwidth series when the scalar is absent, at MEDIUM', () => {
    const rows = redisSamples(TODAY, stats({ dailyBandwidthBytes: null }));
    expect(byMetric(rows)['bandwidth_bytes']).toMatchObject({
      quantity: 9_000_000,
      confidence: 'MEDIUM',
    });
    expect(byMetric(rows)['bandwidth_bytes']!.metadata).toMatchObject({ from: 'bandwidths' });
  });

  it('writes storage from the live figure alone when no sample fell on today', () => {
    const rows = redisSamples(TODAY, stats({ diskUsage: [] }));
    expect(byMetric(rows)['storage_bytes']).toMatchObject({ quantity: 12_000_000 });
    expect(byMetric(rows)['storage_bytes']!.metadata).toMatchObject({ samples: 1 });
  });

  it('rounds to whole units and never goes negative', () => {
    const rows = redisSamples(
      TODAY,
      stats({ dailyRequests: [pt('2026-09-03', 1.6)], dailyBandwidthBytes: -5 }),
    );
    expect(byMetric(rows)['commands']!.quantity).toBe(2);
    expect(byMetric(rows)['bandwidth_bytes']!.quantity).toBe(0);
  });
});

describe('redisSamples — yesterday', () => {
  it('reads the charts: commands HIGH, bandwidth MEDIUM, storage the peak of its samples', () => {
    const rows = redisSamples(YESTERDAY, stats());
    expect(rows.map((r) => [r.usageMetricId, r.quantity, r.confidence])).toEqual([
      ['commands', 3_100, 'HIGH'],
      ['bandwidth_bytes', 7_000_000, 'MEDIUM'],
      ['storage_bytes', 11_500_000, 'MEDIUM'],
    ]);
    const m = byMetric(rows);
    expect(m['commands']!.metadata).toEqual({ from: 'dailyrequests', windowDays: 7 });
    expect(m['bandwidth_bytes']!.metadata).toEqual({ from: 'bandwidths', windowDays: 7 });
    expect(m['storage_bytes']!.metadata).toEqual({
      definition: 'peak of point-in-time samples',
      samples: 2,
    });
    // Today's scalars never leak onto another day.
    expect(m['commands']!.metadata).not.toHaveProperty('dailyNetCommands');
  });

  it('a day inside the window with no point is a measured zero; storage without a sample is no row', () => {
    const rows = redisSamples(
      YESTERDAY,
      stats({ dailyRequests: [pt('2026-09-03', 4_200)], dailyBandwidth: [], diskUsage: [] }),
    );
    expect(rows.map((r) => [r.usageMetricId, r.quantity, r.confidence])).toEqual([
      ['commands', 0, 'HIGH'],
      ['bandwidth_bytes', 0, 'HIGH'],
    ]);
    expect(byMetric(rows)['commands']!.metadata).toMatchObject({ from: 'window_zero' });
  });

  it('a day outside the window gets no commands or bandwidth row — absent is not zero', () => {
    const rows = redisSamples(
      YESTERDAY,
      stats({ dailyRequests: [], dailyBandwidth: [], windowDays: 1 }),
    );
    expect(rows.map((r) => r.usageMetricId)).toEqual(['storage_bytes']);
    expect(
      redisSamples(
        YESTERDAY,
        stats({ dailyRequests: [], dailyBandwidth: [], diskUsage: [], windowDays: null }),
      ),
    ).toEqual([]);
  });
});

describe('coveredByWindow', () => {
  it('covers today always, the window before it, and nothing else', () => {
    expect(coveredByWindow('2026-09-03', '2026-09-03', null)).toBe(true);
    expect(coveredByWindow('2026-09-02', '2026-09-03', null)).toBe(false);
    expect(coveredByWindow('2026-09-02', '2026-09-03', 1)).toBe(false);
    expect(coveredByWindow('2026-09-02', '2026-09-03', 2)).toBe(true);
    expect(coveredByWindow('2026-08-28', '2026-09-03', 7)).toBe(true);
    expect(coveredByWindow('2026-08-27', '2026-09-03', 7)).toBe(false);
    expect(coveredByWindow('2026-09-04', '2026-09-03', 7)).toBe(false);
  });
});

describe('collector definition', () => {
  const fake: UpstashRedisStatsPort = { stats: async () => stats() };

  it('is the issue’s settings: 6h, 15s, retry 1, 8 calls/day, FREE, non-essential', () => {
    expect(upstashRedisCollector({} as never, fake)).toMatchObject({
      id: UPSTASH_REDIS_COLLECTOR_ID,
      providerId: 'upstash',
      serviceId: 'upstash.redis',
      capability: 'USAGE_COLLECTOR',
      frequencyMs: 6 * 60 * 60 * 1000,
      staleAfterMs: 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retry: { maxAttemptsPerTick: 1 },
      maxCallsPerDay: 8,
      enabledEnvironments: 'all',
      essential: false,
      monitoringCost: { model: 'FREE', estimatedMonthlyMicros: 0, expectedRequestsPerMonth: 120 },
    });
  });

  it('registers on the scheduler because the registry declares USAGE_COLLECTOR for upstash', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    s.register(upstashRedisCollector({} as never, fake));
    expect(s.registered().map((c) => c.id)).toEqual([UPSTASH_REDIS_COLLECTOR_ID]);
    expect(s.monitoring()).toMatchObject({ knownMonthlyMicros: 0, unknown: [], overBudget: false });
  });

  it('calls the endpoint once per run, with the abort signal, and upserts yesterday then today', async () => {
    const asked: boolean[] = [];
    const recording: UpstashRedisStatsPort = {
      stats: async (q) => {
        asked.push(q?.signal instanceof AbortSignal);
        return stats();
      },
    };
    const executed: unknown[] = [];
    const db = { execute: async (q: unknown) => void executed.push(q) };
    const def = upstashRedisCollector(db as never, recording, { now: () => NOW });
    const result = await def.run({
      environment: 'dev',
      now: NOW,
      day: '2026-09-03',
      signal: new AbortController().signal,
    });
    expect(asked).toEqual([true]);
    // Three rows for each of the two days.
    expect(result).toEqual({ sourceAsOf: NOW, samples: 6 });
    // One upsert per day.
    expect(executed).toHaveLength(2);
  });
});
