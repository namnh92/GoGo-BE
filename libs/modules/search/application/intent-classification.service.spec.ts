import {
  FakeDecisionProvider,
  OpenRouterDecisionProvider,
  resetBreakers,
  type DecisionRequest,
} from '@gogo/providers';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEED_TAXONOMY } from '../eval/seed-taxonomy';
import {
  IntentClassificationService,
  type IntentCallRecord,
} from './intent-classification.service';

const EXAMPLE = 'Tối nay 4 người đi ăn lẩu khoảng 300k/người, gần Cầu Giấy, ưu tiên quán yên tĩnh.';

/** Answers every question "plainly": in scope, first option, low P for nouls. */
function plainAnswers(request: DecisionRequest) {
  return Object.fromEntries(
    Object.entries(request.questions).map(([key, q]) => {
      if (q.type === 'choice')
        return [
          key,
          {
            type: 'choice',
            choice: key === 'category' ? 'restaurant' : Object.keys(q.criteria)[0],
          },
        ];
      if (q.type === 'score') return [key, { type: 'score', score: 0 }];
      return [key, { type: 'noul', noul: key === 'in_scope' || key === 'mood:chill' ? 0.9 : 0.1 }];
    }),
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('IntentClassificationService', () => {
  beforeEach(() => resetBreakers());

  it('disabled (the default) never calls the provider', async () => {
    const provider = new FakeDecisionProvider(plainAnswers);
    const r = await new IntentClassificationService(provider, 'disabled').classify(
      EXAMPLE,
      SEED_TAXONOMY,
    );
    expect(provider.requests).toHaveLength(0);
    expect(r.source).toBe('fallback');
    expect(r.fallbackReason).toBe('disabled');
    expect(r.facts.budget).toEqual({ amount: 300_000, currency: 'VND', mode: 'per_person' });
  });

  it('enabled: the model answers judgments, code keeps the facts', async () => {
    const provider = new FakeDecisionProvider(plainAnswers);
    const calls: IntentCallRecord[] = [];
    const r = await new IntentClassificationService(provider, 'enabled', (c) =>
      calls.push(c),
    ).classify(EXAMPLE, SEED_TAXONOMY);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.state).toEqual({ request: EXAMPLE });
    expect(r.source).toBe('decision_model');
    expect(r.category.key).toBe('restaurant');
    expect(r.moods).toEqual([{ key: 'chill', probability: 0.9 }]);
    expect(r.facts.partySize).toBe(4);
    expect(calls[0]).toMatchObject({
      outcome: 'answered',
      model: 'fake/decision-fixture',
      costUsd: null,
    });
  });

  it('an empty request asks, without a call', async () => {
    const provider = new FakeDecisionProvider(plainAnswers);
    const r = await new IntentClassificationService(provider, 'enabled').classify(
      ' ',
      SEED_TAXONOMY,
    );
    expect(provider.requests).toHaveLength(0);
    expect(r.clarification).toEqual({ needed: true, reasons: ['empty_request'] });
  });

  it('a malformed answer falls back as invalid_response', async () => {
    const provider = new FakeDecisionProvider(() => ({ in_scope: { type: 'noul', noul: 2 } }));
    const r = await new IntentClassificationService(provider, 'enabled').classify(
      EXAMPLE,
      SEED_TAXONOMY,
    );
    expect(r.source).toBe('fallback');
    expect(r.fallbackReason).toBe('invalid_response');
  });

  it('live adapter: timeout falls back within the deadline, cost unknown', async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        ),
      )) as typeof fetch;
    const provider = new OpenRouterDecisionProvider({
      apiKey: 'k',
      model: 'typesafe/jev-1.14',
      timeoutMs: 30,
      fetchImpl: hang,
    });
    const calls: IntentCallRecord[] = [];
    const started = Date.now();
    const r = await new IntentClassificationService(provider, 'enabled', (c) =>
      calls.push(c),
    ).classify(EXAMPLE, SEED_TAXONOMY);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.fallbackReason).toBe('timeout');
    expect(calls[0]?.costUsd).toBeNull();
  });

  it('live adapter: 402 is quota, 401 is a provider error — both fall back', async () => {
    for (const [status, reason] of [
      [402, 'quota'],
      [401, 'provider_error'],
    ] as const) {
      const provider = new OpenRouterDecisionProvider({
        apiKey: 'k',
        model: 'typesafe/jev-1.14',
        timeoutMs: 1_000,
        fetchImpl: (async () => json(status, { error: { message: 'x' } })) as typeof fetch,
      });
      const r = await new IntentClassificationService(provider, 'enabled').classify(
        EXAMPLE,
        SEED_TAXONOMY,
      );
      expect(r.fallbackReason, String(status)).toBe(reason);
    }
  });
});
