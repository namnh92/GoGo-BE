import { describe, expect, it, vi } from 'vitest';
import {
  runSuperAdminBootErase,
  SUPER_ADMIN_BOOT_ERASE_ATTEMPTS,
  SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS,
  SuperAdminBootGateError,
  type SuperAdminEraseOutcome,
} from './super-admin-boot-gate';

/**
 * GoGo-BE#687 review F-05 — which outcomes of the boot-time erase gate let the
 * API start, which stop it, and how far a transient failure is retried.
 */

function harness(script: Array<SuperAdminEraseOutcome | Error>, attempts?: number) {
  let call = 0;
  const erase = vi.fn(async () => {
    const step = script[Math.min(call, script.length - 1)]!;
    call += 1;
    if (step instanceof Error) throw step;
    return step;
  });
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = () =>
    runSuperAdminBootErase({
      erase,
      logger,
      sleep,
      ...(attempts === undefined ? {} : { attempts }),
    });
  return { erase, sleep, logger, run };
}

describe('super admin boot erase gate (#687 F-05)', () => {
  it.each(['erased', 'nothing_to_erase', 'pending'] as const)(
    '%s lets the API start without a retry',
    async (outcome) => {
      const h = harness([outcome]);
      await expect(h.run()).resolves.toBe(outcome);
      expect(h.erase).toHaveBeenCalledTimes(1);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.logger.error).not.toHaveBeenCalled();
    },
  );

  it('pending is the documented state before SSO is confirmed: a log line, not an error', async () => {
    const h = harness(['pending']);
    await h.run();
    expect(h.logger.log).toHaveBeenCalledWith(
      'super admin password erase pending SSO confirmation',
    );
  });

  it('no super_admin row is fatal on the first look — nothing after migrate can create it', async () => {
    const h = harness(['no_super_admin']);
    await expect(h.run()).rejects.toMatchObject({
      name: 'SuperAdminBootGateError',
      code: 'NO_SUPER_ADMIN',
    });
    expect(h.erase).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('a row at another address than CMS_SUPER_ADMIN_EMAIL is fatal on the first look', async () => {
    const h = harness(['address_mismatch']);
    await expect(h.run()).rejects.toMatchObject({ code: 'ADDRESS_MISMATCH' });
    expect(h.erase).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('a transient failure is retried with the documented backoff until the erase commits', async () => {
    const h = harness([new Error('ECONNRESET'), new Error('ECONNRESET'), 'erased']);
    await expect(h.run()).resolves.toBe('erased');
    expect(h.erase).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS[0],
      SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS[1],
    ]);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt 1/6 failed (ECONNRESET)'),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('a failure that outlasts every attempt refuses the start, with the cause, and never sleeps past the last attempt', async () => {
    const h = harness([new Error('connection refused')]);
    const rejection = h.run();
    await expect(rejection).rejects.toBeInstanceOf(SuperAdminBootGateError);
    await expect(rejection).rejects.toMatchObject({
      code: 'ERASE_FAILED',
      cause: expect.objectContaining({ message: 'connection refused' }),
    });
    expect(h.erase).toHaveBeenCalledTimes(SUPER_ADMIN_BOOT_ERASE_ATTEMPTS);
    expect(h.sleep).toHaveBeenCalledTimes(SUPER_ADMIN_BOOT_ERASE_ATTEMPTS - 1);
    // The last backoff value repeats when retries outnumber the entries.
    const waits = h.sleep.mock.calls.map(([ms]) => ms);
    expect(waits).toEqual([...SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS]);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(15_500);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed 6 times at boot; refusing to start'),
    );
  });

  it('the retry budget is bounded by the attempts argument', async () => {
    const h = harness([new Error('timeout')], 2);
    await expect(h.run()).rejects.toMatchObject({ code: 'ERASE_FAILED' });
    expect(h.erase).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it('a fatal state found after a transient failure is still fatal, not retried', async () => {
    const h = harness([new Error('ECONNRESET'), 'no_super_admin']);
    await expect(h.run()).rejects.toMatchObject({ code: 'NO_SUPER_ADMIN' });
    expect(h.erase).toHaveBeenCalledTimes(2);
  });

  it('refuses a zero attempt budget rather than silently starting', async () => {
    const h = harness(['erased'], 0);
    await expect(h.run()).rejects.toBeInstanceOf(RangeError);
    expect(h.erase).not.toHaveBeenCalled();
  });
});
