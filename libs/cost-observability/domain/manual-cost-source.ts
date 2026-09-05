/**
 * The `source` family manual cost items write under on `provider_cost_daily`.
 * One item is one source (`manual_cost_items:<id>`), because the table's key
 * has no other column that can tell two items under the same service apart,
 * and two domains under `registrar.domain` are two costs, not one.
 *
 * Lives apart from `manual-cost.ts` (and from `cost-source.ts`, the /monitoring cost-source dimensions of ADR-0014) so the forecast engine can recognise a
 * manual row without importing the item schedule it feeds into.
 */
export const MANUAL_COST_SOURCE = 'manual_cost_items';
export const MANUAL_COST_SOURCE_PREFIX = `${MANUAL_COST_SOURCE}:`;

export function manualCostSource(itemId: string): string {
  return `${MANUAL_COST_SOURCE_PREFIX}${itemId}`;
}

export function isManualCostSource(source: string): boolean {
  return source.startsWith(MANUAL_COST_SOURCE_PREFIX);
}
