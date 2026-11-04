import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type PushDeviceIdentityConfig } from '../../shared/config';
import { flagEnvironmentOf, resolveBooleanFlag } from '../../shared/feature-flags';
import { DB } from '../../shared/tokens';
import {
  deviceSecretMatches,
  hashDeviceSecret,
  parseDeviceAuthorization,
  DEVICE_IDENTITY_FLAG,
  type DeviceCredential,
} from '../domain/device-identity';
import { PushIdentityService, type PushIdentityToken } from './push-identity.service';
import {
  claimOwnership,
  lockIdentities,
  readOwnership,
  retireIdentities,
  type Tx,
} from './push-subscription-ownership';

export type DeviceSubscriptionReport = {
  platform: 'ios' | 'android' | 'web';
  /** OneSignal's id for this device's push subscription. Never logged. */
  subscriptionId: string;
  promotionsEnabled: boolean;
  preferenceVersion: number;
};

export type DeviceSubscriptionResult = {
  appliedVersion: number;
  storedVersion: number;
  /** What the provider read showed. An OFF has converged only when this is false. */
  providerEnabled: boolean;
};

function gone(): AppError {
  return AppError.notFound('PUSH_DEVICE_IDENTITY_GONE', 'This device identity no longer exists');
}

/**
 * NTF-BE-017 (#747), ADR-0038 — a device with no session.
 *
 * Every route here is public at the session level and carries the device
 * credential instead, which reaches these calls and nothing under `/me`. A wrong
 * secret, an unknown id and a retired identity all answer the same 404, so the
 * routes cannot be used to learn which ids exist.
 */
@Injectable()
export class PushDeviceIdentityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly identity: PushIdentityService,
    @Inject(APP_CONFIG) private readonly config: PushDeviceIdentityConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  enabled(): Promise<boolean> {
    return resolveBooleanFlag(this.db, DEVICE_IDENTITY_FLAG, {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
  }

  private async requireEnabled(): Promise<void> {
    if (await this.enabled()) return;
    throw AppError.notFound('PUSH_DEVICE_IDENTITY_DISABLED', 'Device identities are switched off');
  }

  /** The secret is returned here once and stored only as a hash. */
  async create(): Promise<PushIdentityToken & { deviceId: string; deviceSecret: string }> {
    await this.requireEnabled();
    if (!this.identity.available) {
      throw AppError.serviceUnavailable(
        'PUSH_IDENTITY_UNAVAILABLE',
        'Push identity signing is not configured in this environment',
        false,
      );
    }
    const deviceSecret = randomBytes(32).toString('base64url');
    // One creation at a time, across replicas: a count and an insert in separate
    // statements let concurrent callers all pass a ceiling they jointly exceed.
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('push_device_identities.create'))`,
      );
      const { rows } = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from push_device_identities
        where created_at >= now() - interval '24 hours'
      `);
      if (Number(rows[0]?.n ?? 0) >= this.config.PUSH_DEVICE_IDENTITY_DAILY_CEILING) {
        this.metrics.increment('push_device_identities_total', { result: 'ceiling' });
        throw AppError.tooManyRequests('Too many new device identities today', 3_600);
      }
      const [created] = await tx
        .insert(schema.pushDeviceIdentities)
        .values({ secretHash: hashDeviceSecret(deviceSecret) })
        .returning({ id: schema.pushDeviceIdentities.id });
      return created;
    });
    this.metrics.increment('push_device_identities_total', { result: 'created' });
    return { deviceId: row!.id, deviceSecret, ...this.identity.issueForDevice(row!.id) };
  }

  /** A renewal. Same row lock as every other write, so it cannot outlive a retirement. */
  async token(authorization: string | undefined): Promise<PushIdentityToken> {
    await this.requireEnabled();
    const credential = parseDeviceAuthorization(authorization);
    if (!this.identity.available) {
      throw AppError.serviceUnavailable(
        'PUSH_IDENTITY_UNAVAILABLE',
        'Push identity signing is not configured in this environment',
        false,
      );
    }
    await this.db.transaction(async (tx) => {
      await this.requireLive(tx, credential);
      await this.touch(tx, credential.deviceId);
    });
    return this.identity.issueForDevice(credential.deviceId);
  }

  /**
   * Records the device's subscription and its promotions choice.
   *
   * Same protocol as a user's registration: read, ask the provider outside any
   * lock, then write only if what was read still holds. The choice and the
   * ownership land together or not at all. `enabled` is required only to opt in:
   * an opt-out must be recordable for a subscription already disabled.
   */
  async report(
    authorization: string | undefined,
    input: DeviceSubscriptionReport,
  ): Promise<DeviceSubscriptionResult> {
    await this.requireEnabled();
    const credential = parseDeviceAuthorization(authorization);
    await this.db.transaction((tx) => this.requireLive(tx, credential));

    const seen = await readOwnership(this.db, input.subscriptionId);
    const read = await this.identity.readDeviceSubscriptions(credential.deviceId);
    if (read.kind === 'unreachable' || read.kind === 'error') {
      this.metrics.increment('push_device_reports_total', { result: 'unverified' });
      throw AppError.serviceUnavailable(
        'PUSH_SUBSCRIPTION_UNVERIFIED',
        'Could not reach the push provider to verify this subscription',
        true,
      );
    }
    const match =
      read.kind === 'ok'
        ? read.subscriptions.find((s) => s.id === input.subscriptionId)
        : undefined;
    if (!match || (input.promotionsEnabled && !match.enabled)) {
      this.metrics.increment('push_device_reports_total', { result: 'refused' });
      throw AppError.forbidden(
        'PUSH_SUBSCRIPTION_NOT_CONFIRMED',
        'The push provider does not report this subscription as enabled for this device',
      );
    }

    const stored = await this.db.transaction(async (tx) => {
      // Identity first, then fence, then row. A different device identity holding
      // the row loses it the way one does to a user, and is locked in id order.
      const previous =
        seen.deviceId && seen.deviceId !== credential.deviceId ? [seen.deviceId] : [];
      const locked = await lockIdentities(tx, [credential.deviceId, ...previous]);
      const self = locked.find((row) => row.id === credential.deviceId);
      if (!self || self.revoked_at !== null) throw gone();

      const { preference_version: version, promotions_enabled: promotions } = self;
      if (promotions !== null && input.preferenceVersion < version) {
        this.metrics.increment('push_device_reports_total', { result: 'stale' });
        throw AppError.conflict('PUSH_PREFERENCE_STALE', 'A newer choice is already stored', [
          { field: 'preferenceVersion', code: 'stale', message: String(version) },
        ]);
      }

      const claimed = await claimOwnership(
        tx,
        {
          subscriptionId: input.subscriptionId,
          platform: input.platform,
          owner: { kind: 'device', deviceId: credential.deviceId },
        },
        seen,
      );
      if (!claimed) {
        this.metrics.increment('push_device_reports_total', { result: 'conflict' });
        throw new AppError(
          'PUSH_SUBSCRIPTION_CONFLICT',
          'This subscription changed while it was being verified; report it again',
          409,
          { retryable: true },
        );
      }
      await retireIdentities(tx, previous);

      // Equal is a replay: the stored choice stands. Null has never been stated.
      const applies = promotions === null || input.preferenceVersion > version;
      await tx
        .update(schema.pushDeviceIdentities)
        .set({
          lastSeenAt: sql`now()`,
          ...(applies
            ? {
                promotionsEnabled: input.promotionsEnabled,
                preferenceVersion: input.preferenceVersion,
              }
            : {}),
        })
        .where(eq(schema.pushDeviceIdentities.id, credential.deviceId));
      return applies ? input.preferenceVersion : version;
    });

    this.metrics.increment('push_device_reports_total', { result: 'recorded' });
    return {
      appliedVersion: input.preferenceVersion,
      storedVersion: stored,
      providerEnabled: match.enabled,
    };
  }

  /** Works with the flag off: this is how a device leaves. Provider cleanup is queued. */
  async retire(authorization: string | undefined): Promise<void> {
    const credential = parseDeviceAuthorization(authorization);
    await this.db.transaction(async (tx) => {
      await this.requireLive(tx, credential);
      await retireIdentities(tx, [credential.deviceId]);
    });
    this.metrics.increment('push_device_identities_total', { result: 'retired' });
  }

  private async requireLive(tx: Tx, credential: DeviceCredential): Promise<void> {
    const [row] = await lockIdentities(tx, [credential.deviceId]);
    if (
      !row ||
      row.revoked_at !== null ||
      !deviceSecretMatches(credential.secret, row.secret_hash)
    ) {
      throw gone();
    }
  }

  private touch(tx: Tx, deviceId: string) {
    return tx
      .update(schema.pushDeviceIdentities)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(schema.pushDeviceIdentities.id, deviceId));
  }
}
