import {
  AssistantLlmError,
  HAIKU_MODEL,
  type AssistantLlmEvent,
  type AssistantLlmPort,
  type AssistantLlmRequest,
  type AssistantLlmUsage,
} from './assistant-llm.port';

/**
 * ADR-0036 §3F — Claude Haiku through OpenRouter Chat Completions, streaming.
 *
 * Authenticated with the assistant's OpenRouter key (`OPENROUTER_ASSISTANT_API_KEY`),
 * never with an Anthropic key. Billing is decided upstream by OpenRouter: the
 * request pins the Anthropic provider (`provider.only`, `allow_fallbacks:
 * false`), so OpenRouter cannot route the call to Vertex, Bedrock or Azure,
 * and the workspace's Anthropic BYOK integration serves it. Whether it
 * actually did is reported per call (`usage.is_byok`) and surfaced as
 * `billingSource` — a 200 is not proof of BYOK (ADR-0036 §5). Verified live on
 * 2026-10-27: `is_byok: true`, provider `Anthropic`, OpenRouter `cost: 0`,
 * `upstream_inference_cost` = Anthropic's charge, `reasoning: {enabled: false}`
 * accepted (0 reasoning tokens).
 *
 * No retry, ever: a second billable attempt is the orchestrator's decision,
 * and its decision is "deterministic fallback" (ADR-0036 §3G).
 */
export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type OpenRouterAssistantLlmOptions = {
  apiKey: string;
  /** Pinned id; `~` aliases and unqualified names are refused. */
  model?: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
};

export class OpenRouterAssistantLlmAdapter implements AssistantLlmPort {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterAssistantLlmOptions) {
    const model = options.model ?? HAIKU_MODEL;
    if (model.startsWith('~') || !model.includes('/') || model.includes(':')) {
      throw new Error('assistant model must be a pinned versioned id, never an alias or variant');
    }
    if (!model.startsWith('anthropic/')) {
      // The BYOK route below is Anthropic's; another vendor would silently
      // move the bill to OpenRouter credits.
      throw new Error('assistant model must be an anthropic/* model (ADR-0036 BYOK route)');
    }
    this.model = model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(request: AssistantLlmRequest): AsyncIterable<AssistantLlmEvent> {
    if (!this.options.apiKey) {
      throw new AssistantLlmError('configuration', 'MISSING_CREDENTIAL');
    }
    if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
      throw new AssistantLlmError('configuration', 'INVALID_OUTPUT_CAP');
    }
    if (request.signal.aborted) throw new AssistantLlmError('aborted', 'before request');

    let res: Response;
    try {
      res = await this.fetchImpl(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildChatBody(this.model, request, this.options.temperature)),
        signal: request.signal,
      });
    } catch (err) {
      throw abortedOr(request.signal, err, 'request failed');
    }

    if (!res.ok) {
      // The body is OpenRouter's error envelope; it is not read into the error
      // text so nothing upstream-provided reaches a log line.
      await res.body?.cancel().catch(() => undefined);
      throw httpError(res.status);
    }
    if (!res.body) throw new AssistantLlmError('invalid_output', 'empty body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const state: StreamState = { buffer: '', usage: null, finish: null, model: null };
    const onAbort = () => void reader.cancel().catch(() => undefined);
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw abortedOr(request.signal, err, 'stream read failed');
        }
        if (request.signal.aborted) throw new AssistantLlmError('aborted', 'during stream');
        if (chunk.done) break;
        state.buffer += decoder.decode(chunk.value, { stream: true });
        for (const event of drainLines(state, this.model)) yield event;
      }
      state.buffer += decoder.decode();
      state.buffer += '\n';
      for (const event of drainLines(state, this.model)) yield event;
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    yield {
      type: 'usage',
      usage: state.usage ?? {
        model: state.model,
        provider: null,
        generationId: null,
        inputTokens: null,
        outputTokens: null,
        openRouterCostUsd: null,
        upstreamCostUsd: null,
        isByok: null,
        billingSource: 'unknown',
      },
    };
    yield { type: 'done', finishReason: state.finish ?? 'other' };
  }
}

export function buildChatBody(
  model: string,
  request: AssistantLlmRequest,
  temperature = 0.3,
): Record<string, unknown> {
  return {
    model,
    messages: request.messages,
    stream: true,
    max_tokens: request.maxOutputTokens,
    temperature,
    // Final chunk carries tokens, cost and `is_byok`.
    usage: { include: true },
    // Anthropic only, never another host of the same weights: Vertex, Bedrock
    // and Azure serve this model too, and any of them is OpenRouter-credit
    // billing rather than GoGo's Anthropic BYOK key.
    provider: { only: ['anthropic'], allow_fallbacks: false },
    // Composition needs no extended thinking; reasoning tokens are output
    // tokens and the first visible text waits for them.
    reasoning: { enabled: false },
  };
}

type StreamState = {
  buffer: string;
  usage: AssistantLlmUsage | null;
  finish: 'stop' | 'length' | 'other' | null;
  model: string | null;
};

/** Consumes complete SSE lines from the buffer. */
function* drainLines(state: StreamState, requestedModel: string): Generator<AssistantLlmEvent> {
  let newline: number;
  while ((newline = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, newline).replace(/\r$/, '');
    state.buffer = state.buffer.slice(newline + 1);
    // Blank lines separate events; `:` lines are OpenRouter keep-alives.
    if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      throw new AssistantLlmError('invalid_output', 'unparseable stream chunk', { cause: err });
    }
    if (isRecord(event.error)) {
      // A mid-stream error: the HTTP status was already 200.
      const code = Number(event.error.code);
      throw code === 402
        ? new AssistantLlmError('quota', 'mid-stream 402')
        : httpError(code || 502);
    }
    if (typeof event.model === 'string') {
      // A silently substituted model is refused, not composed with.
      if (!servedModelMatches(requestedModel, event.model)) {
        throw new AssistantLlmError('invalid_output', 'served model differs from the pinned model');
      }
      state.model = event.model;
    }
    const choice = Array.isArray(event.choices)
      ? (event.choices[0] as Record<string, unknown> | undefined)
      : undefined;
    const delta = isRecord(choice?.delta) ? choice.delta : undefined;
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      yield { type: 'delta', text: delta.content };
    }
    if (typeof choice?.finish_reason === 'string') {
      state.finish =
        choice.finish_reason === 'stop'
          ? 'stop'
          : choice.finish_reason === 'length'
            ? 'length'
            : 'other';
    }
    if (isRecord(event.usage)) state.usage = parseUsage(event, state.model);
  }
}

/** `anthropic/claude-haiku-5.5` serves as itself or a dated permaslug of itself. */
export function servedModelMatches(requested: string, served: string): boolean {
  return served === requested || served.startsWith(`${requested}-`);
}

export function parseUsage(
  event: Record<string, unknown>,
  model: string | null,
): AssistantLlmUsage {
  const usage = event.usage as Record<string, unknown>;
  const details = isRecord(usage.cost_details) ? usage.cost_details : {};
  const isByok = typeof usage.is_byok === 'boolean' ? usage.is_byok : null;
  return {
    model,
    provider: typeof event.provider === 'string' ? event.provider : null,
    generationId: typeof event.id === 'string' ? event.id : null,
    inputTokens: nonNegative(usage.prompt_tokens),
    outputTokens: nonNegative(usage.completion_tokens),
    openRouterCostUsd: nonNegative(usage.cost),
    upstreamCostUsd: nonNegative(details.upstream_inference_cost),
    isByok,
    billingSource:
      isByok === true ? 'anthropic_byok' : isByok === false ? 'openrouter_credits' : 'unknown',
  };
}

function httpError(status: number): AssistantLlmError {
  if (status === 401 || status === 403)
    return new AssistantLlmError('configuration', `HTTP ${status}`);
  if (status === 402) return new AssistantLlmError('quota', 'HTTP 402');
  if (status === 408) return new AssistantLlmError('timeout', 'HTTP 408');
  if (status === 429) return new AssistantLlmError('rate_limited', 'HTTP 429');
  // 404 here is "no allowed provider can serve this request" — with the
  // Anthropic-only route that means BYOK/Anthropic is unavailable, and the
  // answer is a fallback, not another provider.
  return new AssistantLlmError('unavailable', `HTTP ${status}`);
}

function abortedOr(signal: AbortSignal, err: unknown, detail: string): AssistantLlmError {
  if (signal.aborted) return new AssistantLlmError('aborted', detail, { cause: err });
  return new AssistantLlmError('unavailable', detail, { cause: err });
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
