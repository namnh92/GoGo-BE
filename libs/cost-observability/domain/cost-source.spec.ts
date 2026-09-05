import { describe, expect, it } from 'vitest';
import { COST_REGISTRY } from './registry';
import { costDataFreshness, providerCostSourceKind, serviceCostSourceKind } from './cost-source';

describe('cost source kind — declared, from capabilities (ADR-0014)', () => {
  const provider = (id: string) => COST_REGISTRY.provider(id)!;
  const service = (id: string) => COST_REGISTRY.service(id)!;

  it('AUTO when anything under the provider is collected or written by code', () => {
    for (const id of ['google', 'cloudflare', 'upstash', 'neon', 'aws', 'github', 'gogo']) {
      expect(providerCostSourceKind(provider(id)), id).toBe('AUTO');
    }
  });

  it('MANUAL when the manual-item form is the only way in; NONE when there is none', () => {
    for (const id of ['apple', 'hosting', 'registrar']) {
      expect(providerCostSourceKind(provider(id)), id).toBe('MANUAL');
    }
    for (const id of ['onesignal', 'tenjin', 'grafana', 'sentry']) {
      expect(providerCostSourceKind(provider(id)), id).toBe('NONE');
    }
  });

  it('a service declares for itself before it inherits: Play Console is MANUAL under an AUTO Google', () => {
    const google = provider('google');
    expect(serviceCostSourceKind(service('google.play_console'), google)).toBe('MANUAL');
    expect(serviceCostSourceKind(service('google.places'), google)).toBe('AUTO');
    expect(serviceCostSourceKind(service('google.maps_sdk_ios'), google)).toBe('AUTO');
    expect(serviceCostSourceKind({ capabilities: [] }, { capabilities: [] })).toBe('NONE');
    // Estimating, quota, budget and test deltas are not a way for money in.
    expect(
      serviceCostSourceKind(
        { capabilities: ['ESTIMATED_COST', 'QUOTA', 'BUDGET', 'TEST_RUN_DELTA'] },
        { capabilities: [] },
      ),
    ).toBe('NONE');
    // Own automatic beats own manual.
    expect(
      serviceCostSourceKind(
        { capabilities: ['MANUAL_COST', 'USAGE_COLLECTOR'] },
        { capabilities: [] },
      ),
    ).toBe('AUTO');
  });
});

describe('cost data freshness — observed (ADR-0014)', () => {
  const today = '2026-09-10';
  const none = { manual: [], automatic: [] };

  it('NONE has nothing to be current', () => {
    expect(
      costDataFreshness({ kind: 'NONE', sourceStatus: 'FRESH', rowDays: none, today }),
    ).toBeNull();
  });

  it('AUTO with a covering source: FRESH and STALE as they are, UNAVAILABLE is ERROR, never-attempted is UNKNOWN', () => {
    const auto = (sourceStatus: 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'UNKNOWN') =>
      costDataFreshness({ kind: 'AUTO', sourceStatus, rowDays: none, today });
    expect(auto('FRESH')).toBe('FRESH');
    expect(auto('STALE')).toBe('STALE');
    // Attempted and failed: the only way to ERROR.
    expect(auto('UNAVAILABLE')).toBe('ERROR');
    // Never attempted: not a failure, and never reported as one.
    expect(auto('UNKNOWN')).toBe('UNKNOWN');
  });

  it('AUTO with no covering source is judged by its automatic rows, and MANUAL rows do not count for it', () => {
    const auto = (automatic: string[], manual: string[] = []) =>
      costDataFreshness({
        kind: 'AUTO',
        sourceStatus: null,
        rowDays: { manual, automatic },
        today,
      });
    expect(auto([today])).toBe('FRESH');
    expect(auto(['2026-09-01', '2026-09-09'])).toBe('STALE');
    expect(auto([])).toBe('UNKNOWN');
    expect(auto([], [today])).toBe('UNKNOWN');
  });

  it('MANUAL reads the materialised rows only: today FRESH, older STALE, nothing entered null — a source never decides', () => {
    const manual = (days: string[]) =>
      costDataFreshness({
        kind: 'MANUAL',
        sourceStatus: 'UNAVAILABLE',
        rowDays: { manual: days, automatic: [today] },
        today,
      });
    expect(manual([today])).toBe('FRESH');
    expect(manual(['2026-08-31'])).toBe('STALE');
    expect(manual([])).toBeNull();
  });
});
