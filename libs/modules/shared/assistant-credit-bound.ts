import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { CreditExec } from './credit-catalogue';
import type { AssistantConfig } from '../assistant/application/assistant.config';
import { MAX_REQUEST_CHARS } from '../search/domain/intent';
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  MAX_CONTEXT_NAME_CHARS,
  MAX_GUIDE_EXCERPT_CHARS,
} from '../assistant/domain/grounding';
import {
  MAX_LATEST_MESSAGE_CHARS,
  MAX_PENDING_QUESTION_CHARS,
  MAX_PREVIOUS_REQUEST_CHARS,
} from '../assistant/domain/decision';

/** Bump whenever call topology, request construction, routing, retry or caps change.
 * This fingerprint describes configuration; it is not itself a billing proof. */
export const BILLING_CONFIG_REVISION = 'assistant-D2-single-attempt-v1';
export function billingConfiguration(config: AssistantConfig) {
  return {
    revision: BILLING_CONFIG_REVISION,
    provider: 'openrouter',
    jevModel: config.ASSISTANT_JEV_MODEL,
    haikuModel: config.ASSISTANT_HAIKU_MODEL,
    pricingRevision: config.ASSISTANT_CREDIT_PRICING_REVISION,
    maxOutputTokens: config.ASSISTANT_MAX_OUTPUT_TOKENS,
    jevTimeoutMs: config.ASSISTANT_JEV_TIMEOUT_MS,
    replyMaxMs: config.ASSISTANT_REPLY_MAX_MS,
    firstTextTimeoutMs: config.ASSISTANT_FIRST_TEXT_TIMEOUT_MS,
    retries: 0,
    maxRequestChars: MAX_REQUEST_CHARS,
    maxHistoryChars: MAX_HISTORY_CHARS,
    maxHistoryTurns: MAX_HISTORY_TURNS,
    maxMessageChars: MAX_MESSAGE_CHARS,
    maxContextNameChars: MAX_CONTEXT_NAME_CHARS,
    maxGuideExcerptChars: MAX_GUIDE_EXCERPT_CHARS,
    maxLatestMessageChars: MAX_LATEST_MESSAGE_CHARS,
    maxPendingQuestionChars: MAX_PENDING_QUESTION_CHARS,
    maxPreviousRequestChars: MAX_PREVIOUS_REQUEST_CHARS,
  };
}
export function billingConfigurationHash(config: AssistantConfig) {
  return createHash('sha256')
    .update(JSON.stringify(billingConfiguration(config)))
    .digest('hex');
}
export type BoundDescription = {
  schemaVersion: 1;
  configurationHash: string;
  configuration: ReturnType<typeof billingConfiguration>;
  pricingRevision: string;
  /** Immutable evidence digests, not paths, URLs, or a calibrated numeric ceiling. */
  boundProofSha256: string;
  finalityProofSha256: string;
  coverage: {
    allAttempts: true;
    retries: true;
    parallelCalls: true;
    timeoutAbortBillability: true;
    maximumFees: true;
  };
};
export function validBoundDescription(value: unknown, config: AssistantConfig): boolean {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<BoundDescription>;
  return (
    d.schemaVersion === 1 &&
    d.configurationHash === billingConfigurationHash(config) &&
    !!d.configuration &&
    typeof d.configuration === 'object' &&
    Object.entries(billingConfiguration(config)).every(
      ([key, value]) => (d.configuration as Record<string, unknown>)[key] === value,
    ) &&
    !!config.ASSISTANT_CREDIT_PRICING_REVISION &&
    d.pricingRevision === config.ASSISTANT_CREDIT_PRICING_REVISION &&
    /^[a-f0-9]{64}$/.test(d.boundProofSha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(d.finalityProofSha256 ?? '') &&
    ['allAttempts', 'retries', 'parallelCalls', 'timeoutAbortBillability', 'maximumFees'].every(
      (k) => (d.coverage as Record<string, unknown> | undefined)?.[k] === true,
    )
  );
}
/** No artifact is shipped/certified by D2. A number or calibration cannot pass. */
export async function verifiedCreditBound(
  exec: CreditExec,
  config: AssistantConfig,
): Promise<boolean> {
  if (
    !config.ASSISTANT_CREDIT_BOUND_USD ||
    !config.ASSISTANT_CREDIT_BOUND_VERSION ||
    !config.ASSISTANT_CREDIT_PRICING_REVISION
  )
    return false;
  const r = await exec.execute(sql`select description from assistant_credit_bound_artifacts
    where version=${config.ASSISTANT_CREDIT_BOUND_VERSION} and environment=${config.APP_ENV === 'prod' ? 'production' : config.APP_ENV}
    and bound_usd=${config.ASSISTANT_CREDIT_BOUND_USD}::numeric and revoked_at is null
    and validated_at<=now() and expires_at>now()`);
  return (
    r.rows.length === 1 &&
    validBoundDescription((r.rows[0] as { description: unknown }).description, config)
  );
}
