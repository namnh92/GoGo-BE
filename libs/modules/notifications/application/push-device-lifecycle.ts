import { eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { NotificationProviderPort } from '@gogo/providers';
import {
  flagEnvironmentOf,
  resolveBooleanFlag,
  type FlagEnvironment,
} from '../../shared/feature-flags';
import {
  DEVICE_IDENTITY_FLAG,
  DEVICE_INACTIVE_DAYS,
  DEVICE_RETAINED_AFTER_CLEANUP_DAYS,
  DEVICE_UNCONFIRMED_DAYS,
  deviceExternalId,
} from '../domain/device-identity';
import { lockIdentities, retireIdentities } from './push-subscription-ownership';

/** Each pass per tick, so a backlog cannot hold the job or hammer the provider. */
const BATCH = 100;
/** Backoff doubles from 5 minutes; past this many the row needs a person. */
const CLEANUP_MAX_ATTEMPTS = 8;
const CLEANUP_BASE_BACKOFF_SECONDS = 300;

export type LifecycleReport = {
  expired: number;
  drained: number;
  cleaned: number;
  cleanupFailed: number;
  deleted: number;
};

/**
 * NTF-BE-017 (#747), ADR-0038 D9 — how a device identity ends.
 *
 * Plain class, like the dispatchers: the worker wires it without Nest.
 *
 * Retirement takes the identity's row lock and re-checks its condition under it,
 * so a renewal either lands first and this skips, or sees `revoked_at` and answers
 * GONE. There is no third outcome. The provider call runs afterwards, outside any
 * transaction, and only for ids in the `device:` namespace.
 */
export class PushDeviceLifecycle {
  private readonly environment: FlagEnvironment;

  constructor(
    private readonly db: Db,
    private readonly push: NotificationProviderPort,
    private readonly metrics?: { increment(name: string, labels?: Record<string, string>): void },
    appEnv = 'dev',
  ) {
    this.environment = flagEnvironmentOf(appEnv);
  }

  async tick(signal?: AbortSignal): Promise<LifecycleReport> {
    const expired = await this.retireWhere(
      sql`(promotions_enabled is null
             and created_at < now() - make_interval(days => ${DEVICE_UNCONFIRMED_DAYS}))
          or last_seen_at < now() - make_interval(days => ${DEVICE_INACTIVE_DAYS})`,
      'expired',
    );
    // Flag off: nothing can renew, so an identity quiet for an hour holds no JWT
    // the provider would still accept. That is the rollback's drain.
    const on = await resolveBooleanFlag(this.db, DEVICE_IDENTITY_FLAG, {
      environment: this.environment,
    });
    const drained = on
      ? 0
      : await this.retireWhere(sql`last_seen_at < now() - interval '1 hour'`, 'drained');
    const { cleaned, cleanupFailed } = await this.cleanup(signal);
    const deleted = await this.deleteRetained();
    return { expired, drained, cleaned, cleanupFailed, deleted };
  }

  /** Identities whose provider cleanup gave up: a person has to look. */
  async cleanupDeadLettered(): Promise<number> {
    const { rows } = await this.db.execute<{ n: number }>(
      sql`select count(*)::int as n from push_device_identities where cleanup_state = 'failed'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async retireWhere(condition: SQL, result: string): Promise<number> {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      select id from push_device_identities
      where revoked_at is null and (${condition})
      order by id limit ${BATCH}
    `);
    let retired = 0;
    for (const { id } of rows) {
      const done = await this.db.transaction(async (tx) => {
        await lockIdentities(tx, [id]);
        const { rows: still } = await tx.execute(sql`
          select 1 from push_device_identities
          where id = ${id}::uuid and revoked_at is null and (${condition})
        `);
        if (still.length === 0) return false;
        await retireIdentities(tx, [id]);
        return true;
      });
      if (done) {
        retired += 1;
        this.metrics?.increment('push_device_identities_total', { result });
      }
    }
    return retired;
  }

  private async cleanup(signal?: AbortSignal): Promise<{ cleaned: number; cleanupFailed: number }> {
    const d = schema.pushDeviceIdentities;
    const { rows } = await this.db.execute<{ id: string; cleanup_attempts: number }>(sql`
      select id, cleanup_attempts from push_device_identities
      where cleanup_state = 'pending' and cleanup_next_at <= now()
      order by cleanup_next_at limit ${BATCH}
    `);
    let cleaned = 0;
    let cleanupFailed = 0;
    for (const row of rows) {
      if (signal?.aborted) break;
      try {
        await this.push.deleteDeviceIdentity(deviceExternalId(row.id));
        await this.db
          .update(d)
          .set({ cleanupState: 'done', cleanupNextAt: null })
          .where(eq(d.id, row.id));
        cleaned += 1;
        this.metrics?.increment('push_device_identities_total', { result: 'cleaned' });
      } catch {
        const attempts = row.cleanup_attempts + 1;
        const exhausted = attempts >= CLEANUP_MAX_ATTEMPTS;
        await this.db
          .update(d)
          .set({
            cleanupAttempts: attempts,
            cleanupState: exhausted ? 'failed' : 'pending',
            cleanupNextAt: exhausted
              ? null
              : sql`now() + make_interval(secs => ${CLEANUP_BASE_BACKOFF_SECONDS * 2 ** (attempts - 1)})`,
          })
          .where(eq(d.id, row.id));
        cleanupFailed += 1;
        this.metrics?.increment('push_device_identities_total', { result: 'cleanup_failed' });
      }
    }
    return { cleaned, cleanupFailed };
  }

  /**
   * Owner 2026-11-04: the promise to a person is deletion, so a retired identity
   * goes once the provider has dropped it and the window has passed. Its rows were
   * revoked at retirement. A later registration finds no row and takes the fence
   * path; the ledger keeps its counts, with `device_id` set null by the foreign key.
   */
  private async deleteRetained(): Promise<number> {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      select id from push_device_identities
      where cleanup_state = 'done'
        and revoked_at < now() - make_interval(days => ${DEVICE_RETAINED_AFTER_CLEANUP_DAYS})
      order by id limit ${BATCH}
    `);
    for (const { id } of rows) {
      await this.db.transaction(async (tx) => {
        await lockIdentities(tx, [id]);
        await tx.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.deviceId, id));
        await tx.delete(schema.pushDeviceIdentities).where(eq(schema.pushDeviceIdentities.id, id));
      });
      this.metrics?.increment('push_device_identities_total', { result: 'deleted' });
    }
    return rows.length;
  }
}
