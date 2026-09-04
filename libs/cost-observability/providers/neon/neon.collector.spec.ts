import { describe, expect, it } from 'vitest';
import type { NeonConsumptionDay, NeonProjectConsumption, NeonUsagePort } from '@gogo/providers';
import { COST_REGISTRY } from '../../domain/registry';
import { CollectorSchedulerService } from '../../application/collector-scheduler.service';
import {
  NEON_POSTGRES_COLLECTOR_ID,
  NEON_SOURCE,
  deltaSamples,
  historySamples,
  neonPostgresCollector,
  storageSamples,
} from './neon.collector';

/**
 * COST-BE-026 (#385) — the pure parts: a history day → rows, a project
 * snapshot + baseline → today's delta rows, and the collector definition the
 * scheduler is handed. The database side (replace-upsert, the baseline read
 * back, freshness, estimator) is `cost-neon.int.spec.ts`.
 */

const NOW = new Date('2026-09-03T06:00:00Z');
const TODAY = { day: '2026-09-03', today: '2026-09-03', environment: 'dev', now: NOW };
const YESTERDAY = { ...TODAY, day: '2026-09-02' };

const entry = (day: string, over: Partial<NeonConsumptionDay> = {}): NeonConsumptionDay => ({
  day,
  timeframeStart: new Date(`${day}T00:00:00Z`),
  timeframeEnd: new Date(`${day}T06:00:00Z`),
  periodPlan: 'launch',
  activeTimeSeconds: 7_200,
  computeTimeSeconds: 5_400,
  writtenDataBytes: 2_600_000_000,
  syntheticStorageSizeBytes: 320_000_000,
  dataStorageBytesHour: null,
  dataTransferBytes: null,
  ...over,
});

const snapshot = (over: Partial<NeonProjectConsumption> = {}): NeonProjectConsumption => ({
  projectId: 'gogo-dev-123456',
  consumptionPeriodStart: new Date('2026-09-01T00:00:00Z'),
  consumptionPeriodEnd: new Date('2026-10-01T00:00:00Z'),
  activeTimeSeconds: 100_000,
  computeTimeSeconds: 25_000,
  writtenDataBytes: 1_200_000_000,
  dataStorageBytesHour: 500_000_000_000,
  dataTransferBytes: 3_500_000_000,
  syntheticStorageSizeBytes: 330_000_000,
  ...over,
});

const shape = (
  rows: {
    usageMetricId: string;
    billingSkuId: string | null;
    unit: string;
    quantity: number;
    confidence: string;
  }[],
) => rows.map((r) => [r.usageMetricId, r.billingSkuId, r.unit, r.quantity, r.confidence]);

describe('historySamples', () => {
  it('writes compute, written data and both storage rows from one day, HIGH, no transfer row', () => {
    const rows = historySamples(YESTERDAY, entry('2026-09-02'));
    expect(shape(rows)).toEqual([
      // 5,400 CPU-seconds is 1.5 CU-hours → 2.
      ['compute_hours', 'postgres.compute', 'compute_hour', 2, 'HIGH'],
      // 2.6 GB written → 3.
      ['written_data_gb', null, 'gb', 3, 'HIGH'],
      ['storage_bytes', null, 'byte', 320_000_000, 'HIGH'],
      // 0.32 GB held → 1 GB-month row (ceil, as R2).
      ['storage_gb_month', 'postgres.storage', 'gb_month', 1, 'HIGH'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        day: '2026-09-02',
        environment: 'dev',
        providerId: 'neon',
        serviceId: 'neon.postgres',
        operationId: null,
        source: NEON_SOURCE,
        sourceAsOf: NOW,
      });
      expect(r.metadata).toMatchObject({ from: 'consumption_history', periodPlan: 'launch' });
    }
    expect(rows[0]!.metadata).toMatchObject({
      computeTimeSeconds: 5_400,
      activeTimeSeconds: 7_200,
    });
    expect(rows[3]!.metadata).toMatchObject({
      storageBytes: 320_000_000,
      entryStorageBytes: 320_000_000,
    });
  });

  it('writes a transfer row only when the entry carries the field', () => {
    const rows = historySamples(TODAY, entry('2026-09-03', { dataTransferBytes: 1_499_999_999 }));
    expect(shape(rows)).toContainEqual([
      'data_transfer_gb',
      'postgres.data_transfer',
      'gb',
      1,
      'HIGH',
    ]);
  });

  it('takes the storage peak across the entry, the live figure and what today already holds', () => {
    const rows = historySamples(TODAY, entry('2026-09-03'), {
      liveStorageBytes: 335_000_000,
      storedPeakBytes: 340_000_000,
    });
    const storage = rows.find((r) => r.usageMetricId === 'storage_bytes')!;
    expect(storage.quantity).toBe(340_000_000);
    expect(storage.metadata).toMatchObject({
      liveStorageBytes: 335_000_000,
      entryStorageBytes: 320_000_000,
    });
  });

  it('writes no row for a counter the entry lacks — absent is not zero', () => {
    const rows = historySamples(
      TODAY,
      entry('2026-09-03', {
        computeTimeSeconds: null,
        writtenDataBytes: null,
        syntheticStorageSizeBytes: null,
      }),
    );
    expect(rows).toEqual([]);
    const some = historySamples(TODAY, entry('2026-09-03', { writtenDataBytes: null }));
    expect(some.map((r) => r.usageMetricId)).toEqual([
      'compute_hours',
      'storage_bytes',
      'storage_gb_month',
    ]);
  });
});

describe('deltaSamples', () => {
  const baseline = {
    counters: {
      computeTimeSeconds: 20_000,
      writtenDataBytes: 300_000_000,
      dataTransferBytes: 1_900_000_000,
    },
    at: new Date('2026-09-02T18:00:00Z'),
    periodStart: '2026-09-01T00:00:00.000Z',
  };

  it('with no baseline, measures from here: zeros, firstRun, the snapshot becomes the baseline', () => {
    const { samples, baseline: next } = deltaSamples(TODAY, snapshot(), null, {
      storage: true,
      historyStatus: 'PLAN_NOT_SUPPORTED',
    });
    expect(shape(samples)).toEqual([
      ['compute_hours', 'postgres.compute', 'compute_hour', 0, 'MEDIUM'],
      ['written_data_gb', null, 'gb', 0, 'MEDIUM'],
      ['data_transfer_gb', 'postgres.data_transfer', 'gb', 0, 'MEDIUM'],
      ['storage_bytes', null, 'byte', 330_000_000, 'MEDIUM'],
      ['storage_gb_month', 'postgres.storage', 'gb_month', 1, 'MEDIUM'],
    ]);
    expect(next).toEqual({
      counters: {
        computeTimeSeconds: 25_000,
        writtenDataBytes: 1_200_000_000,
        dataTransferBytes: 3_500_000_000,
      },
      at: NOW,
      periodStart: '2026-09-01T00:00:00.000Z',
    });
    expect(samples[0]!.metadata).toMatchObject({
      from: 'project',
      historyStatus: 'PLAN_NOT_SUPPORTED',
      firstRun: true,
      baseline: {
        computeTimeSeconds: 25_000,
        at: NOW.toISOString(),
        periodStart: '2026-09-01T00:00:00.000Z',
      },
      cumulative: { computeTimeSeconds: 25_000, at: NOW.toISOString() },
      exact: { computeTimeSecondsDelta: 0, writtenDataBytesDelta: 0, dataTransferBytesDelta: 0 },
    });
  });

  it('within a period, the row is floor(now/unit) − floor(baseline/unit), exact deltas kept', () => {
    const { samples, baseline: next } = deltaSamples(TODAY, snapshot(), baseline, {
      historyStatus: 'PLAN_NOT_SUPPORTED',
    });
    expect(shape(samples)).toEqual([
      // 25,000 s → 6 h; 20,000 s → 5 h.
      ['compute_hours', 'postgres.compute', 'compute_hour', 1, 'MEDIUM'],
      // 1.2 GB → 1; 0.3 GB → 0.
      ['written_data_gb', null, 'gb', 1, 'MEDIUM'],
      // 3.5 GB → 3; 1.9 GB → 1.
      ['data_transfer_gb', 'postgres.data_transfer', 'gb', 2, 'MEDIUM'],
    ]);
    expect(next).toBe(baseline);
    expect(samples[0]!.metadata).toMatchObject({
      exact: {
        computeTimeSecondsDelta: 5_000,
        writtenDataBytesDelta: 900_000_000,
        dataTransferBytesDelta: 1_600_000_000,
      },
      baseline: { at: '2026-09-02T18:00:00.000Z' },
    });
    expect(samples[0]!.metadata).not.toHaveProperty('firstRun');
    expect(samples[0]!.metadata).not.toHaveProperty('periodRollover');
  });

  it('a new consumption period resets the baseline to zero and says so', () => {
    const { samples, baseline: next } = deltaSamples(
      TODAY,
      snapshot({ consumptionPeriodStart: new Date('2026-09-03T00:00:00Z') }),
      baseline,
      { historyStatus: 'PLAN_NOT_SUPPORTED' },
    );
    expect(shape(samples).map((r) => r[3])).toEqual([6, 1, 3]);
    expect(next).toEqual({
      counters: { computeTimeSeconds: 0, writtenDataBytes: 0, dataTransferBytes: 0 },
      at: new Date('2026-09-03T00:00:00Z'),
      periodStart: '2026-09-03T00:00:00.000Z',
    });
    expect(samples[0]!.metadata).toMatchObject({ periodRollover: true });
  });

  it('a counter below its baseline is also a reset, even with no period on record', () => {
    const { samples } = deltaSamples(
      TODAY,
      snapshot({ computeTimeSeconds: 100, consumptionPeriodStart: null }),
      { ...baseline, periodStart: null },
      { historyStatus: 'PLAN_NOT_SUPPORTED' },
    );
    expect(samples[0]!.metadata).toMatchObject({ periodRollover: true });
    expect(shape(samples).map((r) => r[3])).toEqual([0, 1, 3]);
  });

  it('omits a meter whose counter the snapshot lacks, and honours the meter list', () => {
    const { samples } = deltaSamples(TODAY, snapshot({ writtenDataBytes: null }), baseline, {
      historyStatus: 'PLAN_NOT_SUPPORTED',
    });
    expect(samples.map((r) => r.usageMetricId)).toEqual(['compute_hours', 'data_transfer_gb']);
    const only = deltaSamples(TODAY, snapshot(), baseline, {
      meters: ['data_transfer_gb'],
      storage: false,
      historyStatus: 'not_listed',
    });
    expect(shape(only.samples)).toEqual([
      ['data_transfer_gb', 'postgres.data_transfer', 'gb', 2, 'MEDIUM'],
    ]);
    expect(only.samples[0]!.metadata).toMatchObject({ historyStatus: 'not_listed' });
  });

  it('storage keeps the larger of the live figure and what today already holds', () => {
    const { samples } = deltaSamples(TODAY, snapshot(), baseline, {
      storage: true,
      storedPeakBytes: 900_000_000,
      historyStatus: 'PLAN_NOT_SUPPORTED',
    });
    expect(shape(samples).slice(-2)).toEqual([
      ['storage_bytes', null, 'byte', 900_000_000, 'MEDIUM'],
      ['storage_gb_month', 'postgres.storage', 'gb_month', 1, 'MEDIUM'],
    ]);
  });
});

describe('storageSamples', () => {
  it('rounds the GB-month row up from the exact byte row, and zero stays zero', () => {
    expect(shape(storageSamples(TODAY, 1, 'HIGH', {}))).toEqual([
      ['storage_bytes', null, 'byte', 1, 'HIGH'],
      ['storage_gb_month', 'postgres.storage', 'gb_month', 1, 'HIGH'],
    ]);
    expect(shape(storageSamples(TODAY, 0, 'HIGH', {})).map((r) => r[3])).toEqual([0, 0]);
    expect(shape(storageSamples(TODAY, 2_000_000_001, 'HIGH', {})).map((r) => r[3])).toEqual([
      2_000_000_001, 3,
    ]);
  });
});

describe('collector definition', () => {
  type Log = { history: number; project: number };
  function fakeClient(
    log: Log,
    history: (() => Promise<NeonConsumptionDay[]>) | 'unsupported' | 'auth',
  ): NeonUsagePort {
    return {
      consumptionHistory: async (q) => {
        log.history += 1;
        expect(q.signal).toBeInstanceOf(AbortSignal);
        if (history === 'unsupported')
          throw Object.assign(new Error('neon api 403'), { code: 'PLAN_NOT_SUPPORTED' });
        if (history === 'auth')
          throw Object.assign(new Error('neon api 401'), { code: 'AUTH_FAILED' });
        return history();
      },
      project: async () => {
        log.project += 1;
        return snapshot();
      },
    };
  }
  const emptyDb = (executed: unknown[] = []) => ({
    execute: async (q: unknown) => {
      executed.push(q);
      return { rows: [] };
    },
  });
  const ctx = (day: string) => ({
    environment: 'dev',
    now: new Date(`${day}T06:00:00Z`),
    day,
    signal: new AbortController().signal,
  });

  it('is the issue’s settings: 6h, 15s, retry 1, 8 calls/day, FREE, non-essential', () => {
    expect(
      neonPostgresCollector({} as never, fakeClient({ history: 0, project: 0 }, 'unsupported')),
    ).toMatchObject({
      id: NEON_POSTGRES_COLLECTOR_ID,
      providerId: 'neon',
      serviceId: 'neon.postgres',
      capability: 'USAGE_COLLECTOR',
      frequencyMs: 6 * 60 * 60 * 1000,
      staleAfterMs: 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retry: { maxAttemptsPerTick: 1 },
      maxCallsPerDay: 8,
      enabledEnvironments: 'all',
      essential: false,
      monitoringCost: { model: 'FREE', estimatedMonthlyMicros: 0, expectedRequestsPerMonth: 240 },
    });
  });

  it('registers on the scheduler because the registry declares USAGE_COLLECTOR for neon', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    s.register(
      neonPostgresCollector({} as never, fakeClient({ history: 0, project: 0 }, 'unsupported')),
    );
    expect(s.registered().map((c) => c.id)).toEqual([NEON_POSTGRES_COLLECTOR_ID]);
    expect(s.monitoring()).toMatchObject({ knownMonthlyMicros: 0, unknown: [], overBudget: false });
  });

  it('on a usage-based plan: history for yesterday and today, the transfer delta from the project', async () => {
    const log = { history: 0, project: 0 };
    const executed: unknown[] = [];
    const client = fakeClient(log, async () => [entry('2026-09-02'), entry('2026-09-03')]);
    const def = neonPostgresCollector(emptyDb(executed) as never, client, { now: () => NOW });
    const result = await def.run(ctx('2026-09-03'));
    expect(log).toEqual({ history: 1, project: 1 });
    // Four rows per history day, plus today's transfer delta.
    expect(result).toEqual({ sourceAsOf: NOW, samples: 9 });
    // Two reads (baseline carrier, today's storage peak) and one upsert.
    expect(executed).toHaveLength(3);
  });

  it('a day the history does not carry gets no rows', async () => {
    const client = fakeClient({ history: 0, project: 0 }, async () => [entry('2026-09-03')]);
    const def = neonPostgresCollector(emptyDb() as never, client, { now: () => NOW });
    expect((await def.run(ctx('2026-09-03'))).samples).toBe(5);
  });

  it('on the Free plan: falls back to the project snapshot and skips history for the rest of the day', async () => {
    const log = { history: 0, project: 0 };
    const def = neonPostgresCollector(emptyDb() as never, fakeClient(log, 'unsupported'), {
      now: () => NOW,
    });
    expect((await def.run(ctx('2026-09-03'))).samples).toBe(5);
    expect(log).toEqual({ history: 1, project: 1 });
    await def.run(ctx('2026-09-03'));
    expect(log).toEqual({ history: 1, project: 2 });
    // The next UTC day probes again, in case the plan changed.
    await def.run(ctx('2026-09-04'));
    expect(log).toEqual({ history: 2, project: 3 });
  });

  it('any other history failure is the run’s failure — nothing is written', async () => {
    const executed: unknown[] = [];
    const def = neonPostgresCollector(
      emptyDb(executed) as never,
      fakeClient({ history: 0, project: 0 }, 'auth'),
    );
    await expect(def.run(ctx('2026-09-03'))).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    // Only the two reads happened.
    expect(executed).toHaveLength(2);
  });
});
