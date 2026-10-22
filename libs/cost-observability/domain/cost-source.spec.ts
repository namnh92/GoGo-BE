import { describe, expect, it } from 'vitest';
import { COST_REGISTRY } from './registry';
import { costDataFreshness, providerCostSourceKind, serviceCostSourceKind } from './cost-source';

describe('cost source kind — declared, from capabilities (ADR-0014)', () => {
  const provider = (id: string) => COST_REGISTRY.provider(id)!;
  const service = (id: string) => COST_REGISTRY.service(id)!;

  it('AUTO when anything under the provider is collected or written by code', () => {
    for (const id of [
      'google',
      'cloudflare',
      'upstash',
      'neon',
      'aws',
      'github',
      'sentry',
      'gogo',
    ]) {
      expect(providerCostSourceKind(provider(id)), id).toBe('AUTO');
    }
  });

  it('MANUAL when the manual-item form is the only way in; NONE when there is none', () => {
    for (const id of ['apple', 'hosting', 'registrar', 'operations']) {
      expect(providerCostSourceKind(provider(id)), id).toBe('MANUAL');
    }
    for (const id of ['onesignal', 'tenjin', 'adjust', 'grafana']) {
      expect(providerCostSourceKind(provider(id)), id).toBe('NONE');
    }
  });

  it('#704: Adjust is planned beside Tenjin — attribution only, no cost source, nothing estimated', () => {
    const adjust = provider('adjust');
    expect(adjust.status).toBe('planned');
    expect(adjust.services?.map((s) => s.id)).toEqual(['adjust.attribution']);
    expect(service('adjust.attribution').category).toBe('attribution');
    expect(service('adjust.attribution').meters?.map((m) => [m.metric, m.unit])).toEqual([
      ['attributions', 'conversion'],
    ]);
    expect(provider('tenjin').status).toBe('planned');
  });

  it('#709: OpenRouter is an actual bill, split by who holds the key — nothing estimated', () => {
    const openrouter = provider('openrouter');
    expect(openrouter.status).toBe('active');
    expect(providerCostSourceKind(openrouter)).toBe('AUTO');
    expect(openrouter.services?.map((s) => [s.id, s.category])).toEqual([
      ['openrouter.decisions', 'ai_decisions'],
      ['openrouter.dev_tooling', 'operations'],
      ['openrouter.other_keys', 'ai_decisions'],
    ]);
    for (const s of openrouter.services ?? []) {
      expect(serviceCostSourceKind(s, openrouter), s.id).toBe('AUTO');
      expect(s.meters?.map((m) => [m.metric, m.unit, m.billable])).toEqual([
        ['requests', 'request', false],
        ['input_tokens', 'token', false],
        ['output_tokens', 'token', false],
      ]);
    }
  });

  it('a service declares for itself before it inherits: Play Console is MANUAL under an AUTO Google', () => {
    const google = provider('google');
    expect(serviceCostSourceKind(service('google.play_console'), google)).toBe('MANUAL');
    expect(serviceCostSourceKind(service('google.places'), google)).toBe('AUTO');
    expect(serviceCostSourceKind(service('google.maps_sdk_ios'), google)).toBe('AUTO');
    // #563: the same rule for the GitHub plan under an AUTO GitHub.
    const github = provider('github');
    expect(serviceCostSourceKind(service('github.subscription'), github)).toBe('MANUAL');
    expect(serviceCostSourceKind(service('github.actions'), github)).toBe('AUTO');
    // #695: the Sentry plan + Seer the same way under an AUTO Sentry.
    const sentry = provider('sentry');
    expect(serviceCostSourceKind(service('sentry.subscription'), sentry)).toBe('MANUAL');
    expect(serviceCostSourceKind(service('sentry.errors'), sentry)).toBe('AUTO');
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
      costDataFreshness({
        kind: 'NONE',
        sourceStatus: 'FRESH',
        rowDays: none,
        expectedManualDays: [],
        today,
      }),
    ).toBeNull();
  });

  it('AUTO with a covering source: FRESH and STALE as they are, UNAVAILABLE is ERROR, never-attempted is UNKNOWN', () => {
    const auto = (sourceStatus: 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'UNKNOWN') =>
      costDataFreshness({
        kind: 'AUTO',
        sourceStatus,
        rowDays: none,
        expectedManualDays: [],
        today,
      });
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
        expectedManualDays: [],
        today,
      });
    expect(auto([today])).toBe('FRESH');
    expect(auto(['2026-09-01', '2026-09-09'])).toBe('STALE');
    expect(auto([])).toBe('UNKNOWN');
    expect(auto([], [today])).toBe('UNKNOWN');
  });

  it('MANUAL reads the materialised rows against the billing schedule — a source never decides (ADR-0015)', () => {
    const manual = (days: string[], expected: string[]) =>
      costDataFreshness({
        kind: 'MANUAL',
        sourceStatus: 'UNAVAILABLE',
        rowDays: { manual: days, automatic: [today] },
        expectedManualDays: expected,
        today,
      });
    // A monthly fee billed on the 1st: its row is there, nothing is due today → FRESH.
    expect(manual(['2026-09-01'], ['2026-09-01'])).toBe('FRESH');
    // Due on the 1st and on the 8th, only the 1st landed → the materialiser is behind.
    expect(manual(['2026-09-01'], ['2026-09-01', '2026-09-08'])).toBe('STALE');
    // Rows with nothing due: a moved anchor or a pre-0043 daily share not yet swept.
    expect(manual(['2026-08-31'], [])).toBe('STALE');
    // Nothing entered, or nothing billed yet.
    expect(manual([], [])).toBeNull();
  });
});
