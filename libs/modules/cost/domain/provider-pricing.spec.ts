import { describe, expect, it } from 'vitest';
import {
  PRICING_VERSION,
  PROVIDER_PRICING,
  billingOperationOf,
  estimateCostMicros,
  knownOperations,
  listCostMicros,
  microsToMinorUnits,
  pricingFor,
  utcDay,
  utcMonth,
} from './provider-pricing';

/** #335 — the arithmetic that turns counters into money, and its refusals. */

describe('pricingFor', () => {
  it('prices a day with the rule that applied on that day', () => {
    const row = pricingFor('google.details.quality', '2026-09-15');
    expect(row?.googleSku).toBe('Place Details Enterprise');
    expect(row?.usdPer1000Micros).toBe(20_000_000);
  });

  it('has no price before the table takes effect', () => {
    // Re-pricing the past would make last month's reported spend move every
    // time a price does, and a report nobody can reproduce is not a report.
    expect(pricingFor('google.details.quality', '2026-08-31')).toBeNull();
  });

  it('does not invent a price for an operation it has never heard of', () => {
    expect(pricingFor('google.someFutureSku', '2026-09-15')).toBeNull();
  });
});

describe('listCostMicros', () => {
  it('prices per thousand, in integer micros', () => {
    // $20 / 1,000 requests × 250 = $5.00 = 5,000,000 micros.
    expect(listCostMicros('google.details.quality', '2026-09-15', 250)).toBe(5_000_000);
  });

  it('rounds a fractional micro up, never in the spender’s favour', () => {
    // $2.83 / 10,000 → 2,830,000 micros per 1,000 → 1 unit is 2,830 exactly;
    // pick a count that does not divide evenly and check the direction.
    const one = listCostMicros('google.autocomplete', '2026-09-15', 1);
    expect(one).toBe(2_830);
    const three = listCostMicros('google.searchText', '2026-09-15', 3);
    expect(three).toBe(0);
  });

  it('is zero for a free SKU and zero for no units', () => {
    // A measured zero. Distinct from `null`, which is "we have no price".
    expect(listCostMicros('google.sheets.values', '2026-09-15', 500)).toBe(0);
    expect(listCostMicros('google.details.quality', '2026-09-15', 0)).toBe(0);
  });

  it('returns null for a SKU whose price is not established', () => {
    // The Maps SDK rows exist precisely so a billed-but-unmeasured surface
    // reports UNKNOWN instead of disappearing from the total.
    expect(listCostMicros('google.maps_sdk_ios', '2026-09-15', 1_000)).toBeNull();
    expect(listCostMicros('google.maps_sdk_android', '2026-09-15', 1_000)).toBeNull();
  });

  it('never deducts a free allowance — that is the guard’s whole point', () => {
    // 100 quality calls sit inside the 1,000/month free cap, and the guard
    // still prices them. Google pools that cap per billing account across
    // every linked project; a wrong "still free" estimate must not be able to
    // authorise a paid call.
    expect(listCostMicros('google.details.quality', '2026-09-15', 100)).toBe(2_000_000);
  });
});

describe('estimateCostMicros', () => {
  it('spends the free allowance first', () => {
    // 1,200 quality calls, 1,000 free → 200 billable → $4.00.
    expect(
      estimateCostMicros({
        operation: 'google.details.quality',
        day: '2026-09-15',
        units: 1_200,
        freeUnitsAlreadyUsed: 0,
      }),
    ).toBe(4_000_000);
  });

  it('does not hand the same free allowance out twice', () => {
    // The month already used its 1,000; this window is billed in full.
    expect(
      estimateCostMicros({
        operation: 'google.details.quality',
        day: '2026-09-15',
        units: 100,
        freeUnitsAlreadyUsed: 1_000,
      }),
    ).toBe(2_000_000);
  });

  it('is zero while entirely inside the free cap', () => {
    expect(
      estimateCostMicros({
        operation: 'google.details.core',
        day: '2026-09-15',
        units: 4_000,
        freeUnitsAlreadyUsed: 0,
      }),
    ).toBe(0);
  });

  it('is null when the price is unknown, never zero', () => {
    expect(
      estimateCostMicros({
        operation: 'google.maps_sdk_ios',
        day: '2026-09-15',
        units: 5_000,
        freeUnitsAlreadyUsed: 0,
      }),
    ).toBeNull();
  });

  it('treats a nonsense prior usage as zero rather than as credit', () => {
    expect(
      estimateCostMicros({
        operation: 'google.details.quality',
        day: '2026-09-15',
        units: 1_200,
        freeUnitsAlreadyUsed: -5_000,
      }),
    ).toBe(4_000_000);
  });
});

describe('billingOperationOf', () => {
  it('folds the Routes request label onto its billing label', () => {
    // Requests arrive as google.routeMatrix, the invoice line is
    // routes.computeRouteMatrix. Keyed on the request label, one operation's
    // calls and its money would land in different rows.
    expect(billingOperationOf('google.routeMatrix')).toBe('routes.computeRouteMatrix');
  });

  it('leaves every other label alone', () => {
    expect(billingOperationOf('google.details.quality')).toBe('google.details.quality');
    expect(billingOperationOf('google.sheets.values')).toBe('google.sheets.values');
  });
});

describe('registry hygiene', () => {
  it('prices every operation exactly once on a given day', () => {
    const seen = new Map<string, number>();
    for (const row of knownOperations('2026-09-15')) {
      seen.set(row.operation, (seen.get(row.operation) ?? 0) + 1);
    }
    // Two rows in force for one operation on one day means `pricingFor` is
    // picking between them by tie-break rather than by intent.
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('carries a source for every row, so a number can be challenged', () => {
    for (const row of PROVIDER_PRICING) {
      expect(row.source, row.operation).not.toBe('');
      expect(row.effectiveFrom, row.operation).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('states a version, which travels with every priced response', () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps the Maps SDK rows present and unpriced', () => {
    // Deleting them would make a billed surface vanish from the report;
    // pricing them 0 would claim it is free. Both are wrong (plan §0.2 C1).
    for (const operation of ['google.maps_sdk_ios', 'google.maps_sdk_android']) {
      const row = pricingFor(operation, '2026-09-15');
      expect(row, operation).not.toBeNull();
      expect(row?.usdPer1000Micros, operation).toBeNull();
    }
  });
});

describe('units and days', () => {
  it('converts micros to minor units, rounding half up', () => {
    expect(microsToMinorUnits(5_000_000)).toBe(500);
    expect(microsToMinorUnits(4_999)).toBe(0);
    expect(microsToMinorUnits(5_000)).toBe(1);
  });

  it('buckets by UTC, not by local time', () => {
    expect(utcDay(new Date('2026-09-15T23:59:59.000Z'))).toBe('2026-09-15');
    expect(utcDay(new Date('2026-09-16T00:00:00.000Z'))).toBe('2026-09-16');
    expect(utcMonth('2026-09-16')).toBe('2026-09');
  });
});
