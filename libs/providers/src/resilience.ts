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

type BreakerState = { consecutiveFailures: number; openedAt: number | null };
const breakers = new Map<string, BreakerState>();

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
  const state = breakers.get(options.name) ?? { consecutiveFailures: 0, openedAt: null };
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
      return result;
    } catch (err) {
      // Quota exhaustion is a budget decision, not a transient fault: retrying
      // only burns more of it, so it propagates untouched to the caller.
      if (err instanceof ProviderQuotaExceededError) throw err;
      lastError = err;
      state.consecutiveFailures += 1;
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
