import { withResilience } from './resilience';
import { GeoProviderError, ProviderUnavailableError } from './ports';

/**
 * GEO-002 — the one way this process talks to VIETMAP v4.
 *
 * Spec §17 writes the retry policy out in full — which statuses may be asked
 * again, how many times, and that `Retry-After` wins over our own backoff — so
 * that policy lives here rather than in `withResilience`, which retries every
 * failure alike. The shared helper still supplies the two things worth having
 * exactly once in a codebase: the per-attempt timeout and the circuit breaker.
 *
 * So each attempt is a `withResilience` call with `retries: 0`, and the loop
 * around it decides whether there is a next attempt.
 */

export const VIETMAP_BASE_URL = 'https://maps.vietmap.vn/api';

/** Spec §17. Two attempts total, not two retries on top of the first. */
export const VIETMAP_MAX_ATTEMPTS = 2;
export const VIETMAP_DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Cap on how long a provider may tell us to wait.
 *
 * `Retry-After: 3600` is a legitimate answer to a spent quota, and honouring it
 * literally would park a request thread for an hour. Past the cap the wait is
 * not worth having: fail, let the caller fall back, and let the breaker do the
 * waiting.
 */
export const VIETMAP_MAX_RETRY_AFTER_MS = 5_000;

export type VietmapClientConfig = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
};

export type VietmapQuery = Record<string, string | number | undefined>;

/**
 * VIETMAP authenticates with `apikey` **in the query string**, unlike every
 * Google adapter here, which uses a header. That single difference is the
 * likeliest way this POC leaks a credential: any log line, error message or
 * metric label built from a request URL carries the key with it.
 *
 * Everything that could reach a log goes through this first. Exported because
 * the guarantee is worth testing directly.
 */
export function redactVietmapUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has('apikey')) u.searchParams.set('apikey', 'REDACTED');
    return u.toString();
  } catch {
    // Not a URL we can parse is not a URL we can promise to have cleaned.
    return '[unparseable url]';
  }
}

/** Jitter matching `resilience.ts`, so two retry paths do not drift apart. */
function jitteredBackoff(attempt: number): number {
  return Math.min(1000, 100 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `Retry-After` is seconds or an HTTP date (RFC 9110 §10.2.3). Anything else,
 * including a negative or absurd value, is treated as absent — a provider that
 * cannot say when to come back has not said when to come back.
 */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1_000;
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const ms = at - now;
  return ms > 0 ? ms : 0;
}

/**
 * Whatever `withResilience` threw, said as a `GeoProviderError`.
 *
 * It wraps failures in `ProviderUnavailableError` and puts the original in
 * `cause`, so the classification GEO-001 performed survives one unwrapping.
 * Three shapes arrive here:
 *
 * - our own `GeoProviderError` — an HTTP status we already classified;
 * - an abort — the per-attempt timeout fired;
 * - the breaker refusing the call, which is `'circuit open'` as a string cause.
 *
 * The breaker case is the only one that reads a value from another module's
 * internals, and it degrades safely: misread, it costs one more attempt that
 * the breaker itself rejects without touching the network.
 */
function asGeoError(err: unknown): GeoProviderError {
  if (err instanceof GeoProviderError) return err;

  if (err instanceof ProviderUnavailableError) {
    const { cause } = err;
    if (cause instanceof GeoProviderError) return cause;
    if (cause === 'circuit open') {
      // Failing fast is the breaker's whole purpose; retrying past it would
      // undo it.
      return new GeoProviderError('vietmap', 'UPSTREAM_UNAVAILABLE', { cause });
    }
    if (isAbort(cause)) {
      return new GeoProviderError('vietmap', 'TIMEOUT', { cause });
    }
    // A socket reset, a DNS failure, a TLS error: retryable per spec §17.
    return new GeoProviderError('vietmap', 'UPSTREAM_UNAVAILABLE', { cause });
  }

  if (isAbort(err)) return new GeoProviderError('vietmap', 'TIMEOUT', { cause: err });
  return new GeoProviderError('vietmap', 'UPSTREAM_UNAVAILABLE', { cause: err });
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** The breaker's refusal is not a reason to try again. */
function isCircuitOpen(err: GeoProviderError): boolean {
  return err.cause === 'circuit open';
}

export class VietmapClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;

  constructor(config: VietmapClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? VIETMAP_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? VIETMAP_DEFAULT_TIMEOUT_MS;
    this.maxAttempts = config.maxAttempts ?? VIETMAP_MAX_ATTEMPTS;
    this.breakerThreshold = config.breakerThreshold ?? 5;
    this.breakerCooldownMs = config.breakerCooldownMs ?? 30_000;
  }

  /** The request URL, key included. Never log this — use `redactVietmapUrl`. */
  buildUrl(path: string, query: VietmapQuery): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('apikey', this.apiKey);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * One GET, retried according to spec §17.
   *
   * `signal` is the caller's own cancellation — a request that went away, or an
   * autocomplete keystroke superseded by the next one (spec §10.3). It composes
   * with the per-attempt timeout rather than replacing it.
   */
  async get<T>(
    operation: string,
    path: string,
    query: VietmapQuery,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    let lastError: GeoProviderError | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await withResilience<T>(
          {
            name: `vietmap.${operation}`,
            timeoutMs: this.timeoutMs,
            retries: 0,
            breakerThreshold: this.breakerThreshold,
            breakerCooldownMs: this.breakerCooldownMs,
          },
          async (timeoutSignal) => {
            const composed = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
            const res = await fetch(url, { method: 'GET', signal: composed });

            if (!res.ok) {
              throw GeoProviderError.fromStatus('vietmap', res.status, {
                ...retryAfterOf(res),
                // The status, not the body: spec §18 keeps provider payloads
                // away from anything a caller might surface.
                cause: `vietmap responded ${res.status}`,
              });
            }

            try {
              return (await res.json()) as T;
            } catch (err) {
              throw new GeoProviderError('vietmap', 'BAD_UPSTREAM_RESPONSE', {
                upstreamStatus: res.status,
                cause: err,
              });
            }
          },
        );
      } catch (err) {
        // The caller went away — a superseded autocomplete keystroke, a request
        // whose client disconnected (spec §10.3). That is not a provider
        // failure: retrying it would call an API nobody is waiting for, and
        // recording it as TIMEOUT would fill `geo_provider_errors_total` with
        // our own cancellations. Give the caller back its own reason.
        if (signal?.aborted) throw signal.reason;

        const geo = asGeoError(err);
        lastError = geo;

        const isLastAttempt = attempt === this.maxAttempts - 1;
        if (!geo.retryable || isCircuitOpen(geo) || isLastAttempt) throw geo;

        // Spec §17: the provider's own answer about when to come back beats our
        // backoff curve, up to the cap.
        const wait = Math.min(
          geo.retryAfterMs ?? jitteredBackoff(attempt),
          VIETMAP_MAX_RETRY_AFTER_MS,
        );
        await sleep(wait);
      }
    }

    // Unreachable: the loop above either returns or throws. Here for the type.
    throw lastError ?? new GeoProviderError('vietmap', 'UPSTREAM_UNAVAILABLE');
  }
}

function retryAfterOf(res: Response): { retryAfterMs?: number } {
  const ms = parseRetryAfterMs(res.headers.get('retry-after'));
  return ms === undefined ? {} : { retryAfterMs: ms };
}
