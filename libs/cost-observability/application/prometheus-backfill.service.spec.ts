import { describe, expect, it } from 'vitest';
import type { CostRow } from '../domain/budget';
import { reduceDay } from './prometheus-backfill.service';
import { reconcile } from './reconciliation.service';

const series = (labels: Record<string, string>, ...values: number[]) => ({
  labels,
  points: values.map((v, i) => ({ t: 1_000 + i, v })),
});

describe('reduceDay — Prometheus increase() → integer usage (epic §10, §25)', () => {
  it('floors extrapolated values, splits attempted from succeeded, folds SKUs onto operations', () => {
    const day = reduceDay(
      '2026-09-01',
      [
        series({ method: 'google.routeMatrix', status: '200' }, 0, 6.02),
        series({ method: 'google.routeMatrix', status: '429' }, 0, 0.98),
        series({ method: 'google.details.core', status: '200' }, 0, 12.204),
      ],
      [
        series({ sku: 'routes.computeRouteMatrix' }, 0, 25.9),
        series({ sku: 'google.details.core' }, 0, 12.204),
      ],
    );
    expect(day.operations).toEqual({
      'google.routeMatrix': { attempted: 6, succeeded: 6, units: 25 },
      'google.details.core': { attempted: 12, succeeded: 12, units: 12 },
    });
  });

  it('ignores series with no method/sku label, NaN points, and zero counts', () => {
    const day = reduceDay(
      '2026-09-01',
      [
        series({ status: '200' }, 5),
        series({ method: 'google.expand', status: '301' }, Number.NaN),
        series({ method: 'google.sheets.meta', status: '200' }, 0.4),
      ],
      [],
    );
    expect(day.operations).toEqual({});
  });
});

const row = (over: Partial<CostRow>): CostRow => ({
  day: '2026-09-02',
  providerId: 'google',
  serviceId: 'google.places',
  operationId: 'google.details.quality',
  usageMetricId: 'requests',
  billingSkuId: 'places.details.enterprise',
  amountMicros: 0,
  currency: 'USD',
  basis: 'ESTIMATED',
  confidence: 'MEDIUM',
  source: 'estimator',
  costKind: 'USAGE',
  billingCadence: null,
  periodAmountMicros: null,
  ...over,
});

describe('reconcile (epic §26)', () => {
  it('computes variance and pct per service when an actual exists, and null otherwise', () => {
    const lines = reconcile([
      row({ amountMicros: 8_200_000 }),
      row({
        amountMicros: 8_310_000,
        basis: 'ACTUAL',
        confidence: 'HIGH',
        source: 'gcp_billing_export',
      }),
      row({
        serviceId: 'google.routes',
        operationId: 'google.routeMatrix',
        usageMetricId: 'billable_elements',
        billingSkuId: 'routes.computeRouteMatrix',
        amountMicros: 500_000,
      }),
    ]);
    expect(lines).toEqual([
      {
        providerId: 'google',
        serviceId: 'google.places',
        estimatedMicros: 8_200_000,
        actualMicros: 8_310_000,
        varianceMicros: 110_000,
        variancePct: 0.0132,
        currency: 'USD',
        matchedKeys: 1,
      },
      {
        providerId: 'google',
        serviceId: 'google.routes',
        estimatedMicros: 500_000,
        actualMicros: null,
        varianceMicros: null,
        variancePct: null,
        currency: 'USD',
        matchedKeys: 0,
      },
    ]);
  });

  it('takes the most confident estimate per key and never adds two estimates', () => {
    const lines = reconcile([
      row({ amountMicros: 100, confidence: 'LOW', source: 'prometheus_backfill' }),
      row({ amountMicros: 90, confidence: 'MEDIUM', source: 'estimator' }),
      row({ amountMicros: 95, basis: 'ACTUAL', confidence: 'HIGH', source: 'bill' }),
    ]);
    expect(lines[0]).toMatchObject({ estimatedMicros: 90, actualMicros: 95, varianceMicros: 5 });
  });

  it('leaves pct null when actual is zero, and ignores FIXED/MANUAL rows', () => {
    const lines = reconcile([
      row({ amountMicros: 10 }),
      row({ amountMicros: 0, basis: 'ACTUAL', confidence: 'HIGH', source: 'bill' }),
      row({
        providerId: 'gogo',
        serviceId: 'gogo.cost_observability',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        amountMicros: 1,
        basis: 'FIXED',
        confidence: 'HIGH',
        source: 'monitoring_cost_model',
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ varianceMicros: -10, variancePct: null });
  });
});
