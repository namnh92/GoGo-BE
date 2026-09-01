import {
  MetricsQueryError,
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
} from './ports';

export type ResilienceOptions = {
  name: string;
  timeoutMs: number;
  retries: number;
  /** Open the breaker after this many consecutive failures… */
  breakerThreshold: number;
  /** …and stay open for this long before a trial call. */
  breakerCooldownMs: number;
};

type BreakerState = {
  consecutiveFailures: number;
  openedAt: number | null;
  /** When a call through this breaker last succeeded, and last failed. */
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
};
const breakers = new Map<string, BreakerState>();

/** What the breaker knows about one dependency, for #247's health view. */
export type BreakerSnapshot = {
  name: string;
  open: boolean;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
};

/**
 * #247 — read-only view of every breaker this process has seen.
 *
 * Two limits, both of which the health endpoint has to state rather than
 * paper over:
 *
 * - **Per process.** The map is module state, so an API replica knows only its
 *   own calls and nothing about the worker's or another replica's.
 * - **Traffic, not liveness.** A dependency nobody has called has no entry —
 *   which is `unknown`, not `healthy`. Reporting an untested provider as
 *   healthy is how a dashboard ends up being the last thing to notice an
 *   outage.
 */
export function breakerSnapshots(): BreakerSnapshot[] {
  return [...breakers.entries()].map(([name, state]) => ({
    name,
    open: state.openedAt !== null,
    consecutiveFailures: state.consecutiveFailures,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
  }));
}

function jitteredBackoff(attempt: number): number {
  return Math.min(1000, 100 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** For tests. */
export function resetBreakers(): void {
  breakers.clear();
}

/**
 * NFR §10.1 — every provider call gets timeout, retry with jitter, and a
 * circuit breaker. On open breaker the call fails fast so deterministic
 * fallbacks run instead of stacking latency.
 */
export async function withResilience<T>(
  options: ResilienceOptions,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const state = breakers.get(options.name) ?? {
    consecutiveFailures: 0,
    openedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
  breakers.set(options.name, state);

  if (state.openedAt !== null) {
    if (Date.now() - state.openedAt < options.breakerCooldownMs) {
      throw new ProviderUnavailableError(options.name, 'circuit open');
    }
    // Cooldown elapsed — allow a trial call.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const result = await fn(controller.signal);
      state.consecutiveFailures = 0;
      state.openedAt = null;
      state.lastSuccessAt = Date.now();
      return result;
    } catch (err) {
      // Quota exhaustion is a budget decision, not a transient fault: retrying
      // only burns more of it, so it propagates untouched to the caller.
      if (err instanceof ProviderQuotaExceededError) throw err;
      // #273: neither is a configuration fault. An API that is not enabled on
      // our project answers the second and third attempt exactly as it
      // answered the first, and each of those attempts counts toward the
      // breaker — which is why a disabled API presented as a breaker cycling
      // open and closed rather than as the one-line console fix it is.
      if (err instanceof ProviderConfigurationError) throw err;
      // #314: nor is a request the provider rejected on its merits. A place id
      // Google calls INVALID_ARGUMENT is invalid on every attempt, so retrying
      // it triples the cost of one bad link and, worse, ends in
      // ProviderUnavailableError — reporting the user's typo as our outage.
      // It must not touch the breaker either: enough pasted junk would
      // otherwise trip it and break resolution for everyone.
      if (err instanceof ProviderInvalidRequestError) throw err;
      // #315: same shape again, for reading the metrics store. A credential it
      // refuses and a query it will not parse are both permanent answers, so
      // retrying spends time to be told the same thing and counting them would
      // cycle the breaker — which flips the operator-facing detail between
      // "refused our credential" and "not answering" while nothing changes.
      // `upstream` and `malformed` are not in this list: those are worth
      // backing off from, so they fall through to the breaker below.
      if (
        err instanceof MetricsQueryError &&
        (err.reason === 'unauthorized' || err.reason === 'bad_request')
      ) {
        throw err;
      }
      lastError = err;
      state.consecutiveFailures += 1;
      state.lastFailureAt = Date.now();
      if (state.consecutiveFailures >= options.breakerThreshold) {
        state.openedAt = Date.now();
      }
      if (attempt < options.retries && state.openedAt === null) {
        await sleep(jitteredBackoff(attempt));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProviderUnavailableError(options.name, lastError);
}
