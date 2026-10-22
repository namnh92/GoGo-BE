import { beforeEach, describe, expect, it } from 'vitest';
import {
  DecisionContractError,
  OPENROUTER_DECISIONS_URL,
  OpenRouterDecisionProvider,
  parseDecisionResponse,
  type DecisionRequest,
} from './openrouter-decisions.adapter';
import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
} from './ports';
import { resetBreakers } from './resilience';

const request: DecisionRequest = {
  state: { request: 'đi ăn lẩu' },
  questions: {
    in_scope: { type: 'noul', instructions: 'Is it an outing?' },
    category: {
      type: 'choice',
      instructions: 'Which kind?',
      criteria: { restaurant: 'Nhà hàng', none: 'None' },
    },
    level: { type: 'score', instructions: 'How loud?', criteria: ['quiet', 'normal', 'loud'] },
  },
};

const ok = {
  id: 'gen-dec-1',
  model: 'typesafe/jev-1.14-20261014',
  provider: 'TypeSafe',
  answers: {
    in_scope: { type: 'noul', noul: 0.96 },
    category: {
      type: 'choice',
      choice: 'restaurant',
      probabilities: { restaurant: 0.8, none: 0.2 },
      confidence: 0.6,
    },
    level: { type: 'score', score: 0.4 },
  },
  usage: { input_tokens: 120, output_tokens: 20, cost: 0.000005 },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function provider(respond: () => Response | Promise<Response>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return {
    p: new OpenRouterDecisionProvider({
      apiKey: 'test-key',
      model: 'typesafe/jev-1.14',
      timeoutMs: 1_000,
      fetchImpl,
    }),
    sent,
  };
}

describe('OpenRouterDecisionProvider', () => {
  beforeEach(() => resetBreakers());

  it('posts the documented body with a bearer key and returns the exact build', async () => {
    const { p, sent } = provider(() => json(200, ok));
    const r = await p.decide(request);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(OPENROUTER_DECISIONS_URL);
    expect((sent[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(Object.keys(JSON.parse(String(sent[0]?.init.body))).sort()).toEqual([
      'model',
      'questions',
      'state',
    ]);
    expect(r.model).toBe('typesafe/jev-1.14-20261014');
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 20, costUsd: 0.000005 });
    expect(r.answers.level).toEqual({ type: 'score', score: 0.4 });
  });

  it('maps errors and never retries a billed call', async () => {
    const cases: [number, new (...args: never[]) => Error][] = [
      [401, ProviderConfigurationError],
      [402, ProviderQuotaExceededError],
      [400, ProviderInvalidRequestError],
      [503, ProviderUnavailableError],
      [429, ProviderUnavailableError],
    ];
    for (const [status, type] of cases) {
      resetBreakers();
      const { p, sent } = provider(() => json(status, { error: { message: 'x' } }));
      await expect(p.decide(request), String(status)).rejects.toBeInstanceOf(type);
      expect(sent, String(status)).toHaveLength(1);
    }
  });

  it('a missing key is a configuration error before any request', async () => {
    const p = new OpenRouterDecisionProvider({
      apiKey: '',
      model: 'typesafe/jev-1.14',
      timeoutMs: 1_000,
    });
    await expect(p.decide(request)).rejects.toBeInstanceOf(ProviderConfigurationError);
  });

  it('refuses aliases and timeouts above 15 s', () => {
    expect(
      () =>
        new OpenRouterDecisionProvider({
          apiKey: 'k',
          model: '~typesafe/jev-latest',
          timeoutMs: 1_000,
        }),
    ).toThrow(/alias/);
    expect(
      () =>
        new OpenRouterDecisionProvider({
          apiKey: 'k',
          model: 'typesafe/jev-1.14',
          timeoutMs: 20_000,
        }),
    ).toThrow(/timeout/);
  });
});

describe('parseDecisionResponse', () => {
  const bad: [string, unknown][] = [
    [
      'choice not an option',
      { ...ok, answers: { ...ok.answers, category: { type: 'choice', choice: 'bar' } } },
    ],
    ['noul above 1', { ...ok, answers: { ...ok.answers, in_scope: { type: 'noul', noul: 1.2 } } }],
    [
      'missing answer',
      { ...ok, answers: { in_scope: ok.answers.in_scope, category: ok.answers.category } },
    ],
    ['wrong type', { ...ok, answers: { ...ok.answers, level: { type: 'noul', noul: 0.5 } } }],
    [
      'score outside levels',
      { ...ok, answers: { ...ok.answers, level: { type: 'score', score: 3 } } },
    ],
    [
      'probabilities over other keys',
      {
        ...ok,
        answers: {
          ...ok.answers,
          category: { type: 'choice', choice: 'restaurant', probabilities: { restaurant: 1 } },
        },
      },
    ],
    ['no model', { ...ok, model: undefined }],
  ];
  for (const [name, body] of bad) {
    it(`rejects: ${name}`, () => {
      expect(() => parseDecisionResponse(request, body)).toThrow(DecisionContractError);
    });
  }

  it('an absent cost is null, not 0', () => {
    expect(parseDecisionResponse(request, { ...ok, usage: {} }).usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });
});
