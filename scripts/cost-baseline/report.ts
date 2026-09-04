/**
 * PR3 / COST-BE-003 (#336) — turning two snapshots into the §4 report.
 *
 * Composition only: nothing here calls a provider, a database or a clock. It
 * takes a ledger diff, a metrics diff and a day, and produces the per-
 * operation rows the plan asks for. That is what makes the arithmetic — free
 * caps, unknown prices, ledger-versus-metrics disagreement — unit-testable
 * without Postgres, Prometheus or Google.
 *
 * The one invariant worth restating here because it is easy to break by
 * accident: an operation that produced no number gets `null` and a named gap,
 * never `0`. `google.routeMatrix` has exact units and no verified price;
 * `google.maps_sdk_ios` has neither. Those are different states, they are
 * fixed by different people, and the registry already distinguishes them —
 * this file must not flatten them on the way out.
 */

import {
  PRICING_CURRENCY,
  PRICING_VERSION,
  freeCapAdjustedCostMicros,
  listCostMicros,
  pricingFor,
  providerOf,
  staticCostGaps,
} from '../../libs/cost-observability/pricing/provider-pricing';
import type { OperationRow } from './artifact';
import type { UsageCounts } from './ledger';
import { countBy, type MetricsSnapshot } from './metrics-text';

export { PRICING_CURRENCY, PRICING_VERSION, staticCostGaps };

export type OperationRowInput = {
  usage: UsageCounts[];
  /** The scenario's own `/metrics` diff, for the cross-check column. */
  metrics: MetricsSnapshot | null;
  day: string;
  /**
   * This environment's month-to-date units for the same SKU *before* the
   * baseline ran. Free caps are monthly; pretending the month started with the
   * scenario would report every run as free.
   */
  unitsEarlierInMonth?: Map<string, number>;
};

export function operationRows(input: OperationRowInput): OperationRow[] {
  const metricCalls = input.metrics
    ? countBy(input.metrics, 'places_provider_requests_total', 'method')
    : null;

  // Operations the ledger saw, plus any the scrape saw and the ledger did not.
  // The second set is the interesting one: it means a flush is behind, or an
  // operation is emitting a counter the ledger ignores.
  const operations = new Set<string>(input.usage.map((u) => u.operation));
  if (metricCalls) for (const op of metricCalls.keys()) operations.add(op);

  return [...operations].sort().map((operation) => {
    const counts = input.usage.find((u) => u.operation === operation);
    const attempted = counts?.callsAttempted ?? 0;
    const succeeded = counts?.callsSucceeded ?? 0;
    const units = counts?.billableUnits ?? 0;
    const row = pricingFor(operation, input.day);
    const seen = metricCalls?.get(operation) ?? null;

    const listCost = listCostMicros(operation, input.day, units);
    const adjusted = freeCapAdjustedCostMicros(
      operation,
      input.day,
      units,
      input.unitsEarlierInMonth?.get(operation) ?? 0,
    );

    return {
      operation,
      provider: providerOf(operation),
      googleSku: row?.googleSku ?? null,
      unit: row?.unit ?? null,
      callsAttempted: attempted,
      callsSucceeded: succeeded,
      billableUnits: units,
      estimatedCostMicros: listCost,
      estimatedCostAfterFreeCapMicros: adjusted,
      metricsCalls: seen,
      ledgerMinusMetrics: seen === null ? null : attempted - seen,
      gap: gapKind(operation, input.day),
    } satisfies OperationRow;
  });
}

/**
 * Why this operation's money column is empty, when it is.
 *
 * Mirrors `staticCostGaps`, which classifies the registry rather than a run —
 * the two must never disagree, so both read the same two conditions off the
 * same row.
 */
function gapKind(operation: string, day: string): OperationRow['gap'] {
  const row = pricingFor(operation, day);
  if (row === null) return 'price_unknown';
  if (!row.instrumented) return 'not_instrumented';
  if (row.usdPer1000Micros === null) return 'price_unknown';
  return null;
}

/**
 * Sum per operation across scenarios — never across operations.
 *
 * The money columns are re-derived from the summed units rather than added,
 * because a free cap is not linear: five scenarios each under the cap add to
 * one total that may be over it, and adding five zeroes would report the whole
 * run as free.
 */
export function totalRows(perScenario: OperationRow[][], day: string): OperationRow[] {
  const merged = new Map<string, UsageCounts>();
  const metricsSeen = new Map<string, number>();
  let anyMetrics = false;

  for (const rows of perScenario) {
    for (const row of rows) {
      const slot = merged.get(row.operation) ?? {
        operation: row.operation,
        callsAttempted: 0,
        callsSucceeded: 0,
        billableUnits: 0,
      };
      slot.callsAttempted += row.callsAttempted;
      slot.callsSucceeded += row.callsSucceeded;
      slot.billableUnits += row.billableUnits;
      merged.set(row.operation, slot);
      if (row.metricsCalls !== null) {
        anyMetrics = true;
        metricsSeen.set(row.operation, (metricsSeen.get(row.operation) ?? 0) + row.metricsCalls);
      }
    }
  }

  return operationRows({ usage: [...merged.values()], metrics: null, day }).map((row) => {
    const seen = anyMetrics ? (metricsSeen.get(row.operation) ?? 0) : null;
    return {
      ...row,
      metricsCalls: seen,
      ledgerMinusMetrics: seen === null ? null : row.callsAttempted - seen,
    };
  });
}

/**
 * Provider error rate for one scenario, from the failure counters.
 *
 * `null` rather than `0` when nothing was requested. A scenario that made no
 * provider call has no error rate; printing 0% would let scenario A — which is
 * supposed to make zero Google calls — look like a healthy provider run.
 */
export function providerErrorRate(metrics: MetricsSnapshot): {
  providerRequests: number;
  providerFailures: number;
  providerErrorRate: number | null;
} {
  const requests = sum(countBy(metrics, 'places_provider_requests_total', 'method'));
  const failures = sum(countBy(metrics, 'places_provider_failures_total', 'method'));
  return {
    providerRequests: requests,
    providerFailures: failures,
    providerErrorRate: requests === 0 ? null : failures / requests,
  };
}

function sum(counts: Map<string, number>): number {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}
