import { describe, expect, it } from 'vitest';
import type { IntentTaxonomy } from '../../search/domain/intent';
import { MAX_REQUEST_CHARS } from '../../search/domain/intent';
import { computeCostBound, filler, worstCases, type TokenCounter } from './cost-bound';

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

  it('the filler is deterministic and at its cap', () => {
    expect(filler(300)).toBe(filler(300));
    expect(filler(300).length).toBeLessThanOrEqual(300);
  });
});
