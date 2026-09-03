import { describe, expect, it } from 'vitest';
import {
  PRICING_RULES,
  estimateMicros,
  newestEffectiveFrom,
  ruleInForce,
  type PricingRule,
} from './pricing-rules';
import { PRICING_VERSION } from './provider-pricing';
import { COST_REGISTRY } from './registry';

const TODAY = '2026-09-03';

const base: PricingRule = {
  id: 'test-rule',
  providerId: 'x',
  serviceId: 'x.svc',
  operationId: 'x.op',
  usageMetricId: 'x.op/requests',
  billingSkuId: 'x.sku',
  region: null,
  platform: null,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  currency: 'USD',
  pricingModel: 'PER_REQUEST',
  unitPriceMicros: 1_000,
  tiers: null,
  freeAllowance: null,
  version: 'test-v1',
  sourceReference: 'test',
  reviewedAt: '2026-01-01',
};

describe('pricing models (epic §13)', () => {
  it('FREE is a known zero, never an unknown', () => {
    const r = estimateMicros({ ...base, pricingModel: 'FREE', unitPriceMicros: 0 }, 10_000);
    expect(r).toEqual({ known: true, listMicros: 0, freeAdjustedMicros: 0 });
  });

  it('an unknown unit price is unknown, never zero', () => {
    expect(estimateMicros({ ...base, unitPriceMicros: null }, 500)).toEqual({ known: false });
    expect(
      estimateMicros({ ...base, pricingModel: 'PER_1K_REQUESTS', unitPriceMicros: null }, 500),
    ).toEqual({
      known: false,
    });
  });

  it('PER_REQUEST / PER_OPERATION multiply per unit', () => {
    expect(estimateMicros(base, 12)).toMatchObject({ listMicros: 12_000 });
    expect(estimateMicros({ ...base, pricingModel: 'PER_OPERATION' }, 12)).toMatchObject({
      listMicros: 12_000,
    });
  });

  it('PER_1K_REQUESTS and PER_MILLION_REQUESTS divide, rounding up', () => {
    // $20/1k Enterprise Details → 250 calls = $5.00.
    expect(
      estimateMicros(
        { ...base, pricingModel: 'PER_1K_REQUESTS', unitPriceMicros: 20_000_000 },
        250,
      ),
    ).toMatchObject({
      listMicros: 5_000_000,
    });
    // 3 autocomplete at $2.83/1k = 8,490 micros, not 8,489.99.
    expect(
      estimateMicros({ ...base, pricingModel: 'PER_1K_REQUESTS', unitPriceMicros: 2_830_000 }, 3),
    ).toMatchObject({
      listMicros: 8_490,
    });
    expect(
      estimateMicros(
        { ...base, pricingModel: 'PER_MILLION_REQUESTS', unitPriceMicros: 500_000 },
        1_000,
      ),
    ).toMatchObject({
      listMicros: 500,
    });
  });

  it('TIERED charges each band at its own price and refuses units past the last bounded tier', () => {
    const tiered: PricingRule = {
      ...base,
      pricingModel: 'TIERED',
      unitPriceMicros: null,
      tiers: [
        { upTo: 100, unitPriceMicros: 0 },
        { upTo: 1_000, unitPriceMicros: 10 },
        { upTo: null, unitPriceMicros: 5 },
      ],
    };
    // 100 free, 900 at 10, 500 at 5.
    expect(estimateMicros(tiered, 1_500)).toMatchObject({ listMicros: 900 * 10 + 500 * 5 });
    const bounded: PricingRule = { ...tiered, tiers: [{ upTo: 100, unitPriceMicros: 0 }] };
    expect(estimateMicros(bounded, 50)).toMatchObject({ listMicros: 0 });
    expect(estimateMicros(bounded, 150)).toEqual({ known: false });
  });

  it('FIXED_MONTHLY is the price regardless of quantity', () => {
    const fixed: PricingRule = {
      ...base,
      pricingModel: 'FIXED_MONTHLY',
      unitPriceMicros: 99_000_000,
    };
    expect(estimateMicros(fixed, 0)).toMatchObject({ listMicros: 99_000_000 });
    expect(estimateMicros(fixed, 1_000)).toMatchObject({ listMicros: 99_000_000 });
  });
});

describe('free allowance (epic §15, reporting only)', () => {
  const withCap: PricingRule = {
    ...base,
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: 20_000_000,
    freeAllowance: { quantity: 1_000, unit: 'request', period: 'MONTH', scope: 'SKU' },
  };

  it('charges nothing until the allowance is consumed, then only the excess', () => {
    expect(estimateMicros(withCap, 400, 0)).toMatchObject({
      listMicros: 8_000_000,
      freeAdjustedMicros: 0,
    });
    expect(estimateMicros(withCap, 200, 900)).toMatchObject({ freeAdjustedMicros: 2_000_000 });
    expect(estimateMicros(withCap, 100, 5_000)).toMatchObject({ freeAdjustedMicros: 2_000_000 });
  });

  it('keeps list price untouched by the allowance', () => {
    expect(estimateMicros(withCap, 100, 5_000)).toMatchObject({ listMicros: 2_000_000 });
  });
});

describe('historical pricing (epic §14)', () => {
  it("prices a day with the rule in force on that day, never today's", () => {
    const v1: PricingRule = {
      ...base,
      id: 'v1',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-10-01',
      unitPriceMicros: 1_000,
    };
    const v2: PricingRule = {
      ...base,
      id: 'v2',
      effectiveFrom: '2026-10-01',
      unitPriceMicros: 2_000,
      version: 'test-v2',
    };
    const rules = [v1, v2];
    expect(ruleInForce(rules, { operationId: 'x.op' }, '2026-09-15')?.id).toBe('v1');
    expect(ruleInForce(rules, { operationId: 'x.op' }, '2026-10-15')?.id).toBe('v2');
    expect(ruleInForce(rules, { billingSkuId: 'x.sku' }, '2025-12-31')).toBeNull();
  });

  it('never has two rules in force for one SKU on one day', () => {
    for (const a of PRICING_RULES) {
      if (a.billingSkuId === null) continue;
      const others = PRICING_RULES.filter(
        (b) =>
          b !== a &&
          b.billingSkuId === a.billingSkuId &&
          b.effectiveFrom <= a.effectiveFrom &&
          (b.effectiveTo === null || a.effectiveFrom < b.effectiveTo),
      );
      expect(others, `overlap on ${a.billingSkuId}`).toEqual([]);
    }
  });

  it('labels reports with the newest effectiveFrom', () => {
    expect(PRICING_VERSION).toBe(newestEffectiveFrom());
  });
});

describe('seed integrity', () => {
  it('every rule refers to a registered service, operation, meter and SKU', () => {
    for (const rule of PRICING_RULES) {
      expect(COST_REGISTRY.service(rule.serviceId), rule.id).not.toBeNull();
      if (rule.operationId !== null)
        expect(COST_REGISTRY.operation(rule.operationId), rule.id).not.toBeNull();
      if (rule.usageMetricId !== null) {
        const meter = COST_REGISTRY.meter(rule.usageMetricId);
        expect(meter, rule.id).not.toBeNull();
        // The rule binds to the meter that is billed, not to a request count
        // by assumption (epic §44.23).
        expect(meter!.billingSkuId, rule.id).toBe(rule.billingSkuId);
      }
      if (rule.billingSkuId !== null)
        expect(COST_REGISTRY.billingSku(rule.billingSkuId), rule.id).not.toBeNull();
      expect(rule.currency).toBe('USD');
      expect(rule.reviewedAt <= TODAY).toBe(true);
    }
  });

  it('keeps the two known-unknowns unknown', () => {
    for (const sku of ['routes.computeRouteMatrix', 'maps.dynamic.ios', 'maps.dynamic.android']) {
      expect(ruleInForce(PRICING_RULES, { billingSkuId: sku }, TODAY)?.unitPriceMicros).toBeNull();
    }
  });
});

describe('upstash rule (#384)', () => {
  const rule = ruleInForce(PRICING_RULES, { billingSkuId: 'redis.commands' }, TODAY)!;

  it('prices commands from the pricing page: $0.2 per 100K, 500K a month free', () => {
    expect(rule).toMatchObject({
      providerId: 'upstash',
      serviceId: 'upstash.redis',
      operationId: null,
      usageMetricId: 'upstash.redis/commands',
      pricingModel: 'PER_1K_REQUESTS',
      unitPriceMicros: 2_000,
      freeAllowance: { quantity: 500_000, unit: 'command', period: 'MONTH', scope: 'SKU' },
      effectiveFrom: '2026-09-01',
      reviewedAt: '2026-09-03',
    });
    // 100K commands list at $0.20; 600K in a month: 500K free, then $0.20.
    expect(estimateMicros(rule, 100_000)).toEqual({
      known: true,
      listMicros: 200_000,
      freeAdjustedMicros: 0,
    });
    expect(estimateMicros(rule, 600_000)).toEqual({
      known: true,
      listMicros: 1_200_000,
      freeAdjustedMicros: 200_000,
    });
    expect(estimateMicros(rule, 100_000, 450_000)).toEqual({
      known: true,
      listMicros: 200_000,
      freeAdjustedMicros: 100_000,
    });
  });

  it('says where the figure differs from the issue text', () => {
    expect(rule.sourceReference).toContain('upstash.com/pricing/redis');
    expect(rule.sourceReference).toContain('10k commands/day');
  });
});

describe('github actions rule (#386)', () => {
  const rule = ruleInForce(PRICING_RULES, { billingSkuId: 'actions.minutes' }, TODAY)!;

  it('prices minutes at the page’s Linux rate with the 2,000/month account allowance', () => {
    expect(rule).toMatchObject({
      providerId: 'github',
      serviceId: 'github.actions',
      operationId: null,
      usageMetricId: 'github.actions/minutes',
      pricingModel: 'PER_OPERATION',
      unitPriceMicros: 6_000,
      freeAllowance: { quantity: 2_000, unit: 'minute', period: 'MONTH', scope: 'ACCOUNT' },
      effectiveFrom: '2026-09-01',
      reviewedAt: '2026-09-03',
    });
    // 1,000 minutes list at $6.00 and fall inside the allowance.
    expect(estimateMicros(rule, 1_000)).toEqual({
      known: true,
      listMicros: 6_000_000,
      freeAdjustedMicros: 0,
    });
    // 3,000 in a month: 2,000 free, then 1,000 at $0.006 = $6.00.
    expect(estimateMicros(rule, 3_000)).toEqual({
      known: true,
      listMicros: 18_000_000,
      freeAdjustedMicros: 6_000_000,
    });
    // 500 more with 1,800 already used: 200 free, 300 billable = $1.80.
    expect(estimateMicros(rule, 500, 1_800)).toEqual({
      known: true,
      listMicros: 3_000_000,
      freeAdjustedMicros: 1_800_000,
    });
  });

  it('says where the figure differs from the issue text, and keeps the other OS rates on record', () => {
    expect(rule.sourceReference).toContain('docs.github.com');
    expect(rule.sourceReference).toContain('$0.008/phút Linux');
    expect(rule.sourceReference).toContain('$0.010');
    expect(rule.sourceReference).toContain('$0.062');
  });
});

describe('neon rules (#385)', () => {
  const rule = (sku: string) => ruleInForce(PRICING_RULES, { billingSkuId: sku }, TODAY)!;

  it('records the Free plan in force: a known zero with each cap on record, per project per month', () => {
    expect(rule('postgres.compute')).toMatchObject({
      providerId: 'neon',
      serviceId: 'neon.postgres',
      usageMetricId: 'neon.postgres/compute_hours',
      pricingModel: 'FREE',
      unitPriceMicros: 0,
      freeAllowance: { quantity: 100, unit: 'compute_hour', period: 'MONTH', scope: 'PROJECT' },
      effectiveFrom: '2026-09-01',
      reviewedAt: '2026-09-03',
    });
    expect(rule('postgres.storage')).toMatchObject({
      usageMetricId: 'neon.postgres/storage_gb_month',
      pricingModel: 'FREE',
      freeAllowance: { quantity: 0.5, unit: 'gb_month', period: 'MONTH', scope: 'PROJECT' },
    });
    expect(rule('postgres.data_transfer')).toMatchObject({
      usageMetricId: 'neon.postgres/data_transfer_gb',
      pricingModel: 'FREE',
      freeAllowance: { quantity: 5, unit: 'gb', period: 'MONTH', scope: 'PROJECT' },
    });
    // Free never bills, over the cap included: Neon suspends instead.
    expect(estimateMicros(rule('postgres.compute'), 150)).toEqual({
      known: true,
      listMicros: 0,
      freeAdjustedMicros: 0,
    });
  });

  it('keeps the usage-based list prices the issue asks for on record, for the day the plan changes', () => {
    expect(rule('postgres.compute').sourceReference).toContain('$0.106/CU-hour');
    expect(rule('postgres.compute').sourceReference).toContain('neon.com/pricing');
    expect(rule('postgres.storage').sourceReference).toContain('$0.35/GB-month');
    expect(rule('postgres.data_transfer').sourceReference).toContain('$0.10/GB');
  });
});

describe('cloudflare rules (#383) and PER_GB_MONTH proration', () => {
  const rule = (sku: string) => ruleInForce(PRICING_RULES, { billingSkuId: sku }, TODAY)!;

  it('prices R2 and Workers from the pricing pages with the free tier recorded', () => {
    expect(rule('r2.class_a')).toMatchObject({
      pricingModel: 'PER_MILLION_REQUESTS',
      unitPriceMicros: 4_500_000,
      freeAllowance: { quantity: 1_000_000, period: 'MONTH', scope: 'SKU' },
      effectiveFrom: '2026-09-01',
    });
    expect(rule('r2.class_b')).toMatchObject({
      pricingModel: 'PER_MILLION_REQUESTS',
      unitPriceMicros: 360_000,
      freeAllowance: { quantity: 10_000_000, period: 'MONTH' },
    });
    expect(rule('r2.storage')).toMatchObject({
      pricingModel: 'PER_GB_MONTH',
      unitPriceMicros: 15_000,
      freeAllowance: { quantity: 10, unit: 'gb_month', period: 'MONTH' },
    });
    // Free plan: a cap, not a price. Known zero, with the cap on record.
    expect(rule('workers.requests')).toMatchObject({
      pricingModel: 'FREE',
      unitPriceMicros: 0,
      freeAllowance: { quantity: 100_000, period: 'DAY' },
    });
    // 2M Class A in a month: the first million is free, the second is $4.50.
    expect(estimateMicros(rule('r2.class_a'), 2_000_000)).toEqual({
      known: true,
      listMicros: 9_000_000,
      freeAdjustedMicros: 4_500_000,
    });
  });

  it('prorates a daily gb_month row by the days in its month, allowance included', () => {
    const storage = rule('r2.storage');
    // 20 GB peak on a September day: list = 20 × 15,000 / 30 = 10,000 micros;
    // the 10 GB-month allowance is 300 GB-days, so the day is free.
    expect(estimateMicros(storage, 20, 0, '2026-09-03')).toEqual({
      known: true,
      listMicros: 10_000,
      freeAdjustedMicros: 0,
    });
    // After 290 GB-days already consumed, only 10 of the 20 GB are free.
    expect(estimateMicros(storage, 20, 290, '2026-09-20')).toEqual({
      known: true,
      listMicros: 10_000,
      freeAdjustedMicros: 5_000,
    });
    // February has 28 days: the same 20 GB day is worth more of the month.
    expect(estimateMicros(storage, 20, 0, '2027-02-10')).toMatchObject({
      known: true,
      listMicros: Math.ceil((20 * 15_000) / 28),
    });
    // Without a day the quantity is whole GB-months — the pre-#383 meaning.
    expect(estimateMicros(storage, 20)).toEqual({
      known: true,
      listMicros: 300_000,
      freeAdjustedMicros: 150_000,
    });
  });
});
