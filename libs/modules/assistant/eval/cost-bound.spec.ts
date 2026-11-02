import { describe, expect, it } from 'vitest';
import type { IntentTaxonomy } from '../../search/domain/intent';
import { MAX_REQUEST_CHARS } from '../../search/domain/intent';
import { TURN_CALL_SHARE } from '../domain/limits';
import {
  PRICES,
  calibrationDrift,
  computeCostBound,
  filler,
  worstCases,
  type TokenCounter,
} from './cost-bound';
import calibration from './cost-bound.calibration.json';

const TAXONOMY: IntentTaxonomy = {
  category: [{ key: 'category:cafe', label: 'cà phê' }],
  mood: [{ key: 'romantic', label: 'lãng mạn' }],
  setting: [{ key: 'outdoor', label: 'ngoài trời' }],
  suitability: [{ key: 'couple', label: 'Cặp đôi' }],
};
const counter: TokenCounter = {
  decision: async () => 6_000,
  relevance: async () => 4_000,
  compose: async () => 5_000,
};

describe('#738 D-11 the cost bound', () => {
  it('computes C from a fixture taxonomy, deterministically, per direction', async () => {
    const first = await computeCostBound(worstCases(TAXONOMY, 600), counter);
    const second = await computeCostBound(worstCases(TAXONOMY, 600), counter);
    expect(first).toEqual(second);
    // 2×6k + 4k in at $0.042/1M; 5k in at $0.10/1M + 600 out at $0.50/1M; ×1.25.
    expect(first.ceilingUsd).toBe(0.00184);
    expect(first.calls.decision).toBeCloseTo(0.000252, 9);
    expect(first.shares).toEqual({ decision: 0.171, relevance: 0.114, compose: 0.543 });
  });

  it('allocates the BYOK fee inside the margin', async () => {
    const bound = await computeCostBound(worstCases(TAXONOMY, 600), counter);
    expect(bound.byokFeeUsd).toBeCloseTo(0.00004, 9);
    expect(bound.byokFeeUsd).toBeLessThan(bound.marginUsd);
  });

  for (const call of ['decision', 'relevance', 'compose'] as const) {
    it(`fails closed without a provider count for ${call}`, async () => {
      await expect(
        computeCostBound(worstCases(TAXONOMY, 600), { ...counter, [call]: async () => null }),
      ).rejects.toThrow(/failing closed/);
    });
  }

  it('serializes the caps and state.resolved into the worst-case requests', () => {
    const cases = worstCases(TAXONOMY, 600);
    const decision = cases.decision.state as Record<string, unknown>;
    expect(decision.resolved).toBeDefined();
    expect(decision.request).toHaveLength(MAX_REQUEST_CHARS);
    expect(Object.keys(cases.decision.questions)).toContain('turn_relation');
    expect((cases.relevance.state as Record<string, unknown>).resolved).toBeDefined();
    expect(cases.compose[0]!.role).toBe('system');
  });

  it('the code shares are the committed calibration, and drift is named', () => {
    expect(TURN_CALL_SHARE).toEqual(calibration.shares);
    expect(calibration.ceilingUsd).toBeGreaterThan(0);
    const run = {
      shares: calibration.shares,
      tokens: calibration.tokens,
      ceilingUsd: calibration.ceilingUsd,
    };
    const terms = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, label: `${prefix}${i}` }));
    const recorded: IntentTaxonomy = {
      category: terms(calibration.taxonomyCounts.category, 'c'),
      mood: terms(calibration.taxonomyCounts.mood, 'm'),
      setting: terms(calibration.taxonomyCounts.setting, 's'),
      suitability: terms(calibration.taxonomyCounts.suitability, 'o'),
    };
    const inputs = {
      models: calibration.models,
      prices: PRICES,
      taxonomy: recorded,
      outputTokens: 600,
    };
    const drift = (b: Partial<typeof run>, i: Partial<typeof inputs>) =>
      calibrationDrift({ ...run, ...b }, { ...inputs, ...i }, TURN_CALL_SHARE, calibration);
    expect(drift({}, {})).toEqual([]);
    expect(drift({}, { taxonomy: TAXONOMY })).toContainEqual(
      expect.stringContaining('taxonomy category'),
    );
    expect(drift({ shares: { ...run.shares, compose: 0.5 } }, {})).toContainEqual(
      expect.stringContaining('share compose: run'),
    );
    // F-11: proportional prices keep every share; the prices and the ceiling still differ.
    const doubled = {
      jevIn: PRICES.jevIn * 2,
      jevOut: 0,
      haikuIn: PRICES.haikuIn * 2,
      haikuOut: PRICES.haikuOut * 2,
    };
    const priced = drift({ ceilingUsd: run.ceilingUsd * 2 }, { prices: doubled });
    expect(priced).toContainEqual(expect.stringContaining('price jevIn'));
    expect(priced).toContainEqual(expect.stringContaining('C:'));
    expect(
      drift({}, { models: { ...inputs.models, haiku: 'anthropic/claude-haiku-6' } }),
    ).toContainEqual(expect.stringContaining('model haiku'));
    expect(drift({ tokens: { ...run.tokens, compose: 30_000 } }, {})).toContainEqual(
      expect.stringContaining('tokens compose'),
    );
    expect(drift({}, { outputTokens: 700 })).toContainEqual(
      expect.stringContaining('output tokens'),
    );
  });

  it('the filler is deterministic and at its cap', () => {
    expect(filler(300)).toBe(filler(300));
    expect(filler(300).length).toBeLessThanOrEqual(300);
  });
});
