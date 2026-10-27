/**
 * AI-BE-001: the assistant's streaming text port.
 * There is deliberately no fake runtime binding. Consumers persist/replay
 * frames; the provider only produces real upstream text and usage.
 */
export const ASSISTANT_LLM = Symbol('ASSISTANT_LLM');
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

export type AssistantLlmUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * BYOK costs are billed by Anthropic. OpenRouter's streamed usage may report
   * zero or list-price amounts: neither is an Anthropic invoice.
   */
  openRouterReportedCostUsd: number | null;
  billingSource: 'anthropic_byok';
};

export type AssistantLlmEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: AssistantLlmUsage };

export interface AssistantLlmPort {
  stream(request: AssistantLlmRequest): AsyncIterable<AssistantLlmEvent>;
}
