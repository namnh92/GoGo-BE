import { describe, expect, it } from 'vitest';
import { operationRows, providerErrorRate, totalRows } from './report';
import { parseMetricsText } from './metrics-text';

const DAY = '2026-09-02';

describe('#336 operationRows', () => {
  it('prices a known operation at list price', () => {
    const [row] = operationRows({
      usage: [
        {
          operation: 'google.details.quality',
          callsAttempted: 3,
          callsSucceeded: 3,
          billableUnits: 3,
        },
      ],
      metrics: null,
      day: DAY,
    });
    // Enterprise Details: $20 / 1,000 → 3 requests = 60,000 micros.
    expect(row).toMatchObject({
      operation: 'google.details.quality',
      provider: 'places',
      unit: 'request',
      estimatedCostMicros: 60_000,
      gap: null,
    });
  });

  it('leaves an unknown price null and says why — never zero', () => {
    const [row] = operationRows({
      usage: [
        {
          operation: 'google.routeMatrix',
          callsAttempted: 2,
          callsSucceeded: 2,
          billableUnits: 25,
        },
      ],
      metrics: null,
      day: DAY,
    });
    expect(row!.billableUnits).toBe(25);
    expect(row!.estimatedCostMicros).toBeNull();
    expect(row!.gap).toBe('price_unknown');
  });

  it('classifies an uninstrumented operation apart from an unpriced one', () => {
    const [row] = operationRows({
      usage: [
        {
          operation: 'google.maps_sdk_ios',
          callsAttempted: 0,
          callsSucceeded: 0,
          billableUnits: 0,
        },
      ],
      metrics: null,
      day: DAY,
    });
    expect(row!.gap).toBe('not_instrumented');
  });

  it('subtracts the free cap only for reporting, and only once', () => {
    const [row] = operationRows({
      usage: [
        {
          operation: 'google.details.quality',
          callsAttempted: 1_200,
          callsSucceeded: 1_200,
          billableUnits: 1_200,
        },
      ],
      metrics: null,
      day: DAY,
    });
    // 1,000 free per month → 200 billable at $20/1k.
    expect(row!.estimatedCostMicros).toBe(24_000_000);
    expect(row!.estimatedCostAfterFreeCapMicros).toBe(4_000_000);
  });

  it('reports the metrics cross-check beside the ledger rather than reconciling it', () => {
    const metrics = parseMetricsText(
      'places_provider_requests_total{method="google.details.quality",status="200"} 4\n',
    );
    const [row] = operationRows({
      usage: [
        {
          operation: 'google.details.quality',
          callsAttempted: 3,
          callsSucceeded: 3,
          billableUnits: 3,
        },
      ],
      metrics,
      day: DAY,
    });
    expect(row!.metricsCalls).toBe(4);
    expect(row!.ledgerMinusMetrics).toBe(-1);
  });

  it('surfaces an operation the scrape saw and the ledger has not flushed yet', () => {
    const metrics = parseMetricsText(
      'places_provider_requests_total{method="google.expand",status="302"} 2\n',
    );
    const rows = operationRows({ usage: [], metrics, day: DAY });
    expect(rows.map((r) => r.operation)).toEqual(['google.expand']);
    expect(rows[0]).toMatchObject({ callsAttempted: 0, metricsCalls: 2, ledgerMinusMetrics: -2 });
  });
});

describe('#336 totalRows', () => {
  it('sums per operation and never across operations', () => {
    const totals = totalRows(
      [
        operationRows({
          usage: [
            {
              operation: 'google.details.quality',
              callsAttempted: 3,
              callsSucceeded: 3,
              billableUnits: 3,
            },
          ],
          metrics: null,
          day: DAY,
        }),
        operationRows({
          usage: [
            {
              operation: 'google.searchText',
              callsAttempted: 5,
              callsSucceeded: 5,
              billableUnits: 5,
            },
          ],
          metrics: null,
          day: DAY,
        }),
      ],
      DAY,
    );
    expect(totals.map((t) => [t.operation, t.callsAttempted])).toEqual([
      ['google.details.quality', 3],
      ['google.searchText', 5],
    ]);
  });

  it('re-derives the free cap from the summed units, because a cap is not linear', () => {
    const scenario = (units: number) =>
      operationRows({
        usage: [
          {
            operation: 'google.details.quality',
            callsAttempted: units,
            callsSucceeded: units,
            billableUnits: units,
          },
        ],
        metrics: null,
        day: DAY,
      });
    // Two scenarios of 600 are each free; 1,200 together is not.
    expect(scenario(600)[0]!.estimatedCostAfterFreeCapMicros).toBe(0);
    const totals = totalRows([scenario(600), scenario(600)], DAY);
    expect(totals[0]!.estimatedCostAfterFreeCapMicros).toBe(4_000_000);
  });
});

describe('#336 providerErrorRate', () => {
  it('is null when nothing was requested — 0/0 is not a healthy provider', () => {
    expect(providerErrorRate(parseMetricsText('')).providerErrorRate).toBeNull();
  });

  it('divides failures by requests', () => {
    const metrics = parseMetricsText(
      'places_provider_requests_total{method="google.details.quality",status="200"} 8\n' +
        'places_provider_failures_total{method="google.details.quality",status="503",reason="x"} 2\n',
    );
    expect(providerErrorRate(metrics)).toEqual({
      providerRequests: 8,
      providerFailures: 2,
      providerErrorRate: 0.25,
    });
  });
});
