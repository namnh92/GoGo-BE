/**
 * GoGo-BE#228 (ADR-0029) — one place that turns stop costs into plan cost
 * totals, so the optimizer, a host edit and a legacy read can never disagree
 * on what "required" and "optional" add up to.
 *
 * Amounts are integer minor units per `costScope` (`per_person`, GoGo-BE#593).
 * A stop with no price contributes nothing here and its caller marks the plan
 * `uncertain` — unknown is never free (core rule #13).
 */

export type CostedStop = {
  costMin: number | null;
  costMax: number | null;
  isOptional: boolean;
};

export type PlanCostTotals = {
  /** All stops — the legacy fields, unchanged in meaning. */
  costMin: number;
  costMax: number;
  requiredCostMin: number;
  requiredCostMax: number;
  optionalCostMin: number;
  optionalCostMax: number;
};

export function aggregatePlanCosts(stops: readonly CostedStop[]): PlanCostTotals {
  let requiredCostMin = 0;
  let requiredCostMax = 0;
  let optionalCostMin = 0;
  let optionalCostMax = 0;
  for (const stop of stops) {
    if (stop.isOptional) {
      optionalCostMin += stop.costMin ?? 0;
      optionalCostMax += stop.costMax ?? 0;
    } else {
      requiredCostMin += stop.costMin ?? 0;
      requiredCostMax += stop.costMax ?? 0;
    }
  }
  return {
    costMin: requiredCostMin + optionalCostMin,
    costMax: requiredCostMax + optionalCostMax,
    requiredCostMin,
    requiredCostMax,
    optionalCostMin,
    optionalCostMax,
  };
}

/**
 * FR-SUG-006 + ADR-0029 — over budget is judged on the UPPER bound of the
 * **required** stops only. An optional stop is visible, never silently counted
 * as a commitment. `perPersonBudget <= 0` means the room set no ceiling.
 */
export function isRequiredOverBudget(requiredCostMax: number, perPersonBudget: number): boolean {
  return perPersonBudget > 0 && requiredCostMax > perPersonBudget;
}

/**
 * A totals object stored before GoGo-BE#228 has no split. Every stop stored
 * then is required (the column defaults to `false`), so required = the legacy
 * totals and optional = 0. No JSON rewrite: this runs at read time.
 */
export function normalizeStoredTotals<
  T extends {
    costMin: number;
    costMax: number;
    requiredCostMin?: number | undefined;
    requiredCostMax?: number | undefined;
    optionalCostMin?: number | undefined;
    optionalCostMax?: number | undefined;
  },
>(totals: T): T & Omit<PlanCostTotals, 'costMin' | 'costMax'> {
  return {
    ...totals,
    requiredCostMin: totals.requiredCostMin ?? totals.costMin,
    requiredCostMax: totals.requiredCostMax ?? totals.costMax,
    optionalCostMin: totals.optionalCostMin ?? 0,
    optionalCostMax: totals.optionalCostMax ?? 0,
  };
}
