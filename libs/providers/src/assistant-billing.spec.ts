import { describe, it, expect, vi } from 'vitest';
import {
  parseBillingJson,
  decimal,
  openRouterReceipt,
  OpenRouterAssistantReceiptReader,
  type AssistantBillingObserver,
} from './assistant-billing';
import { OpenRouterDecisionProvider } from './openrouter-decisions.adapter';
import { OpenRouterAssistantLlmAdapter } from './openrouter-assistant-llm.adapter';

function observer() {
  const generation = vi.fn(async () => undefined),
    receipt = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ requestId: 'correlation-only', generation, receipt }));
  return { billing: { start } as AssistantBillingObserver, start, generation, receipt };
}
describe('#853 D08 exact allowlisted provider evidence', () => {
  it('preserves JSON decimal lexemes beyond IEEE precision, including exponents', () => {
    expect(parseBillingJson('{"usage":{"cost":0.000009999999999999999999,"other":12}}')).toEqual({
      usage: { cost: '0.000009999999999999999999', other: 12 },
    });
    expect(decimal('1.234e-8')).toBe('0.00000001234');
    expect(decimal('-1')).toBeNull();
    expect(decimal(0.1)).toBeNull();
  });
  it('BYOK = upstream + fee; shared capacity counts direct once', () => {
    expect(
      openRouterReceipt(
        'haiku',
        { cost: '0.000004', is_byok: true, cost_details: { upstream_inference_cost: '0.000004' } },
        1n,
      ),
    ).toMatchObject({ direct: '0', upstream: '0.000004', fee: '0.000004', final: false });
    expect(
      openRouterReceipt(
        'haiku',
        { cost: '0.000008', is_byok: false, cost_details: { upstream_inference_cost: '0.000007' } },
        1n,
      ),
    ).toMatchObject({ direct: '0.000008', upstream: '0', fee: '0' });
    expect(openRouterReceipt('haiku', { cost: '0', is_byok: true }, 1n)).toBeNull();
    expect(openRouterReceipt('jev', { cost: null }, 1n)).toBeNull();
    expect(
      openRouterReceipt(
        'haiku',
        { cost: '0', is_byok: true, cost_details: { upstream_inference_cost: null } },
        1n,
      ),
    ).toBeNull();
    expect(
      openRouterReceipt(
        'jev',
        parseBillingJson('{"cost":-0.00001}') as Record<string, unknown>,
        1n,
      ),
    ).toMatchObject({ direct: 'invalid' });
    expect(openRouterReceipt('jev', { cost: '-1' }, 1n)).toMatchObject({ direct: 'invalid' });
  });
  it('commits Jev intent before dispatch and captures costs even if answers fail validation', async () => {
    const o = observer();
    const fetchImpl = vi.fn(async () => {
      expect(o.start).toHaveBeenCalledOnce();
      return new Response(
        '{"id":"gen-jev","model":"typesafe/jev-1.14","usage":{"cost":0.0000000000000000001},"answers":{}}',
      );
    });
    const adapter = new OpenRouterDecisionProvider({
      apiKey: 'fixture',
      model: 'typesafe/jev-1.14',
      timeoutMs: 1000,
      fetchImpl,
    });
    await expect(
      adapter.decide(
        { state: 's', questions: { q: { type: 'noul', instructions: 'q' } } },
        { billing: o.billing },
      ),
    ).rejects.toThrow();
    expect(o.generation).toHaveBeenCalledWith('gen-jev');
    expect(o.receipt).toHaveBeenCalledWith(
      expect.objectContaining({ direct: '0.0000000000000000001' }),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('a failed durable intent prevents provider dispatch', async () => {
    const o = observer();
    o.start.mockRejectedValue(new Error('db unavailable'));
    const fetchImpl = vi.fn();
    const adapter = new OpenRouterAssistantLlmAdapter({ apiKey: 'fixture', fetchImpl });
    await expect(
      (async () => {
        for await (const _ of adapter.stream({
          messages: [],
          maxOutputTokens: 1,
          signal: new AbortController().signal,
          billing: o.billing,
        })) {
          /* consume */
        }
      })(),
    ).rejects.toThrow('db unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('persists Haiku generation before a subsequent interrupted stream', async () => {
    const o = observer();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          'data: {"id":"gen-haiku","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"error":{"code":502}}\n\n',
        ),
    );
    const adapter = new OpenRouterAssistantLlmAdapter({ apiKey: 'fixture', fetchImpl });
    await expect(
      (async () => {
        for await (const _ of adapter.stream({
          messages: [],
          maxOutputTokens: 1,
          signal: new AbortController().signal,
          billing: o.billing,
        })) {
          /* consume */
        }
      })(),
    ).rejects.toThrow();
    expect(o.generation).toHaveBeenCalledWith('gen-haiku');
    expect(o.receipt).not.toHaveBeenCalled();
  });
  it('retrieval only uses GET generation, preserves precision and never asserts finality', async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, _options: unknown) =>
        new Response(
          '{"data":{"id":"gen-recover","total_cost":0.00000000000000001,"is_byok":true,"upstream_inference_cost":0.000004}}',
        ),
    );
    const reader = new OpenRouterAssistantReceiptReader(
      { jev: 'fixture', haiku: 'fixture' },
      fetchImpl,
    );
    expect(await reader.read('haiku', 'gen-recover', new AbortController().signal)).toMatchObject({
      revision: 2n,
      fee: '0.00000000000000001',
      upstream: '0.000004',
      final: false,
    });
    expect(fetchImpl.mock.calls[0]?.length).toBe(2);
  });
});
