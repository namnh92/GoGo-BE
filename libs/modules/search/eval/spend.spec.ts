import { describe, expect, it } from 'vitest';
import type { IntentCallRecord } from '../application/intent-classification.service';
import { committedSpendUsd, parseSpendSettings, unknownCostCalls } from './spend';

const call = (
  outcome: IntentCallRecord['outcome'],
  costUsd: number | null = null,
): IntentCallRecord => ({
  outcome,
  model: null,
  latencyMs: 1,
  inputTokens: null,
  costUsd,
});

describe('eval spend accounting (PR #710 review r1)', () => {
  it('a rejected answer counts against the ceiling: the response may already have been billed', () => {
    expect(committedSpendUsd([call('invalid_response')], 0.001)).toBe(0.001);
  });

  it('every sent call without a reported cost counts at the ceiling', () => {
    for (const outcome of ['answered', 'timeout', 'provider_error', 'invalid_response'] as const) {
      expect(committedSpendUsd([call(outcome)], 0.001), outcome).toBe(0.001);
    }
  });

  it('a reported cost is used as reported', () => {
    expect(committedSpendUsd([call('answered', 0.00002)], 0.001)).toBe(0.00002);
  });

  it('only calls that never reached inference count as zero', () => {
    expect(committedSpendUsd([call('disabled'), call('empty_request'), call('quota')], 0.001)).toBe(
      0,
    );
  });

  it('the unknown-cost count matches what the ceiling charged', () => {
    const calls = [
      call('invalid_response'),
      call('timeout'),
      call('answered', 0.00002),
      call('quota'),
      call('disabled'),
    ];
    expect(unknownCostCalls(calls)).toBe(2);
  });
});

describe('eval spend settings (PR #710 review r2)', () => {
  it('defaults when unset', () => {
    expect(parseSpendSettings({})).toEqual({ maxUsd: 0.05, unknownCallUsd: 0.001 });
  });

  it('rejects settings that would disable the ceiling', () => {
    for (const env of [
      { INTENT_EVAL_MAX_USD: '0,05' },
      { INTENT_EVAL_MAX_USD: '' },
      { INTENT_EVAL_MAX_USD: '-1' },
      { INTENT_EVAL_MAX_USD: 'Infinity' },
      { INTENT_EVAL_UNKNOWN_CALL_USD: '' },
      { INTENT_EVAL_UNKNOWN_CALL_USD: '0' },
      { INTENT_EVAL_UNKNOWN_CALL_USD: 'abc' },
    ]) {
      expect(() => parseSpendSettings(env), JSON.stringify(env)).toThrow();
    }
  });

  it('accepts a zero ceiling (no paid call allowed) and explicit values', () => {
    expect(
      parseSpendSettings({ INTENT_EVAL_MAX_USD: '0', INTENT_EVAL_UNKNOWN_CALL_USD: '0.002' }),
    ).toEqual({
      maxUsd: 0,
      unknownCallUsd: 0.002,
    });
  });
});
