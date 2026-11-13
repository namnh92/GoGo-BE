import { describe, expect, it, vi } from 'vitest';
import { OpenRouterDecisionProvider, serializeDecisionBody } from './openrouter-decisions.adapter';
import {
  boundedJsonText,
  codepointSlice,
  MAX_JEV_DECISION_BYTES,
  utf8Bytes,
} from './request-bytes';

it('JSON byte truncation handles escapes and emoji without splitting a codepoint', () => {
  const text = '😀\u0000"\\\nTiếng Việt';
  for (let cap = 2; cap < 100; cap++) {
    const kept = boundedJsonText(text, cap);
    expect(utf8Bytes(JSON.stringify(kept))).toBeLessThanOrEqual(cap);
    expect(text.startsWith(kept)).toBe(true);
    expect(JSON.stringify(kept)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  }
  expect(codepointSlice('a😀b', 2)).toBe('a');
  expect(codepointSlice('a😀b', 3)).toBe('a😀');
});

describe('exact serialized Jev boundary', () => {
  it.each([false, true])('cap cannot be enlarged by caller (enlarge=%s)', async (enlarge) => {
    const model = 'typesafe/jev-1.14';
    const base = { state: '', questions: {} };
    const overhead = utf8Bytes(serializeDecisionBody(model, base));
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) => new Response('{}', { status: 400 }),
    );
    const provider = new OpenRouterDecisionProvider({
      apiKey: 'contract-only',
      model,
      timeoutMs: 1000,
      fetchImpl,
    });
    const options = enlarge ? { maxInputBytes: MAX_JEV_DECISION_BYTES * 2 } : {};
    await expect(
      provider.decide({ ...base, state: 'x'.repeat(MAX_JEV_DECISION_BYTES - overhead) }, options),
    ).rejects.toThrow('HTTP_400');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(utf8Bytes(String(fetchImpl.mock.calls[0]?.[1]?.body))).toBe(MAX_JEV_DECISION_BYTES);
    fetchImpl.mockClear();
    await expect(
      provider.decide(
        { ...base, state: 'x'.repeat(MAX_JEV_DECISION_BYTES - overhead + 1) },
        options,
      ),
    ).rejects.toThrow('REQUEST_BYTES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a relevance caller tightens the actual body envelope', async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) => new Response('{}', { status: 400 }),
    );
    const provider = new OpenRouterDecisionProvider({
      apiKey: 'contract-only',
      model: 'typesafe/jev-1.14',
      timeoutMs: 1000,
      fetchImpl,
    });
    await expect(
      provider.decide({ state: 'x'.repeat(17_000), questions: {} }, { maxInputBytes: 16_384 }),
    ).rejects.toThrow('REQUEST_BYTES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
