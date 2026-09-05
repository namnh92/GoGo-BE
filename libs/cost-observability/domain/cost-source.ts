import type { Capability } from './capabilities';
import type { FreshnessStatus } from './freshness';

/**
 * ADR-0014 — the two cost dimensions of `/monitoring`, kept apart from each
 * other and from runtime coverage.
 *
 * `CostSourceKind` is *declared*: how money for a row gets into the ledger.
 * `CostDataFreshness` is *observed*: whether that money is current. A MANUAL
 * source is never "broken" and an AUTO source is never "typed in"; neither
 * says anything about whether the provider's runtime is measured, and the
 * registry status says nothing about either.
 */
export const COST_SOURCE_KINDS = ['AUTO', 'MANUAL', 'NONE'] as const;
export type CostSourceKind = (typeof COST_SOURCE_KINDS)[number];

export const COST_DATA_FRESHNESSES = ['FRESH', 'STALE', 'ERROR'] as const;
export type CostDataFreshness = (typeof COST_DATA_FRESHNESSES)[number];

export type CostSource = {
  kind: CostSourceKind;
  /** `null` when there is nothing to be current: kind NONE, or MANUAL with nothing entered yet. */
  freshness: CostDataFreshness | null;
};

/** Capabilities under which money arrives without a person typing it (epic §6). */
const AUTOMATIC: readonly Capability[] = ['USAGE_COLLECTOR', 'ACTUAL_COST_COLLECTOR', 'FIXED_COST'];

/**
 * `ESTIMATED_COST`, `QUOTA`, `BUDGET` and `TEST_RUN_DELTA` are things done
 * *with* usage, not a way for money to get in, so they decide nothing here.
 */
function kindOf(capabilities: readonly Capability[]): CostSourceKind | null {
  if (capabilities.some((c) => AUTOMATIC.includes(c))) return 'AUTO';
  if (capabilities.includes('MANUAL_COST')) return 'MANUAL';
  return null;
}

type Declares = { capabilities: readonly Capability[] };

/**
 * A provider is AUTO when anything under it is collected or written by code,
 * MANUAL when the only way in is the manual-item form, NONE otherwise.
 */
export function providerCostSourceKind(
  provider: Declares & { services: readonly Declares[] },
): CostSourceKind {
  return (
    kindOf([...provider.capabilities, ...provider.services.flatMap((s) => s.capabilities)]) ??
    'NONE'
  );
}

/**
 * A service's own declarations first, then what it inherits from the provider
 * (the `serviceHasCapability` rule). Play Console declares MANUAL_COST of its
 * own under an AUTO Google and is MANUAL; a Maps SDK declares nothing and
 * inherits Google's ledger, which is AUTO — with nothing to feed it, which is
 * what its runtime coverage says.
 */
export function serviceCostSourceKind(service: Declares, provider: Declares): CostSourceKind {
  return kindOf(service.capabilities) ?? kindOf(provider.capabilities) ?? 'NONE';
}

export type CostDataFacts = {
  kind: CostSourceKind;
  /** Epic §23 roll-up over the sources covering the row; `null` when none covers it. */
  sourceStatus: FreshnessStatus | null;
  /** Days (`YYYY-MM-DD`) of the cost rows behind the row — MANUAL basis apart from the rest. */
  rowDays: { manual: readonly string[]; automatic: readonly string[] };
  today: string;
};

/**
 * - NONE: nothing to be current → `null`.
 * - MANUAL: judged by the materialised rows alone — a collector's health says
 *   nothing about a fee. A row for today → FRESH; older rows only → STALE
 *   (the item expired, or materialisation stopped); no rows → `null`: nothing
 *   was entered, and that is not a failure.
 * - AUTO: the §23 sources when any cover the row — FRESH and STALE as they
 *   are; UNAVAILABLE and UNKNOWN both → ERROR, because a source that promised
 *   to deliver and has nothing usable on record is the operator's problem
 *   whether it failed or never ran (the per-source detail stays on the row
 *   for the drill-down). With no covering source — a FIXED row the scheduler
 *   writes, a collector not registered in this process — the rows decide:
 *   today → FRESH, older → STALE, none → ERROR.
 */
export function costDataFreshness(facts: CostDataFacts): CostDataFreshness | null {
  switch (facts.kind) {
    case 'NONE':
      return null;
    case 'MANUAL':
      return byRows(facts.rowDays.manual, facts.today);
    case 'AUTO': {
      if (facts.sourceStatus !== null) {
        return facts.sourceStatus === 'FRESH' || facts.sourceStatus === 'STALE'
          ? facts.sourceStatus
          : 'ERROR';
      }
      return byRows(facts.rowDays.automatic, facts.today) ?? 'ERROR';
    }
  }
}

function byRows(days: readonly string[], today: string): CostDataFreshness | null {
  if (days.length === 0) return null;
  return days.includes(today) ? 'FRESH' : 'STALE';
}
