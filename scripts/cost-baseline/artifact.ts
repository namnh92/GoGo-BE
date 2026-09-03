/**
 * PR3 / COST-BE-003 (#336) — the shape of a frozen baseline.
 *
 * Source: `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md` §4.
 *
 * One rule outranks every other decision in this file, and it is the plan's
 * own sentence: **every baseline reports operations separately — never a
 * single "Google calls" number.** There is no field anywhere in this type that
 * sums `google.searchText` with `google.details.quality`. They are different
 * SKUs at different prices, PR4 and PR5 move them in opposite directions, and
 * a total would hide exactly the change the baseline exists to prove.
 *
 * Three further absences are deliberate:
 *
 * - **No `billed` or `actual`.** Every money field is an estimate at list
 *   price, labelled `basis: 'ESTIMATED'`. GoGo cannot see the invoice, and a
 *   field named `actual` would be read as one.
 * - **No zero for an unmeasured thing.** Redis is not measured per scenario and
 *   Maps SDK is not measured at all; both carry `null` and a named reason. A `0`
 *   would claim the traffic did not happen.
 * - **No single latency number per run.** Latency is per scenario, because
 *   scenario B (ten text searches) and scenario E (a twenty-row bulk import)
 *   are not the same workload and their p95s do not belong in one column.
 */

import type {
  CostGap,
  OpsProvider,
  PricingUnit,
} from '../../libs/modules/cost/domain/provider-pricing';

export const BASELINE_SCHEMA_VERSION = 1;

/** The scenarios pinned in plan §4. C splits because C1 and C2 differ in `google.expand`. */
export const SCENARIO_IDS = ['A', 'B', 'C1', 'C2', 'D', 'E'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/**
 * How the provider was reached.
 *
 * - `stub` — the real adapters, the real field masks, the real orchestration;
 *   only the HTTP transport is a pinned response table. Deterministic, costs
 *   nothing, runs in CI. It measures **call shape**: how many requests of
 *   which operation each flow makes. That is precisely what PR4 and PR5
 *   change, so it is the half of the baseline that can be frozen today.
 * - `live` — real Google in DEV. Adds the half a stub cannot have: real
 *   latency, real error rate, real billable units as Google counts them.
 *   Requires credentials and the §4 quiet window.
 *
 * A run never mixes them, and the artifact says which it was, because a
 * latency number from `stub` would be a measurement of this laptop.
 */
export type BaselineTransport = 'stub' | 'live';

export type OperationRow = {
  /** The adapter's `method` label — never a SKU, never a group. */
  operation: string;
  provider: OpsProvider | null;
  googleSku: string | null;
  unit: PricingUnit | null;
  /** From `provider_usage_daily`, the accounting source. */
  callsAttempted: number;
  callsSucceeded: number;
  billableUnits: number;
  /** List price × units. `null` = the price is unknown, not that it is free. */
  estimatedCostMicros: number | null;
  /** Free-cap-adjusted. Reporting only — never reaches a budget guard. */
  estimatedCostAfterFreeCapMicros: number | null;
  /**
   * The same count as the process's own `/metrics` saw. The ledger is the
   * accounting source and this is the cross-check; they are reported side by
   * side and never reconciled into one number, because a disagreement is the
   * finding.
   */
  metricsCalls: number | null;
  /** `metricsCalls − callsAttempted`. Non-zero means a flush was in flight. */
  ledgerMinusMetrics: number | null;
  /** Why a number above is missing, when one is. */
  gap: CostGap['kind'] | null;
};

/** `provider_budget_daily` movement, per scope — PR7 spends against this. */
export type ReservationRow = {
  scope: string;
  operation: string;
  reservedCalls: number;
  reservedUnits: number;
  reservedCostMicros: number;
};

/** Grafana `increase()` beside the ledger, per operation. */
export type CrossCheckRow = {
  operation: string;
  ledgerCalls: number;
  grafanaCalls: number | null;
  /** `null` when Grafana was not reachable — never folded into a pass. */
  agreesWithinOne: boolean | null;
};

export type LatencyReport = {
  /** Whole API requests the scenario issued. */
  apiP50Ms: number | null;
  apiP95Ms: number | null;
  /** Provider calls underneath them. */
  providerP50Ms: number | null;
  providerP95Ms: number | null;
  /**
   * True when the numbers describe a real network. A `stub` run leaves these
   * populated but flagged, so nobody compares a stubbed p95 against DEV's.
   */
  measuresRealNetwork: boolean;
};

export type ErrorReport = {
  providerRequests: number;
  providerFailures: number;
  /** `null` when nothing was requested — 0/0 is not a 0% error rate. */
  providerErrorRate: number | null;
  apiNon2xx: number;
};

/**
 * The correctness column of §4. A cost baseline that did not also record what
 * the flow *did* would let PR4 "save" every call by breaking the feature.
 */
export type FunctionalReport = {
  /** Free-form per scenario, but pinned: the spec's own correctness column. */
  assertions: { name: string; expected: string; actual: string; pass: boolean }[];
  rowsCreated: number;
  rowsDeduped: number;
  rowsRejected: number;
  /** `places` rows per distinct `external_id`. > 1 means identity split. */
  duplicatePlaceRate: number | null;
};

export type ScenarioReport = {
  id: ScenarioId;
  title: string;
  /** The fixture file and key this run consumed, so it can be re-run exactly. */
  pinnedInput: string;
  operations: OperationRow[];
  /**
   * URLs that already carried a `place_id`, answered by
   * `GooglePlacesAdapter.resolveUrl()` with no request at all
   * (`google-places.adapter.ts:81-82`). Counted because PR4's DB-first path
   * must not be credited with savings this already delivers.
   */
  noNetworkResolutions: number;
  reservations: ReservationRow[];
  crossCheck: CrossCheckRow[];
  latency: LatencyReport;
  errors: ErrorReport;
  functional: FunctionalReport;
  /**
   * Upstash gives no per-command API on the free tier, so this is read off the
   * console by hand. `commands: null` with the method written down beats a
   * fabricated count.
   */
  redis: { commands: number | null; method: string };
};

export type PreflightReport = {
  /** Every gate, and whether it held. A failed gate does not stop the run — */
  /** it is recorded, so a contaminated baseline can never look clean. */
  checks: { name: string; required: boolean; pass: boolean; detail: string }[];
  quiet: boolean;
};

export type BaselineArtifact = {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  name: string;
  kind: 'BEFORE' | 'AFTER';
  createdAt: string;
  run: {
    transport: BaselineTransport;
    environment: string;
    providerMode: 'google' | 'fake';
    gitSha: string;
    /** UTC day the ledger keyed its rows by. */
    day: string;
    pricingVersion: string;
    currency: string;
    basis: 'ESTIMATED';
    confidence: 'MEDIUM';
  };
  preflight: PreflightReport;
  scenarios: ScenarioReport[];
  /** Per operation across every scenario. Still per operation. */
  totals: OperationRow[];
  /** Registry rows that can never produce a number until something else changes. */
  gaps: CostGap[];
  /** Written down rather than implied. Read before trusting any number above. */
  limitations: string[];
};
