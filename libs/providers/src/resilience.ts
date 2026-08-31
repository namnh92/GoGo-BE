import { ProviderQuotaExceededError, ProviderUnavailableError } from './ports';

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
