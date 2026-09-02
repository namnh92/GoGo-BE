import { describe, expect, it } from 'vitest';
import {
  checkBudget,
  diffSnapshots,
  type MeterSnapshot,
  type TestRunDelta,
} from './test-cost.service';

const DAY = '2026-09-02';

const m = (
  over: Partial<MeterSnapshot> & { usageMetricId: string; quantity: number },
): MeterSnapshot => ({
  providerId: 'google',
  serviceId: 'google.places',
  operationId: 'google.details.quality',
  billingSkuId: null,
  unit: 'request',
  ...over,
});

describe('diffSnapshots (epic §28, §43)', () => {
  it('prices a billed delta at list on the day, and leaves an unbilled meter unpriced', () => {
    const before = [
      m({ usageMetricId: 'calls', quantity: 10 }),
      m({ usageMetricId: 'requests', billingSkuId: 'places.details.enterprise', quantity: 8 }),
    ];
    const after = [
      m({ usageMetricId: 'calls', quantity: 13 }),
      m({ usageMetricId: 'requests', billingSkuId: 'places.details.enterprise', quantity: 10 }),
    ];
    const deltas = diffSnapshots(before, after, DAY);
    expect(deltas).toEqual([
      expect.objectContaining({
        usageMetricId: 'calls',
        usageDelta: 3,
        estimatedCostDelta: null,
        basis: 'UNKNOWN',
        confidence: 'LOW',
      }),
      // 2 Enterprise Details at $20/1k list = 40,000 micros — no free cap on a test delta.
      expect.objectContaining({
        usageMetricId: 'requests',
        usageDelta: 2,
        estimatedCostDelta: 40_000,
        basis: 'ESTIMATED',
        confidence: 'MEDIUM',
      }),
    ]);
  });

  it('treats a meter absent before as starting from zero, and drops zero deltas', () => {
    const after = [
      m({ usageMetricId: 'calls', quantity: 5 }),
      m({ usageMetricId: 'requests', billingSkuId: 'places.details.enterprise', quantity: 0 }),
    ];
    const deltas = diffSnapshots([], after, DAY);
    expect(deltas.map((d) => [d.usageMetricId, d.usageBefore, d.usageDelta])).toEqual([
      ['calls', 0, 5],
    ]);
  });

  it('keeps an unknown price unknown — Routes elements are counted, not priced', () => {
    const after = [
      m({
        serviceId: 'google.routes',
        operationId: 'google.routeMatrix',
        usageMetricId: 'billable_elements',
        billingSkuId: 'routes.computeRouteMatrix',
        unit: 'matrix_element',
        quantity: 14,
      }),
    ];
    const [d] = diffSnapshots([], after, DAY);
    expect(d).toMatchObject({ usageDelta: 14, estimatedCostDelta: null, basis: 'UNKNOWN' });
  });

  it('scopes to the declared services (§30) and needs no provider names in code (§44.17)', () => {
    const after = [
      m({ usageMetricId: 'calls', quantity: 1 }),
      m({
        providerId: 'upstash',
        serviceId: 'upstash.redis',
        operationId: null,
        usageMetricId: 'commands',
        unit: 'command',
        quantity: 4_200,
      }),
    ];
    expect(diffSnapshots([], after, DAY).map((d) => d.serviceId)).toEqual([
      'google.places',
      'upstash.redis',
    ]);
    expect(
      diffSnapshots([], after, DAY, undefined, ['upstash.redis']).map((d) => d.serviceId),
    ).toEqual(['upstash.redis']);
  });
});

describe('checkBudget (epic §29 — soft)', () => {
  const d = (over: Partial<TestRunDelta>): TestRunDelta => ({
    providerId: 'google',
    serviceId: 'google.places',
    operationId: 'google.details.quality',
    usageMetricId: 'calls',
    billingSkuId: null,
    unit: 'request',
    usageBefore: 0,
    usageAfter: 0,
    usageDelta: 0,
    estimatedCostDelta: null,
    actualCostDelta: null,
    currency: 'USD',
    basis: 'UNKNOWN',
    confidence: 'LOW',
    ...over,
  });

  it('reports violations without throwing, and none when no budget is declared', () => {
    const deltas = [
      d({ usageMetricId: 'calls', usageDelta: 250 }),
      d({
        usageMetricId: 'requests',
        billingSkuId: 'places.details.enterprise',
        usageDelta: 200,
        estimatedCostDelta: 4_000_000,
        basis: 'ESTIMATED',
      }),
      d({
        providerId: 'upstash',
        serviceId: 'upstash.redis',
        operationId: null,
        usageMetricId: 'commands',
        unit: 'command',
        usageDelta: 6_000,
      }),
    ];
    expect(checkBudget(deltas, null)).toEqual([]);
    expect(
      checkBudget(deltas, {
        maxProviderCalls: 250,
        maxProviderUsage: { 'upstash.redis/commands': 5_000 },
        maxEstimatedCostMicros: 1_000_000,
      }),
    ).toEqual(['upstash.redis/commands 6000 > 5000', 'estimated cost 4000000 micros > 1000000']);
  });

  it('does not count unknown prices toward the cost budget', () => {
    const deltas = [
      d({
        usageMetricId: 'billable_elements',
        billingSkuId: 'routes.computeRouteMatrix',
        unit: 'matrix_element',
        usageDelta: 10_000,
      }),
    ];
    expect(checkBudget(deltas, { maxEstimatedCostMicros: 1 })).toEqual([]);
  });
});
