import {
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type DecisionProviderPort,
} from '@gogo/providers';
import {
  buildIntentRequest,
  fallbackIntent,
  mapIntentAnswers,
  parseIntentFacts,
  type IntentClassification,
  type IntentFallbackReason,
  type IntentTaxonomy,
} from '../domain/intent';

/**
 * GoGo-BE#709 — intent classification, DEV POC. Not wired to any route: the
 * `/v1` contract is unchanged, and `pnpm eval:intent` is the only caller until
 * an endpoint is authorized.
 *
 * `mode` is the kill switch: `disabled` (default) never calls the provider and
 * returns the deterministic classification. Every provider failure — timeout,
 * open breaker, out of credits, bad key, malformed answer — returns the same
 * fallback with its reason; the caller never sees an exception from here, and
 * never waits past the adapter's timeout (≤ 15 s).
 */
export type IntentDecisionMode = 'disabled' | 'enabled';

export type IntentCallRecord = {
  outcome: 'answered' | IntentFallbackReason;
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  /** USD as reported; null = unknown, never 0. */
  costUsd: number | null;
};

export class IntentClassificationService {
  constructor(
    private readonly provider: DecisionProviderPort | null,
    private readonly mode: IntentDecisionMode,
    /** Observability hook; the eval script and tests read it. */
    private readonly onCall: (record: IntentCallRecord) => void = () => {},
  ) {}

  async classify(text: string, taxonomy: IntentTaxonomy): Promise<IntentClassification> {
    const facts = parseIntentFacts(text);
    if (text.trim().length < 2) return fallbackIntent(text, facts, taxonomy, 'empty_request');
    if (this.mode === 'disabled' || !this.provider)
      return fallbackIntent(text, facts, taxonomy, 'disabled');

    const started = Date.now();
    const request = buildIntentRequest(text, taxonomy);
    try {
      const response = await this.provider.decide(request);
      this.onCall({
        outcome: 'answered',
        model: response.model,
        latencyMs: Date.now() - started,
        inputTokens: response.usage.inputTokens,
        costUsd: response.usage.costUsd,
      });
      return mapIntentAnswers(facts, response.answers, response.model);
    } catch (err) {
      const reason = fallbackReason(err);
      this.onCall({
        outcome: reason,
        model: null,
        latencyMs: Date.now() - started,
        inputTokens: null,
        costUsd: null,
      });
      return fallbackIntent(text, facts, taxonomy, reason);
    }
  }
}

function fallbackReason(err: unknown): IntentFallbackReason {
  if (err instanceof ProviderQuotaExceededError) return 'quota';
  if (err instanceof ProviderConfigurationError) return 'provider_error';
  if (err instanceof ProviderUnavailableError) {
    const cause = err.cause as { name?: string } | undefined;
    if (cause?.name === 'DecisionContractError') return 'invalid_response';
    if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError') return 'timeout';
    return 'provider_error';
  }
  if (err instanceof Error && err.name === 'DecisionContractError') return 'invalid_response';
  return 'provider_error';
}
