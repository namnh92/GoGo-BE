import { describe, expect, it } from 'vitest';
import { AssistantLlmError, type AssistantLlmEvent } from './assistant-llm.port';
import {
  OpenRouterAssistantLlmAdapter,
  buildChatBody,
  servedModelMatches,
} from './openrouter-assistant-llm.adapter';

/**
 * Transport and parsing only: the bytes below are a fixed SSE body in
 * OpenRouter's documented shape (field names as observed on the live call of
 * 2026-10-27), fed through `fetchImpl`. This is not a stand-in for inference —
 * live Haiku is exercised by the gated live suite and the E2E script.
 */
function sseResponse(lines: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      // Split mid-line to prove the parser buffers across chunks.
      const text = lines.join('\n') + '\n';
      controller.enqueue(enc.encode(text.slice(0, 37)));
      controller.enqueue(enc.encode(text.slice(37)));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}`;
const signal = () => new AbortController().signal;

async function collect(
  adapter: OpenRouterAssistantLlmAdapter,
  s = signal(),
): Promise<AssistantLlmEvent[]> {
  const out: AssistantLlmEvent[] = [];
  for await (const e of adapter.stream({
    messages: [{ role: 'user', content: 'x' }],
    maxOutputTokens: 50,
    signal: s,
  })) {
    out.push(e);
  }
  return out;
}

describe('OpenRouterAssistantLlmAdapter', () => {
  it('pins Anthropic as the only provider, disables reasoning and asks for usage', () => {
    const body = buildChatBody('anthropic/claude-haiku-5.5', {
      messages: [],
      maxOutputTokens: 600,
      signal: signal(),
    });
    expect(body).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      stream: true,
      max_tokens: 600,
      usage: { include: true },
      provider: { only: ['anthropic'], allow_fallbacks: false },
      reasoning: { enabled: false },
    });
  });

  it('refuses aliases, variants and non-Anthropic models (the BYOK route is Anthropic)', () => {
    expect(
      () =>
        new OpenRouterAssistantLlmAdapter({ apiKey: 'k', model: '~anthropic/claude-haiku-latest' }),
    ).toThrow();
    expect(
      () =>
        new OpenRouterAssistantLlmAdapter({
          apiKey: 'k',
          model: 'anthropic/claude-haiku-5.5:floor',
        }),
    ).toThrow();
    expect(
      () => new OpenRouterAssistantLlmAdapter({ apiKey: 'k', model: 'openai/gpt-5' }),
    ).toThrow();
  });

  it('streams deltas, then usage with BYOK provenance, then done', async () => {
    let sent: RequestInit | undefined;
    const adapter = new OpenRouterAssistantLlmAdapter({
      apiKey: 'test-key',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = init;
        return sseResponse([
          ': OPENROUTER PROCESSING',
          chunk({
            id: 'gen-1',
            provider: 'Anthropic',
            model: 'anthropic/claude-haiku-5.5',
            choices: [{ delta: { content: 'Xin ' } }],
          }),
          '',
          chunk({
            id: 'gen-1',
            model: 'anthropic/claude-haiku-5.5',
            choices: [{ delta: { content: 'chào' }, finish_reason: 'stop' }],
          }),
          chunk({
            id: 'gen-1',
            provider: 'Anthropic',
            model: 'anthropic/claude-haiku-5.5',
            choices: [],
            usage: {
              prompt_tokens: 55,
              completion_tokens: 29,
              cost: 0,
              is_byok: true,
              cost_details: { upstream_inference_cost: 0.00002 },
            },
          }),
          'data: [DONE]',
        ]);
      }) as unknown as typeof fetch,
    });
    const events = await collect(adapter);
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Xin chào');
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        model: 'anthropic/claude-haiku-5.5',
        provider: 'Anthropic',
        generationId: 'gen-1',
        inputTokens: 55,
        outputTokens: 29,
        openRouterCostUsd: 0,
        upstreamCostUsd: 0.00002,
        isByok: true,
        billingSource: 'anthropic_byok',
      },
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'stop' });
    // The credential goes in the header only.
    expect(new Headers(sent!.headers).get('authorization')).toBe('Bearer test-key');
    expect(String(sent!.body)).not.toContain('test-key');
  });

  it('reports a shared-capacity answer as openrouter_credits, never as BYOK', async () => {
    const adapter = new OpenRouterAssistantLlmAdapter({
      apiKey: 'k',
      fetchImpl: (async () =>
        sseResponse([
          chunk({
            id: 'g',
            model: 'anthropic/claude-haiku-5.5',
            choices: [{ delta: { content: 'a ' }, finish_reason: 'length' }],
          }),
          chunk({
            id: 'g',
            model: 'anthropic/claude-haiku-5.5',
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01, is_byok: false },
          }),
        ])) as unknown as typeof fetch,
    });
    const events = await collect(adapter);
    const usage = events.find((e) => e.type === 'usage') as { usage: { billingSource: string } };
    expect(usage.usage.billingSource).toBe('openrouter_credits');
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'length' });
  });

  it('refuses a silently substituted model', async () => {
    const adapter = new OpenRouterAssistantLlmAdapter({
      apiKey: 'k',
      fetchImpl: (async () =>
        sseResponse([
          chunk({ model: 'anthropic/claude-sonnet-5', choices: [{ delta: { content: 'x' } }] }),
        ])) as unknown as typeof fetch,
    });
    await expect(collect(adapter)).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('maps HTTP failures to typed kinds without reading the body into the error', async () => {
    const cases: [number, string][] = [
      [401, 'configuration'],
      [402, 'quota'],
      [404, 'unavailable'],
      [429, 'rate_limited'],
      [503, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const adapter = new OpenRouterAssistantLlmAdapter({
        apiKey: 'k',
        fetchImpl: (async () =>
          new Response('{"error":{"message":"secret-ish upstream text"}}', {
            status,
          })) as unknown as typeof fetch,
      });
      const err = (await collect(adapter).catch((e: unknown) => e)) as AssistantLlmError;
      expect(err).toBeInstanceOf(AssistantLlmError);
      expect(err.kind).toBe(kind);
      expect(err.message).not.toContain('secret-ish');
    }
  });

  it('a mid-stream error object ends the stream as a typed failure', async () => {
    const adapter = new OpenRouterAssistantLlmAdapter({
      apiKey: 'k',
      fetchImpl: (async () =>
        sseResponse([
          chunk({ model: 'anthropic/claude-haiku-5.5', choices: [{ delta: { content: 'x ' } }] }),
          chunk({ error: { code: 502, message: 'upstream' } }),
        ])) as unknown as typeof fetch,
    });
    await expect(collect(adapter)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('an abort before or during the stream is `aborted`', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new OpenRouterAssistantLlmAdapter({
      apiKey: 'k',
      fetchImpl: (async () => sseResponse([])) as unknown as typeof fetch,
    });
    await expect(collect(adapter, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('no key is a configuration failure, before any request', async () => {
    let called = false;
    const adapter = new OpenRouterAssistantLlmAdapter({
      apiKey: '',
      fetchImpl: (async () => {
        called = true;
        return sseResponse([]);
      }) as unknown as typeof fetch,
    });
    await expect(collect(adapter)).rejects.toMatchObject({ kind: 'configuration' });
    expect(called).toBe(false);
  });

  it('a dated permaslug of the pinned model is the pinned model', () => {
    expect(
      servedModelMatches('anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5-20261007'),
    ).toBe(true);
    expect(servedModelMatches('anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.6')).toBe(
      false,
    );
  });
});
