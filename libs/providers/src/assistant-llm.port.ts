/**
 * AI-BE-001 (ADR-0036): the assistant's streaming text port.
 * There is deliberately no fake runtime binding. Consumers persist/replay
 * frames; the provider only produces real upstream text and usage.
 */
export const ASSISTANT_LLM = Symbol('ASSISTANT_LLM');
/** Owner decision 2026-10-27 (ADR-0036): Haiku, never an alias, no Sonnet fallback. */
export const HAIKU_MODEL = 'anthropic/claude-haiku-5.5' as const;

export type AssistantLlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AssistantLlmRequest = {
  messages: readonly AssistantLlmMessage[];
  maxOutputTokens: number;
  /** Orchestrator owns the end-to-end <=15s time-to-first-text deadline. */
  signal: AbortSignal;
};

export type AssistantLlmBillingSource =
  /** OpenRouter routed through GoGo's own Anthropic key: Anthropic bills it. */
  | 'anthropic_byok'
  /** OpenRouter answered from its shared capacity: OpenRouter credits paid. */
  | 'openrouter_credits'
  /** The stream ended without a usage record. */
  | 'unknown';

export type AssistantLlmUsage = {
  /** The model OpenRouter reports having served. */
  model: string | null;
  /** The upstream provider OpenRouter reports (`Anthropic`). */
  provider: string | null;
  generationId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * What OpenRouter itself charged (`usage.cost`). For a BYOK call this is the
   * BYOK platform fee — 0 inside the monthly allowance — never the inference.
   */
  openRouterCostUsd: number | null;
  /** `usage.cost_details.upstream_inference_cost`: the provider's charge (Anthropic's bill for BYOK). */
  upstreamCostUsd: number | null;
  /** `usage.is_byok` as reported; `null` when the field was absent. */
  isByok: boolean | null;
  billingSource: AssistantLlmBillingSource;
};

export type AssistantLlmEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: AssistantLlmUsage }
  /** `length` = the output cap was hit (the reply is truncated). */
  | { type: 'done'; finishReason: 'stop' | 'length' | 'other' };

export type AssistantLlmErrorKind =
  | 'aborted'
  | 'timeout'
  | 'rate_limited'
  | 'quota'
  | 'configuration'
  | 'unavailable'
  | 'invalid_output';

/** Typed failure of one composition call; no message text or credential in it. */
export class AssistantLlmError extends Error {
  constructor(
    readonly kind: AssistantLlmErrorKind,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`assistant llm ${kind}: ${detail}`, options);
    this.name = 'AssistantLlmError';
  }
}

export interface AssistantLlmPort {
  /** The pinned model id the adapter requests (for traces and Cost Center). */
  readonly model: string;
  stream(request: AssistantLlmRequest): AsyncIterable<AssistantLlmEvent>;
}
