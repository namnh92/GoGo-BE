import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
} from './ports';

/**
 * #273 — one reading of a Google error body, shared by all three adapters.
 *
 * Extracted from `google-sheets.adapter.ts`, where PI-BE-022 first needed it.
 * Places and Routes had the same defect and no such reading: every non-429
 * failure became a bare `Error`, `withResilience` wrapped it as an outage, and
 * a runbook told an operator to wait for an API that was never enabled.
 */

type GoogleErrorBody = {
  error?: { status?: string; details?: { '@type'?: string; reason?: string }[] };
};

/** What `readGoogleError` could recover from the body. Both may be absent. */
export type GoogleErrorInfo = {
  /** `error.details[].reason` from a `google.rpc.ErrorInfo`, e.g. SERVICE_DISABLED. */
  reason?: string | undefined;
  /** `error.status`, the canonical code, e.g. PERMISSION_DENIED, INVALID_ARGUMENT. */
  canonicalStatus?: string | undefined;
};

/**
 * Canonical statuses that mean "your request was wrong", as opposed to "we
 * could not serve it".
 *
 * Only these two, and only read from `error.status` — never inferred from HTTP
 * 400 alone. Google returns 400 for more than bad input, and a 403 carrying
 * `PERMISSION_DENIED` must stay an operational fault no matter what else the
 * body says (#314).
 *
 * Verified against the live API: an unusable place id answers
 * `400 {"error":{"status":"INVALID_ARGUMENT","message":"The provided Place ID …
 * is not valid."}}` — with no `ErrorInfo` block at all, which is why reading
 * only `details[].reason` left it classified as `unknown` and retryable.
 */
export const CLIENT_REJECT_STATUSES = new Set(['INVALID_ARGUMENT', 'NOT_FOUND']);

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
 * Read a Google error body once, and lift out both machine-readable fields.
 *
 * One read, because a `Response` body can only be consumed once and the two
 * fields answer different questions: `reason` says *what is misconfigured*,
 * `status` says *whose fault the request is*. Reading only the first is how a
 * bad place id looked identical to an outage (#314).
 *
 * Never throws: an error path that can fail to parse its own error is an error
 * path that loses the original failure. A body that is empty, truncated, or not
 * JSON simply yields nothing, and the caller falls back to the HTTP status.
 *
 * Only these two fields are lifted out. The rest of the body carries the
 * project number, an activation URL and the offending input echoed back, which
 * belong in an operator's console and not in anything a caller can read.
 */
export async function readGoogleError(res: Response): Promise<GoogleErrorInfo> {
  try {
    const body = (await res.json()) as GoogleErrorBody;
    const info = body.error?.details?.find((d) => d['@type']?.endsWith('google.rpc.ErrorInfo'));
    return {
      reason: typeof info?.reason === 'string' ? info.reason : undefined,
      canonicalStatus: typeof body.error?.status === 'string' ? body.error.status : undefined,
    };
  } catch {
    return {};
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
  info: GoogleErrorInfo,
):
  | ProviderConfigurationError
  | ProviderQuotaExceededError
  | ProviderInvalidRequestError
  | undefined {
  if (isMisconfiguredReason(info.reason)) {
    return new ProviderConfigurationError(provider, 'AUTH_FAILED', info.reason);
  }
  if (status === 429) return new ProviderQuotaExceededError(provider);
  if (status === 401 || status === 403) {
    return new ProviderConfigurationError(provider, 'AUTH_FAILED', info.reason);
  }
  // Last, deliberately: every operational verdict above wins. A body may carry
  // both a canonical status and a reason, and "our key is refused" outranks
  // "this argument is wrong" — the argument is not what needs fixing (#314).
  if (info.canonicalStatus && CLIENT_REJECT_STATUSES.has(info.canonicalStatus)) {
    return new ProviderInvalidRequestError(provider, info.canonicalStatus);
  }
  return undefined;
}
