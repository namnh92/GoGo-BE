import { describe, expect, it } from 'vitest';
import type { BaselineArtifact, OperationRow, ScenarioReport } from './artifact';
import { compareBaselines, formatComparison } from './compare';

function op(operation: string, attempted: number, units = attempted): OperationRow {
  return {
    operation,
    provider: 'places',
    googleSku: null,
    unit: 'request',
    callsAttempted: attempted,
    callsSucceeded: attempted,
    billableUnits: units,
    estimatedCostMicros: null,
    estimatedCostAfterFreeCapMicros: null,
    metricsCalls: null,
    ledgerMinusMetrics: null,
    gap: null,
  };
}

function scenario(operations: OperationRow[]): ScenarioReport {
  return {
    id: 'D',
    title: 'D',
    pinnedInput: 'x',
    operations,
    noNetworkResolutions: 5,
    reservations: [],
    crossCheck: [],
    latency: {
      apiP50Ms: 1,
      apiP95Ms: 2,
      providerP50Ms: null,
      providerP95Ms: null,
      measuresRealNetwork: false,
    },
    errors: { providerRequests: 0, providerFailures: 0, providerErrorRate: null, apiNon2xx: 0 },
    functional: {
      assertions: [],
      rowsCreated: 0,
      rowsDeduped: 0,
      rowsRejected: 0,
      duplicatePlaceRate: 1,
    },
    redis: { commands: null, method: 'manual' },
  };
}

function artifact(operations: OperationRow[]): BaselineArtifact {
  return {
    schemaVersion: 1,
    name: 'x',
    kind: 'BEFORE',
    createdAt: '2026-09-02T00:00:00.000Z',
    run: {
      transport: 'stub',
      environment: 'dev',
      providerMode: 'google',
      gitSha: 'abc',
      day: '2026-09-02',
      pricingVersion: '2026-09-01',
      currency: 'USD',
      basis: 'ESTIMATED',
      confidence: 'MEDIUM',
    },
    preflight: { checks: [], quiet: true },
    scenarios: [scenario(operations)],
    totals: operations,
    gaps: [],
    limitations: [],
  };
}

describe('#336 compareBaselines', () => {
  it('accepts a ±1 wobble per operation', () => {
    const result = compareBaselines(
      artifact([op('google.details.quality', 15)]),
      artifact([op('google.details.quality', 16)]),
    );
    expect(result.agrees).toBe(true);
    expect(formatComparison(result)).toContain('±1');
  });

  it('does not let two operations cancel out — the whole point of per-operation', () => {
    // A sum would call this identical: 15 + 5 === 13 + 7.
    const before = artifact([op('google.details.quality', 15), op('google.details.core', 5)]);
    const after = artifact([op('google.details.quality', 13), op('google.details.core', 7)]);
    const result = compareBaselines(before, after);
    expect(result.agrees).toBe(false);
    expect([...new Set(result.drift.map((d) => d.operation))].sort()).toEqual([
      'google.details.core',
      'google.details.quality',
    ]);
    // Reported once per compared field, per scenario and again in totals —
    // so the reader sees which half moved which way, not a net of zero.
    expect([...new Set(result.drift.map((d) => d.scenario))].sort()).toEqual(['D', 'TOTAL']);
    expect(result.drift.map((d) => d.delta)).toContain(-2);
    expect(result.drift.map((d) => d.delta)).toContain(2);
  });

  it('treats an operation that appeared from nowhere as drift, not as absent', () => {
    const result = compareBaselines(artifact([]), artifact([op('google.searchText', 4)]));
    expect(result.agrees).toBe(false);
    expect(result.drift[0]).toMatchObject({ operation: 'google.searchText', a: 0, b: 4 });
  });

  it('refuses to compare a stubbed run against a live one', () => {
    const live = artifact([]);
    live.run.transport = 'live';
    const result = compareBaselines(artifact([]), live);
    expect(result.agrees).toBe(false);
    expect(result.incomparable[0]).toContain('transport differs');
  });

  it('reports a scenario present in only one run as incomparable', () => {
    const missing = artifact([]);
    missing.scenarios = [];
    const result = compareBaselines(artifact([]), missing);
    expect(result.incomparable).toContain('scenario D present in only one run');
  });
});
