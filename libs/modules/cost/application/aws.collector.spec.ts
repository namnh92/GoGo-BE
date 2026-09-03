import { describe, expect, it } from 'vitest';
import type { AwsCostExplorerPort, AwsServiceCost } from '@gogo/providers';
import { COST_REGISTRY } from '../domain/registry';
import { CollectorSchedulerService } from './collector-scheduler.service';
import {
  AWS_COST_EXPLORER_COLLECTOR_ID,
  AWS_SOURCE,
  awsCostExplorerCollector,
  awsCostSamples,
  awsServiceRoute,
  daysBefore,
  monthsOf,
} from './aws.collector';

/**
 * COST-BE-027 (#386) — the pure parts: Cost Explorer entries → ACTUAL cost
 * rows, the service routing, and the collector definition the scheduler is
 * handed. The database side (replace-upsert, freshness, the calls cap across
 * a restart, reconciliation) is `cost-aws-github.int.spec.ts`.
 */

const NOW = new Date('2026-09-03T06:00:00Z');
const CTX = { environment: 'dev', now: NOW };

const cost = (over: Partial<AwsServiceCost> = {}): AwsServiceCost => ({
  day: '2026-09-02',
  service: 'AWS Systems Manager',
  unblendedMicros: 133_746,
  amortizedMicros: 133_746,
  currency: 'USD',
  estimated: false,
  ...over,
});

const shape = (rows: ReturnType<typeof awsCostSamples>) =>
  rows.map((r) => [r.day, r.serviceId, r.amountMicros, r.basis, r.confidence]);

describe('awsServiceRoute', () => {
  it('routes Systems Manager to aws.ssm however AWS spells it, everything else to aggregate billing', () => {
    for (const name of ['AWS Systems Manager', 'Amazon Simple Systems Manager (SSM)', 'ssm']) {
      expect(awsServiceRoute(name, COST_REGISTRY), name).toBe('aws.ssm');
    }
    for (const name of ['Amazon Simple Storage Service', 'AWS Lambda', '']) {
      expect(awsServiceRoute(name, COST_REGISTRY), name).toBe('aws.aggregate_billing');
    }
  });
});

describe('daysBefore / monthsOf', () => {
  it('walks back in UTC and names the months a set of days falls in', () => {
    expect(daysBefore('2026-09-03', 6)).toBe('2026-08-28');
    expect(daysBefore('2026-01-01', 1)).toBe('2025-12-31');
    expect(monthsOf(['2026-09-02', '2026-09-03', '2026-08-31'])).toEqual(['2026-08', '2026-09']);
    expect(monthsOf([])).toEqual([]);
  });
});

describe('awsCostSamples', () => {
  it('writes one ACTUAL row per (day, registry service), UnblendedCost as the amount', () => {
    const rows = awsCostSamples(
      CTX,
      [cost(), cost({ service: 'Amazon Simple Storage Service', unblendedMicros: 39_160_330 })],
      COST_REGISTRY,
    );
    expect(shape(rows)).toEqual([
      ['2026-09-02', 'aws.aggregate_billing', 39_160_330, 'ACTUAL', 'HIGH'],
      ['2026-09-02', 'aws.ssm', 133_746, 'ACTUAL', 'HIGH'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        environment: 'dev',
        providerId: 'aws',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        billableQuantity: null,
        billableUnit: null,
        currency: 'USD',
        source: AWS_SOURCE,
        sourceAsOf: NOW,
      });
    }
    expect(rows[1]!.metadata).toMatchObject({
      metric: 'UnblendedCost',
      amortizedMicros: 133_746,
      awsEstimated: false,
      awsServices: ['AWS Systems Manager'],
    });
  });

  it('sums the AWS services that share one registry service and lists them', () => {
    const rows = awsCostSamples(
      CTX,
      [
        cost({ service: 'Amazon S3', unblendedMicros: 1_000 }),
        cost({ service: 'AWS Lambda', unblendedMicros: 2_500, amortizedMicros: 2_500 }),
        cost({ service: 'Amazon EC2', unblendedMicros: 500, amortizedMicros: null }),
      ],
      COST_REGISTRY,
    );
    expect(shape(rows)).toEqual([['2026-09-02', 'aws.aggregate_billing', 4_000, 'ACTUAL', 'HIGH']]);
    expect(rows[0]!.metadata).toMatchObject({
      awsServices: ['AWS Lambda', 'Amazon EC2', 'Amazon S3'],
      // One member without an amortized figure makes the sum unknown, not partial.
      amortizedMicros: null,
    });
  });

  it('a day AWS still calls estimated is MEDIUM, and the basis stays ACTUAL', () => {
    const rows = awsCostSamples(CTX, [cost({ estimated: true })], COST_REGISTRY);
    expect(shape(rows)).toEqual([['2026-09-02', 'aws.ssm', 133_746, 'ACTUAL', 'MEDIUM']]);
    expect(rows[0]!.metadata).toMatchObject({ awsEstimated: true });
    // One estimated member is enough to mark the merged row.
    const merged = awsCostSamples(
      CTX,
      [cost({ service: 'A', estimated: false }), cost({ service: 'B', estimated: true })],
      COST_REGISTRY,
    );
    expect(merged[0]!.confidence).toBe('MEDIUM');
  });

  it('keeps days and currencies apart, and keeps a zero as a measured zero', () => {
    const rows = awsCostSamples(
      CTX,
      [
        cost({ day: '2026-09-01', unblendedMicros: 0, amortizedMicros: 0 }),
        cost({ day: '2026-09-02' }),
        cost({ day: '2026-09-02', currency: 'EUR', unblendedMicros: 99 }),
      ],
      COST_REGISTRY,
    );
    expect(rows.map((r) => [r.day, r.currency, r.amountMicros])).toEqual([
      ['2026-09-01', 'USD', 0],
      ['2026-09-02', 'USD', 133_746],
      ['2026-09-02', 'EUR', 99],
    ]);
  });

  it('is empty for no entries — a run that saw nothing writes nothing', () => {
    expect(awsCostSamples(CTX, [], COST_REGISTRY)).toEqual([]);
  });
});

describe('collector definition', () => {
  const fake: AwsCostExplorerPort = { costsByService: async () => [cost()] };

  it('is the issue’s settings: 24h, one call a day, PER_REQUEST at ~$0.30/month, non-essential', () => {
    expect(awsCostExplorerCollector({} as never, fake, COST_REGISTRY)).toMatchObject({
      id: AWS_COST_EXPLORER_COLLECTOR_ID,
      providerId: 'aws',
      serviceId: 'aws.aggregate_billing',
      capability: 'ACTUAL_COST_COLLECTOR',
      frequencyMs: 24 * 60 * 60 * 1000,
      timeoutMs: 30_000,
      retry: { maxAttemptsPerTick: 1 },
      maxCallsPerDay: 1,
      enabledEnvironments: 'all',
      essential: false,
      monitoringCost: {
        model: 'PER_REQUEST',
        estimatedMonthlyMicros: 300_000,
        currency: 'USD',
        expectedRequestsPerMonth: 30,
      },
    });
  });

  it('registers because the registry declares ACTUAL_COST_COLLECTOR for aws, and is counted as paid', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    s.register(awsCostExplorerCollector({} as never, fake, COST_REGISTRY));
    expect(s.registered().map((c) => c.id)).toEqual([AWS_COST_EXPLORER_COLLECTOR_ID]);
    // Epic §20: declared, under the $1 per-collector approval line, inside the
    // $1 DEV budget.
    expect(s.monitoring()).toMatchObject({
      knownMonthlyMicros: 300_000,
      unknown: [],
      needsApproval: [],
      budgetMicros: 1_000_000,
      overBudget: false,
    });
  });

  it('cannot be marked essential — the scheduler refuses a paid collector that ignores the budget', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    const def = { ...awsCostExplorerCollector({} as never, fake, COST_REGISTRY), essential: true };
    expect(() => s.register(def)).toThrow(/only a FREE collector may be essential/);
  });

  it('asks for a window ending today and covering lookbackDays, with the abort signal', async () => {
    const asked: { from: string; to: string; signal: boolean }[] = [];
    const recording: AwsCostExplorerPort = {
      costsByService: async (q) => {
        asked.push({ from: q.from, to: q.to, signal: q.signal instanceof AbortSignal });
        return [cost()];
      },
    };
    const executed: unknown[] = [];
    const db = {
      execute: async (q: unknown) => {
        executed.push(q);
        return { rows: [], rowCount: 0 };
      },
    };
    const def = awsCostExplorerCollector(db as never, recording, COST_REGISTRY, { now: () => NOW });
    const result = await def.run({
      environment: 'dev',
      now: NOW,
      day: '2026-09-03',
      signal: new AbortController().signal,
    });
    expect(asked).toEqual([{ from: '2026-08-28', to: '2026-09-03', signal: true }]);
    expect(result).toEqual({ sourceAsOf: NOW, samples: 1 });
    // One cost upsert, then one reconciliation stamp for the single month.
    expect(executed).toHaveLength(2);
  });

  it('honours a narrower lookback and writes nothing when the window is empty', async () => {
    const asked: string[] = [];
    const empty: AwsCostExplorerPort = {
      costsByService: async (q) => {
        asked.push(q.from);
        return [];
      },
    };
    const executed: unknown[] = [];
    const db = {
      execute: async (q: unknown) => {
        executed.push(q);
        return { rows: [], rowCount: 0 };
      },
    };
    const def = awsCostExplorerCollector(db as never, empty, COST_REGISTRY, {
      lookbackDays: 1,
      now: () => NOW,
    });
    const result = await def.run({
      environment: 'dev',
      now: NOW,
      day: '2026-09-03',
      signal: new AbortController().signal,
    });
    expect(asked).toEqual(['2026-09-03']);
    expect(result).toEqual({ sourceAsOf: NOW, samples: 0 });
    // Nothing to write and no month to reconcile.
    expect(executed).toEqual([]);
  });
});
