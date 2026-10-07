import type { eraseSuperAdminPasswordIfConfirmed } from '@gogo/database';

/**
 * GoGo-BE#687 D-3, review F-05 — the erase gate the API runs at boot.
 *
 * `cms:sync-super-admin` runs in the migrate container while the previous API
 * (switch off) can still serve a reset or a password change, which puts a hash
 * back after the sync erased it. The new API therefore runs the same gate once
 * it starts, when the old process is gone. The first build of this logged every
 * failure and started anyway, so a transient error in that window left the
 * super admin with a password behind a switch that promises there is none.
 *
 * Rules, decided per outcome of `eraseSuperAdminPasswordIfConfirmed`:
 *
 * | outcome            | meaning                                             | start?      |
 * | ------------------ | --------------------------------------------------- | ----------- |
 * | `erased`           | the hash and the change obligation were cleared     | yes         |
 * | `nothing_to_erase` | both already NULL                                   | yes         |
 * | `pending`          | no `admin.sso_confirmed` row for the current address | yes — the documented state before the owner proves the Access door (D-3) |
 * | `no_super_admin`   | the sync did not run for this revision              | **no**      |
 * | `address_mismatch` | the row is not at `CMS_SUPER_ADMIN_EMAIL`           | **no**      |
 * | thrown             | the database did not answer                         | retried; **no** once the attempts are spent |
 *
 * A refused start rejects `onApplicationBootstrap`, so Nest never listens: the
 * process exits non-zero, the container's health check never passes, and the
 * deploy's health wait fails on a revision whose promise it cannot keep. The
 * retry is bounded so a database that is really gone produces one loud exit,
 * not a process that hangs inside its lifecycle hook.
 */

export type SuperAdminEraseOutcome = Awaited<ReturnType<typeof eraseSuperAdminPasswordIfConfirmed>>;

/** Outcomes that let the API start. */
export type SuperAdminBootEraseResult = Extract<
  SuperAdminEraseOutcome,
  'erased' | 'nothing_to_erase' | 'pending'
>;

/** Total calls, the first one included. */
export const SUPER_ADMIN_BOOT_ERASE_ATTEMPTS = 6;
/**
 * Waits between consecutive attempts; the last value repeats when there are
 * more retries than entries. 15.5 s in all — enough for a pooled connection to
 * recover or a scaled-to-zero database to wake, short enough that a deploy
 * learns the answer inside its health wait.
 */
export const SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

export type SuperAdminBootGateCode = 'NO_SUPER_ADMIN' | 'ADDRESS_MISMATCH' | 'ERASE_FAILED';

export class SuperAdminBootGateError extends Error {
  constructor(
    readonly code: SuperAdminBootGateCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SuperAdminBootGateError';
  }
}

type GateLogger = {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type SuperAdminBootEraseDeps = {
  /** One run of the erase gate, in its own transaction. */
  erase: () => Promise<SuperAdminEraseOutcome>;
  logger: GateLogger;
  /** Injected by tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  backoffMs?: readonly number[];
};

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err));

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs the gate until it answers, retrying only what a retry can change. The
 * two inconsistent states are not retried: nothing that runs after the migrate
 * container can create the row or move its address, so a second look would
 * only delay the same answer.
 */
export async function runSuperAdminBootErase(
  deps: SuperAdminBootEraseDeps,
): Promise<SuperAdminBootEraseResult> {
  const attempts = deps.attempts ?? SUPER_ADMIN_BOOT_ERASE_ATTEMPTS;
  const backoff = deps.backoffMs ?? SUPER_ADMIN_BOOT_ERASE_BACKOFF_MS;
  const sleep = deps.sleep ?? defaultSleep;
  if (attempts < 1) throw new RangeError('super admin erase gate: attempts must be at least 1');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let outcome: SuperAdminEraseOutcome;
    try {
      outcome = await deps.erase();
    } catch (err) {
      if (attempt === attempts) {
        const message = `super admin erase gate failed ${attempts} times at boot; refusing to start: ${describeError(err)}`;
        deps.logger.error(message);
        throw new SuperAdminBootGateError('ERASE_FAILED', message, { cause: err });
      }
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;
      deps.logger.warn(
        `super admin erase gate attempt ${attempt}/${attempts} failed (${describeError(err)}); retrying in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }

    switch (outcome) {
      case 'erased':
        deps.logger.warn('super admin password erased at boot (SSO confirmed)');
        return outcome;
      case 'nothing_to_erase':
        deps.logger.log('super admin password already erased; nothing to do at boot');
        return outcome;
      case 'pending':
        deps.logger.log('super admin password erase pending SSO confirmation');
        return outcome;
      case 'no_super_admin': {
        const message =
          'super admin erase gate: no super_admin row — cms:sync-super-admin did not run for this revision; refusing to start';
        deps.logger.error(message);
        throw new SuperAdminBootGateError('NO_SUPER_ADMIN', message);
      }
      case 'address_mismatch': {
        const message =
          'super admin erase gate: the super_admin row is not at CMS_SUPER_ADMIN_EMAIL — cms:sync-super-admin did not run for this revision; refusing to start';
        deps.logger.error(message);
        throw new SuperAdminBootGateError('ADDRESS_MISMATCH', message);
      }
    }
  }
  // Unreachable: every iteration returns or throws. Kept for the type system.
  throw new SuperAdminBootGateError('ERASE_FAILED', 'super admin erase gate: no attempt ran');
}
