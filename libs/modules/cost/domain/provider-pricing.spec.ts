import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRICING_VERSION,
  PROVIDER_PRICING,
  freeCapAdjustedCostMicros,
  listCostMicros,
  microsToMinorUnits,
  operationForSku,
  pricingFor,
  providerOf,
  staticCostGaps,
} from './provider-pricing';

const repoRoot = path.resolve(__dirname, '../../../..');
const TODAY = '2026-09-03';

describe('pricing registry', () => {
  it('prices a known operation at list price', () => {
    // $20 per 1,000 Enterprise Details → 250 calls = $5.00 = 5_000_000 micros.
    expect(listCostMicros('google.details.quality', TODAY, 250)).toBe(5_000_000);
    expect(microsToMinorUnits(5_000_000)).toBe(500);
  });

  it('returns null — not zero — for an operation nobody priced', () => {
    expect(listCostMicros('google.somethingNew', TODAY, 1_000)).toBeNull();
    expect(pricingFor('google.somethingNew', TODAY)).toBeNull();
  });

  it('returns null — not zero — for an operation whose price is unverified', () => {
    // Routes bills per matrix element; the plan captured no per-element list
    // price. The units are exact and the money is unknown, and unknown is the
    // one thing a dashboard must not print as $0.
    const row = pricingFor('google.routeMatrix', TODAY);
    expect(row?.googleSku).toBe('Routes API — Compute Route Matrix Essentials');
    expect(row?.usdPer1000Micros).toBeNull();
    expect(listCostMicros('google.routeMatrix', TODAY, 500)).toBeNull();
  });

  it('keeps a measured zero at zero', () => {
    // Known-free is a different fact from unknown, and it must survive as a
    // number. IDs-Only Text Search is published at no charge.
    expect(listCostMicros('google.searchText', TODAY, 10_000)).toBe(0);
    // And no calls at a known price is also zero, not null.
    expect(listCostMicros('google.details.quality', TODAY, 0)).toBe(0);
  });

  it('never rounds a real charge down to nothing', () => {
    // 3 autocomplete requests at $2.83/1k is $0.0085 — under a cent. Printing
    // "$0.00" beside three billed calls is the 0-versus-unknown failure this
    // whole surface exists to avoid, arriving through the rounding function.
    const micros = listCostMicros('google.autocomplete', TODAY, 3);
    expect(micros).toBe(8_490);
    expect(microsToMinorUnits(micros!)).toBe(1);
    // Nothing spent is still nothing.
    expect(microsToMinorUnits(0)).toBe(0);
  });

  it('prices a historical day with the rule in force on that day', () => {
    const registry = [
      ...PROVIDER_PRICING.filter((r) => r.operation !== 'google.details.quality'),
      {
        ...pricingFor('google.details.quality', TODAY)!,
        effectiveTo: '2026-10-01',
      },
    ];
    // A future row is what a price change looks like. The old day keeps the
    // old price; nothing is retroactively re-priced.
    const future = { ...registry[registry.length - 1]!, usdPer1000Micros: 30_000_000 };
    const lookup = (day: string) =>
      [...registry, { ...future, effectiveFrom: '2026-10-01', effectiveTo: undefined }].find(
        (r) =>
          r.operation === 'google.details.quality' &&
          r.effectiveFrom <= day &&
          (r.effectiveTo === undefined || day < r.effectiveTo),
      );
    expect(lookup('2026-09-15')?.usdPer1000Micros).toBe(20_000_000);
    expect(lookup('2026-10-15')?.usdPer1000Micros).toBe(30_000_000);
  });

  it('bumps the pricing version whenever a row is added or changed', () => {
    // A dashboard number is traceable to a price list only if the label moves
    // with the list. Adding a row and forgetting the version relabels history.
    const newest = PROVIDER_PRICING.map((r) => r.effectiveFrom)
      .sort()
      .at(-1);
    expect(PRICING_VERSION).toBe(newest);
  });
});

describe('free-cap arithmetic (reporting only)', () => {
  it('charges nothing until the monthly cap is consumed', () => {
    // Enterprise Details: 1,000 free per month.
    expect(freeCapAdjustedCostMicros('google.details.quality', TODAY, 400, 0)).toBe(0);
    expect(freeCapAdjustedCostMicros('google.details.quality', TODAY, 400, 400)).toBe(0);
  });

  it('charges only the units past the cap on the day it is crossed', () => {
    // 900 already used this month, 200 today → 100 free, 100 billable at $20/1k.
    expect(freeCapAdjustedCostMicros('google.details.quality', TODAY, 200, 900)).toBe(2_000_000);
  });

  it('charges every unit once the cap is behind us', () => {
    expect(freeCapAdjustedCostMicros('google.details.quality', TODAY, 100, 5_000)).toBe(2_000_000);
  });

  it('stays null where the price is unknown, cap or no cap', () => {
    expect(freeCapAdjustedCostMicros('google.routeMatrix', TODAY, 50_000, 0)).toBeNull();
  });
});

describe('provider taxonomy', () => {
  it('folds the Routes SKU onto the operation that spent it', () => {
    // #332: unfolded, one operation renders as two rows — one with six calls
    // and no cost, one with the cost and no calls.
    expect(operationForSku('routes.computeRouteMatrix')).toBe('google.routeMatrix');
    expect(operationForSku('google.details.quality')).toBe('google.details.quality');
  });

  it('routes each operation to its service, with Sheets and Maps SDK matched first', () => {
    expect(providerOf('google.details.core')).toBe('places');
    expect(providerOf('google.routeMatrix')).toBe('routes');
    expect(providerOf('routes.computeRouteMatrix')).toBe('routes');
    expect(providerOf('google.sheets.values')).toBe('sheets');
    expect(providerOf('google.maps_sdk_ios')).toBe('maps_sdk');
    expect(providerOf('vietmap.search')).toBeNull();
  });

  it('separates "nobody counted it" from "nobody priced it"', () => {
    const gaps = staticCostGaps(TODAY);
    const byKey = Object.fromEntries(gaps.map((g) => [g.key, g.kind]));
    // The SDK renders on a handset: no units, so no cost, and no pricing work
    // fixes it.
    expect(byKey['google.maps_sdk_ios']).toBe('not_instrumented');
    expect(byKey['google.maps_sdk_android']).toBe('not_instrumented');
    // Routes is counted exactly and priced not at all: a number in the
    // registry fixes it.
    expect(byKey['google.routeMatrix']).toBe('price_unknown');
  });

  /**
   * #387 — the gap the telemetry endpoint closes.
   *
   * `not_instrumented` is a claim about setup, and the setup changes at
   * runtime: while `mobile_provider_usage.enabled` is accepting map loads,
   * the SDK operations are counted, and the price has been verified, so there
   * is nothing left to report. While it is off the gap stands, which is the
   * truth — nothing is counting them.
   */
  it('drops the Maps SDK gap once client telemetry is counting the loads', () => {
    const keys = (options?: { clientTelemetryEnabled: boolean }) =>
      new Set(staticCostGaps(TODAY, options).map((g) => g.key));

    expect(keys()).toContain('google.maps_sdk_ios');
    expect(keys()).toContain('google.maps_sdk_android');

    const counted = keys({ clientTelemetryEnabled: true });
    expect(counted).not.toContain('google.maps_sdk_ios');
    expect(counted).not.toContain('google.maps_sdk_android');
    // …and nothing else moved: Routes is still counted and still unpriced.
    expect(counted).toContain('google.routeMatrix');
  });

  /**
   * The gap must not vanish retroactively. On a day the price was not yet
   * verified, counting the units leaves `price_unknown` — units measured,
   * money not — rather than nothing at all.
   */
  it('reports an unpriced day as price_unknown, never as no gap', () => {
    const gaps = staticCostGaps('2026-09-02', { clientTelemetryEnabled: true });
    const byKey = Object.fromEntries(gaps.map((g) => [g.key, g.kind]));
    expect(byKey['google.maps_sdk_ios']).toBe('price_unknown');
    expect(byKey['google.maps_sdk_android']).toBe('price_unknown');
  });
});

/**
 * The audit, kept true by CI.
 *
 * Every operation label the adapters actually emit must have a registry row.
 * Without this, adding an adapter call is enough to make the cost total quietly
 * understate — the new operation contributes no money and nothing says so,
 * which reads exactly like "it is free".
 *
 * Scanned from source rather than listed here on purpose: a list in a test is
 * a second copy of the truth, and it drifts the same way the SKU mapping did.
 */
describe('operation label audit', () => {
  const ADAPTERS = [
    'libs/providers/src/google-places.adapter.ts',
    'libs/providers/src/google-routes.adapter.ts',
    'libs/providers/src/google-sheets.adapter.ts',
  ];

  /** Provider names passed to `googleFailure`, which are not operations. */
  const NOT_OPERATIONS = new Set(['google.places', 'google.routes', 'google.sheets']);

  /** `details()` builds its label from the tier. Both halves are in source. */
  const FETCH_TIERS = ['core', 'quality', 'detail'];

  function emittedOperations(): string[] {
    const found = new Set<string>();
    for (const file of ADAPTERS) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const match of source.matchAll(/['"`]((?:google|routes)\.[A-Za-z._${}]+)['"`]/g)) {
        const literal = match[1]!;
        if (NOT_OPERATIONS.has(literal)) continue;
        if (literal === 'google.details') continue; // a prose reference in a comment
        if (literal.includes('${tier}')) {
          for (const tier of FETCH_TIERS) found.add(literal.replace('${tier}', tier));
          continue;
        }
        if (literal.includes('${')) continue;
        found.add(literal);
      }
    }
    return [...found].sort();
  }

  it('has a pricing row for every operation an adapter emits', () => {
    const unpriced = emittedOperations().filter(
      (operation) => pricingFor(operationForSku(operation), TODAY) === null,
    );
    expect(unpriced, `add a row in provider-pricing.ts for: ${unpriced.join(', ')}`).toEqual([]);
  });

  it('maps every operation an adapter emits to a known service', () => {
    const orphans = emittedOperations().filter((operation) => providerOf(operation) === null);
    expect(orphans).toEqual([]);
  });

  it('covers the operations the plan names, including ones nothing emits yet', () => {
    // `liveness` arrives with PR5 and the Maps SDK with client telemetry. The
    // rows exist now so the refresh budget can reserve against a known price,
    // and so the console can name the gap instead of leaving it out.
    for (const operation of [
      'google.details.liveness',
      'google.maps_sdk_ios',
      'google.maps_sdk_android',
    ]) {
      expect(pricingFor(operation, TODAY)).not.toBeNull();
    }
  });
});
