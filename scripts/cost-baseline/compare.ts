/**
 * PR3 / COST-BE-003 (#336) — "two consecutive runs must agree within ±1 call
 * per operation" (plan §3 PR3), made executable.
 *
 * The tolerance is per operation and per scenario, never on a sum. Summing
 * first lets `google.searchText` fall by one while `google.details.quality`
 * rises by one and calls the run reproducible, which is the exact pair of
 * movements PR4 and PR5 are meant to produce. A baseline that could not tell
 * those apart could not gate anything.
 *
 * Only call counts are compared. Latency and error rate are not reproducible
 * to ±1 and were never claimed to be; asserting on them would make a green
 * gate a matter of luck, and a gate that flakes gets switched off.
 */

import type { BaselineArtifact, OperationRow, ScenarioId } from './artifact';

export type OperationDrift = {
  scenario: ScenarioId | 'TOTAL';
  operation: string;
  field: 'callsAttempted' | 'callsSucceeded' | 'billableUnits' | 'noNetworkResolutions';
  a: number;
  b: number;
  delta: number;
};

export type ComparisonResult = {
  tolerance: number;
  agrees: boolean;
  drift: OperationDrift[];
  /** Structural mismatch — a different scenario set is not a drift, it is a */
  /** different experiment, and averaging the two would be meaningless. */
  incomparable: string[];
};

const COMPARED_FIELDS = ['callsAttempted', 'callsSucceeded', 'billableUnits'] as const;

/**
 * Compare two baseline artifacts.
 *
 * `tolerance` defaults to the plan's ±1. It is a parameter because the same
 * comparison answers a second question in PR9 — "did the AFTER run move the
 * operations we said it would" — where the expected delta is large and known.
 */
export function compareBaselines(
  a: BaselineArtifact,
  b: BaselineArtifact,
  tolerance = 1,
): ComparisonResult {
  const drift: OperationDrift[] = [];
  const incomparable: string[] = [];

  if (a.run.transport !== b.run.transport) {
    incomparable.push(
      `transport differs: ${a.run.transport} vs ${b.run.transport} — a stubbed run and a live run measure different things`,
    );
  }
  if (a.schemaVersion !== b.schemaVersion) {
    incomparable.push(`schemaVersion differs: ${a.schemaVersion} vs ${b.schemaVersion}`);
  }

  const aScenarios = new Map(a.scenarios.map((s) => [s.id, s]));
  const bScenarios = new Map(b.scenarios.map((s) => [s.id, s]));
  for (const id of new Set([...aScenarios.keys(), ...bScenarios.keys()])) {
    const left = aScenarios.get(id);
    const right = bScenarios.get(id);
    if (!left || !right) {
      incomparable.push(`scenario ${id} present in only one run`);
      continue;
    }
    drift.push(...driftBetween(id, left.operations, right.operations, tolerance));
    const noNetDelta = right.noNetworkResolutions - left.noNetworkResolutions;
    if (Math.abs(noNetDelta) > tolerance) {
      drift.push({
        scenario: id,
        operation: '(no-network resolution)',
        field: 'noNetworkResolutions',
        a: left.noNetworkResolutions,
        b: right.noNetworkResolutions,
        delta: noNetDelta,
      });
    }
  }

  drift.push(...driftBetween('TOTAL', a.totals, b.totals, tolerance));

  return {
    tolerance,
    agrees: drift.length === 0 && incomparable.length === 0,
    drift,
    incomparable,
  };
}

function driftBetween(
  scenario: ScenarioId | 'TOTAL',
  a: OperationRow[],
  b: OperationRow[],
  tolerance: number,
): OperationDrift[] {
  const out: OperationDrift[] = [];
  const left = new Map(a.map((r) => [r.operation, r]));
  const right = new Map(b.map((r) => [r.operation, r]));
  // An operation that appears in one run only is compared against zero rather
  // than skipped: "it did not appear last time" is the most interesting drift
  // there is, and skipping it would report a clean run.
  for (const operation of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    for (const field of COMPARED_FIELDS) {
      const x = left.get(operation)?.[field] ?? 0;
      const y = right.get(operation)?.[field] ?? 0;
      if (Math.abs(y - x) > tolerance) {
        out.push({ scenario, operation, field, a: x, b: y, delta: y - x });
      }
    }
  }
  return out;
}

/** One line per drift, for a CLI that has to be read in a terminal. */
export function formatComparison(result: ComparisonResult): string {
  if (result.agrees) return `agree within ±${result.tolerance} per operation`;
  const lines = result.incomparable.map((why) => `incomparable: ${why}`);
  for (const d of result.drift) {
    lines.push(
      `${d.scenario} ${d.operation} ${d.field}: ${d.a} → ${d.b} (${d.delta > 0 ? '+' : ''}${d.delta})`,
    );
  }
  return lines.join('\n');
}
