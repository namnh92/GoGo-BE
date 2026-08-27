import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderQuotaExceededError, ProviderUnavailableError } from './ports';
import { resetBreakers, withResilience } from './resilience';

const options = (name: string, over: Partial<Parameters<typeof withResilience>[0]> = {}) => ({
  name,
  timeoutMs: 50,
  retries: 2,
  breakerThreshold: 3,
  breakerCooldownMs: 100,
  ...over,
});

afterEach(() => {
  resetBreakers();
  vi.useRealTimers();
});

/**
 * BE-BFF-011 — this is the code that decides whether a provider outage
 * degrades or cascades, and it had no test. Every case here is a failure
 * injected on purpose.
 */
describe('withResilience (#60)', () => {
  it('returns the value and leaves the breaker closed', async () => {
    const result = await withResilience(options('ok'), async () => 'value');
    expect(result).toBe('value');
  });

  it('retries a transient failure and succeeds', async () => {
    let calls = 0;
    const result = await withResilience(options('transient'), async () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('gives up after the configured retries, as an unavailable provider', async () => {
    let calls = 0;
    await expect(
      withResilience(options('down', { breakerThreshold: 99 }), async () => {
        calls += 1;
        throw new Error('down');
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('never retries a quota error, and propagates it untouched', async () => {
    let calls = 0;
    const quota = new ProviderQuotaExceededError('places');
    await expect(
      withResilience(options('quota'), async () => {
        calls += 1;
        throw quota;
      }),
    ).rejects.toBe(quota);
    // Retrying quota exhaustion only spends more of the budget that ran out,
    // and it must reach the caller as quota rather than as an outage: the two
    // have different answers.
    expect(calls).toBe(1);
  });

  it('a quota error does not count toward opening the breaker', async () => {
    const quota = new ProviderQuotaExceededError('places');
    for (let i = 0; i < 5; i += 1) {
      await withResilience(options('quota-breaker'), async () => {
        throw quota;
      }).catch(() => undefined);
    }
    // Still calling through: quota is a budget state, not a broken provider.
    let called = false;
    await withResilience(options('quota-breaker'), async () => {
      called = true;
      return 'ok';
    });
    expect(called).toBe(true);
  });

  it('opens the breaker and then fails fast without calling the provider', async () => {
    const failing = options('breaker', { retries: 0, breakerThreshold: 2 });
    for (let i = 0; i < 2; i += 1) {
      await withResilience(failing, async () => {
        throw new Error('boom');
      }).catch(() => undefined);
    }

    let called = false;
    const started = Date.now();
    await expect(
      withResilience(failing, async () => {
        called = true;
        return 'never';
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    // The point of an open breaker: a deterministic fallback runs instead of
    // every request stacking another provider timeout.
    expect(called).toBe(false);
    expect(Date.now() - started).toBeLessThan(40);
  });

  it('allows a trial call once the cooldown has elapsed, and closes on success', async () => {
    const cfg = options('cooldown', { retries: 0, breakerThreshold: 1, breakerCooldownMs: 20 });
    await withResilience(cfg, async () => {
      throw new Error('boom');
    }).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 30));
    const result = await withResilience(cfg, async () => 'back');
    expect(result).toBe('back');

    // Closed again: a recovered provider must not stay shut out.
    const again = await withResilience(cfg, async () => 'still back');
    expect(again).toBe('still back');
  });

  it('aborts a call that outlives the timeout', async () => {
    let aborted = false;
    await expect(
      withResilience(
        options('slow', { timeoutMs: 20, retries: 0, breakerThreshold: 99 }),
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(aborted).toBe(true);
  });

  it('keeps one provider’s outage out of another’s breaker', async () => {
    const cfg = (name: string) => options(name, { retries: 0, breakerThreshold: 1 });
    await withResilience(cfg('provider-a'), async () => {
      throw new Error('boom');
    }).catch(() => undefined);

    // A shared breaker would take down every provider when one fails.
    await expect(withResilience(cfg('provider-b'), async () => 'fine')).resolves.toBe('fine');
  });
});
