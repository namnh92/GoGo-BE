import { ProviderConfigurationError, ProviderQuotaExceededError } from './ports';

/**
 * #273 — one reading of a Google error body, shared by all three adapters.
 *
 * Extracted from `google-sheets.adapter.ts`, where PI-BE-022 first needed it.
 * Places and Routes had the same defect and no such reading: every non-429
 * failure became a bare `Error`, `withResilience` wrapped it as an outage, and
 * a runbook told an operator to wait for an API that was never enabled.
 */

type GoogleErrorBody = {
  error?: { details?: { '@type'?: string; reason?: string }[] };
};

/**
 * Reasons that describe GoGo's own Google setup rather than the caller's
 * request. Every one of them is fixed in a console we own, by an operator, and
 * by nobody else; none of them clears by waiting or by the caller retrying.
 *
 * Verified against the live DEV response: an API that was never enabled on the
 * project answers 403 with `status: PERMISSION_DENIED` and
 * `reason: SERVICE_DISABLED` — indistinguishable from a genuine permission
 * failure if you only read the status, which is exactly how this shipped.
 */
export const PROVIDER_MISCONFIGURED_REASONS = new Set([
  'SERVICE_DISABLED',
  'API_KEY_SERVICE_BLOCKED',
  'API_KEY_INVALID',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
]);

export function isMisconfiguredReason(reason: string | undefined): boolean {
  return reason !== undefined && PROVIDER_MISCONFIGURED_REASONS.has(reason);
}

/**
 * The machine-readable reason from a Google error body, or undefined.
 *
 * Never throws: an error path that can fail to parse its own error is an error
 * path that loses the original failure. A body that is empty, truncated, or not
 * JSON simply yields no reason, and the caller falls back to the status.
 *
 * Only the reason is lifted out. The rest of the body carries the project
 * number and an activation URL, which belong in an operator's console and not
 * in anything a caller can read.
 */
export async function errorReason(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as GoogleErrorBody;
    const info = body.error?.details?.find((d) => d['@type']?.endsWith('google.rpc.ErrorInfo'));
    return typeof info?.reason === 'string' ? info.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a non-OK Google response into the error that says whose fault it is.
 *
 * Returns `undefined` when the status carries no verdict of its own — the
 * caller then throws whatever its own domain calls a transient failure, and
 * `withResilience` retries it.
 *
 * The reason is read *before* the status, because the status alone does not
 * separate "we never enabled this API" from "this caller may not have this".
 * 401 and 403 with no reason still land here rather than in the retry loop:
 * a credential Google refuses is not a fault that clears on the next attempt.
 */
export function googleFailure(
  provider: string,
  status: number,
  reason: string | undefined,
): ProviderConfigurationError | ProviderQuotaExceededError | undefined {
  if (isMisconfiguredReason(reason)) {
    return new ProviderConfigurationError(provider, 'AUTH_FAILED', reason);
  }
  if (status === 429) return new ProviderQuotaExceededError(provider);
  if (status === 401 || status === 403) {
    return new ProviderConfigurationError(provider, 'AUTH_FAILED', reason);
  }
  return undefined;
}
