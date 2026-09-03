import { describe, expect, it } from 'vitest';
import type { GitHubBillingPort, GitHubUsageItem } from '@gogo/providers';
import { COST_REGISTRY } from '../domain/registry';
import { CollectorSchedulerService } from './collector-scheduler.service';
import {
  GITHUB_ACTIONS_COLLECTOR_ID,
  GITHUB_SOURCE,
  actionsSamples,
  githubActionsCollector,
  monthsFor,
} from './github.collector';

/**
 * COST-BE-027 (#386) — the pure parts: usage-report items → the day's minute
 * meter and ACTUAL cost row, and the collector definition. The database side
 * is `cost-aws-github.int.spec.ts`.
 */

const NOW = new Date('2026-09-03T06:00:00Z');
const TODAY = { day: '2026-09-03', today: '2026-09-03', environment: 'dev', now: NOW };
const YESTERDAY = { ...TODAY, day: '2026-09-02' };

const item = (over: Partial<GitHubUsageItem> = {}): GitHubUsageItem => ({
  day: '2026-09-02',
  product: 'actions',
  sku: 'Actions Linux',
  quantity: 380,
  unitType: 'minutes',
  pricePerUnit: 0.006,
  grossAmount: 2.28,
  discountAmount: 2.28,
  netAmount: 0,
  repositoryName: 'namnh92/GoGo-BE',
  organizationName: null,
  ...over,
});

describe('monthsFor', () => {
  it('gives one month for two days inside it, two across a boundary, ascending', () => {
    expect(monthsFor(['2026-09-02', '2026-09-03'])).toEqual([{ year: 2026, month: 9 }]);
    expect(monthsFor(['2026-08-31', '2026-09-01'])).toEqual([
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ]);
    expect(monthsFor(['2026-12-31', '2027-01-01'])).toEqual([
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
    ]);
  });
});

describe('actionsSamples', () => {
  it('sums minutes across SKUs into one meter and netAmount into one ACTUAL row', () => {
    const { usage, costs } = actionsSamples(YESTERDAY, [
      item(),
      item({
        sku: 'Actions macOS',
        quantity: 12,
        pricePerUnit: 0.062,
        grossAmount: 0.744,
        discountAmount: 0,
        netAmount: 0.744,
        repositoryName: 'namnh92/GoGo-MobileApp',
      }),
    ]);
    expect(
      usage.map((u) => [u.usageMetricId, u.billingSkuId, u.unit, u.quantity, u.confidence]),
    ).toEqual([['minutes', 'actions.minutes', 'minute', 392, 'HIGH']]);
    expect(usage[0]).toMatchObject({
      day: '2026-09-02',
      environment: 'dev',
      providerId: 'github',
      serviceId: 'github.actions',
      operationId: null,
      source: GITHUB_SOURCE,
      sourceAsOf: NOW,
    });
    expect(usage[0]!.metadata).toMatchObject({
      from: 'billing_usage_report',
      repositories: ['namnh92/GoGo-BE', 'namnh92/GoGo-MobileApp'],
      skus: [
        { sku: 'Actions Linux', quantity: 380, pricePerUnit: 0.006, netAmount: 0 },
        { sku: 'Actions macOS', quantity: 12, pricePerUnit: 0.062, netAmount: 0.744 },
      ],
    });
    expect(
      costs.map((c) => [c.basis, c.amountMicros, c.billableQuantity, c.billableUnit, c.confidence]),
    ).toEqual([['ACTUAL', 744_000, 392, 'minute', 'HIGH']]);
    expect(costs[0]!.metadata).toMatchObject({ grossMicros: 3_024_000, discountMicros: 2_280_000 });
  });

  it('today is MEDIUM — the report is only final once the day is over', () => {
    const { usage, costs } = actionsSamples(TODAY, [item({ day: '2026-09-03' })]);
    expect(usage[0]!.confidence).toBe('MEDIUM');
    expect(costs[0]!.confidence).toBe('MEDIUM');
  });

  it('counts only the Actions product and names the others rather than folding them in', () => {
    const { usage } = actionsSamples(YESTERDAY, [
      item(),
      item({
        product: 'packages',
        sku: 'Packages storage',
        quantity: 999,
        unitType: 'gigabytehours',
      }),
      item({ product: 'copilot', sku: 'Copilot', quantity: 5, unitType: 'users' }),
    ]);
    expect(usage[0]!.quantity).toBe(380);
    expect(usage[0]!.metadata).toMatchObject({ otherProducts: ['copilot', 'packages'] });
  });

  it('does not convert a non-minute Actions line into minutes, but records its unit', () => {
    const { usage } = actionsSamples(YESTERDAY, [
      item(),
      item({ sku: 'Actions storage', quantity: 40, unitType: 'gigabytehours' }),
    ]);
    expect(usage[0]!.quantity).toBe(380);
    expect(usage[0]!.metadata).toMatchObject({ otherUnits: ['gigabytehours'] });
    // The SKU is still listed, so the line is visible rather than lost.
    expect((usage[0]!.metadata as { skus: { sku: string }[] }).skus.map((s) => s.sku)).toEqual([
      'Actions Linux',
      'Actions storage',
    ]);
  });

  it('a day the report does not mention gets no rows — absent is not zero', () => {
    expect(actionsSamples({ ...TODAY, day: '2026-09-01' }, [item()])).toEqual({
      usage: [],
      costs: [],
    });
    // A day with only other products is not an Actions zero either.
    expect(actionsSamples(YESTERDAY, [item({ product: 'packages' })])).toEqual({
      usage: [],
      costs: [],
    });
  });

  it('writes the meter but no cost row when no line carries a netAmount', () => {
    const { usage, costs } = actionsSamples(YESTERDAY, [item({ netAmount: null })]);
    expect(usage).toHaveLength(1);
    expect(costs).toEqual([]);
  });

  it('keeps a measured zero: a day with Actions lines totalling no minutes', () => {
    const { usage, costs } = actionsSamples(YESTERDAY, [
      item({ quantity: 0, grossAmount: 0, discountAmount: 0 }),
    ]);
    expect(usage[0]!.quantity).toBe(0);
    expect(costs[0]!.amountMicros).toBe(0);
  });
});

describe('collector definition', () => {
  const fake: GitHubBillingPort = { usage: async () => [item()] };

  it('is a free, non-essential collector on the usual 6h cadence', () => {
    expect(githubActionsCollector({} as never, fake)).toMatchObject({
      id: GITHUB_ACTIONS_COLLECTOR_ID,
      providerId: 'github',
      serviceId: 'github.actions',
      capability: 'USAGE_COLLECTOR',
      frequencyMs: 6 * 60 * 60 * 1000,
      staleAfterMs: 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retry: { maxAttemptsPerTick: 1 },
      maxCallsPerDay: 8,
      essential: false,
      monitoringCost: { model: 'FREE', estimatedMonthlyMicros: 0, expectedRequestsPerMonth: 120 },
    });
  });

  it('registers because the registry declares USAGE_COLLECTOR for github, and costs nothing', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    s.register(githubActionsCollector({} as never, fake));
    expect(s.registered().map((c) => c.id)).toEqual([GITHUB_ACTIONS_COLLECTOR_ID]);
    expect(s.monitoring()).toMatchObject({ knownMonthlyMicros: 0, unknown: [], overBudget: false });
  });

  it('asks for one report when both days share a month, two across a boundary', async () => {
    const asked: { year: number; month: number | undefined }[] = [];
    const recording: GitHubBillingPort = {
      usage: async (q) => {
        asked.push({ year: q.year, month: q.month });
        expect(q.signal).toBeInstanceOf(AbortSignal);
        return [item(), item({ day: '2026-09-03', quantity: 10 })];
      },
    };
    const executed: unknown[] = [];
    const db = {
      execute: async (q: unknown) => {
        executed.push(q);
        return { rows: [] };
      },
    };
    const def = githubActionsCollector(db as never, recording, { now: () => NOW });
    const result = await def.run({
      environment: 'dev',
      now: NOW,
      day: '2026-09-03',
      signal: new AbortController().signal,
    });
    expect(asked).toEqual([{ year: 2026, month: 9 }]);
    // Two days, each a usage row and a cost row.
    expect(result).toEqual({ sourceAsOf: NOW, samples: 4 });
    expect(executed).toHaveLength(4);

    asked.length = 0;
    await githubActionsCollector(db as never, recording, { now: () => NOW }).run({
      environment: 'dev',
      now: NOW,
      day: '2026-09-01',
      signal: new AbortController().signal,
    });
    expect(asked).toEqual([
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ]);
  });
});
