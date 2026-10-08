import { DrizzleQueryError } from 'drizzle-orm';
import { inspect } from 'node:util';
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
    const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const h = harness([reset(), reset(), 'erased']);
    await expect(h.run()).resolves.toBe('erased');
    expect(h.erase).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS[0],
      SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS[1],
    ]);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt 1/6 failed (Error ECONNRESET); retrying in 500ms'),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('a failure that outlasts every attempt refuses the start, naming the last error by class and code, and never sleeps past the last attempt', async () => {
    const h = harness([Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })]);
    const rejection = h.run();
    await expect(rejection).rejects.toBeInstanceOf(SuperAdminBootGateError);
    await expect(rejection).rejects.toMatchObject({
      code: 'ERASE_FAILED',
      message: expect.stringContaining('(last error: Error ECONNREFUSED)'),
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

/**
 * Review F-07 — the erase queries bind the super admin's address, and a
 * `DrizzleQueryError` repeats its bound parameters in its message and stack;
 * pg's `DatabaseError` echoes the row in `detail`. Neither the retry line nor
 * the fatal error may carry any of it (security.md: logs never contain PII).
 */
describe('super admin boot erase gate — no address in logs or errors (#687 F-07)', () => {
  const ADDRESS = 'boss@example.com';

  /** The shape pg-protocol throws: `name` is the message kind, `code` the SQLSTATE. */
  class DatabaseError extends Error {
    code = '08006';
    detail = `Key (lower(email))=(${ADDRESS}) already exists.`;
    constructor() {
      super('terminating connection due to administrator command');
      this.name = 'error';
    }
  }

  const leakyFailure = () =>
    new DrizzleQueryError(
      'select "id" from "audit_logs" where lower("diff" ->> \'email\') = $1',
      [ADDRESS],
      new DatabaseError(),
    );

  /** Every way a caller or a crash handler could render an error. */
  const renderings = (err: Error) => [
    err.message,
    String(err),
    err.stack ?? '',
    JSON.stringify(err),
    JSON.stringify(
      Object.getOwnPropertyNames(err).map((k) => (err as unknown as Record<string, unknown>)[k]),
    ),
    inspect(err, { depth: 10 }),
  ];

  const everyLogLine = (logger: ReturnType<typeof harness>['logger']) =>
    [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((args) =>
      JSON.stringify(args),
    );

  it('the premise: the raw error renders the address everywhere', () => {
    const err = leakyFailure();
    expect(err.message).toContain(ADDRESS);
    expect(err.stack).toContain(ADDRESS);
    expect(inspect(err, { depth: 10 })).toContain(ADDRESS);
  });

  it('a retried failure is logged by class and code only', async () => {
    const h = harness([leakyFailure(), leakyFailure(), 'erased']);
    await expect(h.run()).resolves.toBe('erased');
    for (const line of everyLogLine(h.logger)) {
      expect(line).not.toContain(ADDRESS);
      expect(line).not.toContain('example.com');
      expect(line).not.toContain('Failed query');
    }
    expect(h.logger.warn).toHaveBeenCalledTimes(3); // two retries + "erased at boot"
    expect(h.logger.warn).toHaveBeenCalledWith(
      'super admin erase gate attempt 1/6 failed (DrizzleQueryError <- DatabaseError 08006); retrying in 500ms',
    );
  });

  it('an exhausted retry refuses the start with an error that carries neither the address nor the cause', async () => {
    const h = harness([leakyFailure()], 2);
    let thrown: unknown;
    try {
      await h.run();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SuperAdminBootGateError);
    const err = thrown as SuperAdminBootGateError;
    expect(err.code).toBe('ERASE_FAILED');
    for (const text of renderings(err)) {
      expect(text).not.toContain(ADDRESS);
      expect(text).not.toContain('example.com');
      expect(text).not.toContain('Failed query');
    }
    for (const line of everyLogLine(h.logger)) {
      expect(line).not.toContain(ADDRESS);
      expect(line).not.toContain('Failed query');
    }
    expect('cause' in err).toBe(false);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expect(err.message).toBe(
      'super admin erase gate failed 2 times at boot; refusing to start (last error: DrizzleQueryError <- DatabaseError 08006)',
    );
    expect(h.erase).toHaveBeenCalledTimes(2);
  });

  it('a thrown value that is not an Error is named by type, whatever it holds', async () => {
    const h = harness([`refused ${ADDRESS}` as unknown as Error], 1);
    // The harness only throws Error instances; emulate a bare rejection.
    h.erase.mockImplementationOnce(() => Promise.reject(`refused ${ADDRESS}`));
    await expect(h.run()).rejects.toMatchObject({
      code: 'ERASE_FAILED',
      message: expect.stringContaining('(last error: string)'),
    });
    for (const line of everyLogLine(h.logger)) expect(line).not.toContain(ADDRESS);
  });
});
