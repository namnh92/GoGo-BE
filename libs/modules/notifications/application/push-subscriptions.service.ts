import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { PushIdentityService } from './push-identity.service';

/**
 * NTF-BE-011 (#515) — the record of which users a push campaign can reach.
 *
 * This exists for one reason: a campaign resolves its audience as a single SQL
 * predicate, and "can this person receive a push" is the one part of that
 * question the provider cannot be asked once per campaign. It is not a routing
 * registry — a push is still addressed to `external_id = users.id` and
 * OneSignal still owns the device list (spec §26, ADR-0016) — and it holds no
 * APNs or FCM token.
 *
 * What it replaces held neither. `device_tokens` was written by nothing but the
 * mobile contract test, so the audience of every campaign on DEV was three
 * throwaway accounts that had never opened the app, while every real user was
 * excluded.
 *
 * The subscription id arrives from the client, and is never trusted as it
 * arrives. Before a row is written the provider is asked whether that
 * subscription belongs to *this* caller and is enabled. Without that check a
 * client could name someone else's subscription id and move their row onto its
 * own account — not stealing their push, which OneSignal addresses by identity,
 * but quietly removing them from every campaign audience.
 */
export type PushSubscriptionRegistration = {
  platform: 'ios' | 'android' | 'web';
  /** OneSignal's id for this device's push subscription. Never logged. */
  subscriptionId: string;
};

export type PushSubscriptionRecord = {
  platform: 'ios' | 'android' | 'web';
  registeredAt: string;
};

function requireUser(actor: Actor): string {
  if (actor.type !== 'user') throw AppError.forbidden('USER_ONLY', 'Login required');
  return actor.id;
}

@Injectable()
export class PushSubscriptionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly identity: PushIdentityService,
    @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * Records that this caller's device holds a live push subscription.
   *
   * Idempotent on the subscription id: one device is one subscription however
   * many times it reports, and whoever is signed in on it now is who it belongs
   * to. That upsert is also the account-switch path — the previous user stops
   * being reachable on a device they no longer hold, without a second endpoint
   * and without the client having to say so.
   */
  async register(actor: Actor, input: PushSubscriptionRegistration): Promise<PushSubscriptionRecord> {
    const userId = requireUser(actor);
    const read = await this.identity.readOwnSubscriptions(actor);

    if (read.kind === 'unreachable' || read.kind === 'error') {
      this.metrics.increment('push_subscription_registrations_total', { result: 'unverified' });
      // Retryable: the device still holds the subscription and will report it
      // again. Writing the row anyway would put an unverified claim into the
      // audience, which is the failure this endpoint exists to end.
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
    if (!match || !match.enabled) {
      this.metrics.increment('push_subscription_registrations_total', { result: 'refused' });
      // Deliberately one answer for "not yours" and "yours but disabled": the
      // difference is a fact about someone else's device, and telling the two
      // apart would turn this into a probe for whether a given subscription id
      // exists. Not retryable — the device must bind identity first.
      throw AppError.forbidden(
        'PUSH_SUBSCRIPTION_NOT_CONFIRMED',
        'The push provider does not report this subscription as enabled for you',
      );
    }

    const [row] = await this.db
      .insert(schema.pushSubscriptions)
      .values({ userId, platform: input.platform, subscriptionId: input.subscriptionId })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.subscriptionId,
        set: {
          userId,
          platform: input.platform,
          lastConfirmedAt: sql`now()`,
          // A device that reports again is subscribed again, whatever an
          // earlier logout recorded.
          revokedAt: null,
        },
      })
      .returning({
        platform: schema.pushSubscriptions.platform,
        lastConfirmedAt: schema.pushSubscriptions.lastConfirmedAt,
      });

    this.metrics.increment('push_subscription_registrations_total', { result: 'registered' });
    return { platform: row!.platform, registeredAt: row!.lastConfirmedAt.toISOString() };
  }

  /**
   * Marks a subscription gone, after a logout the provider itself confirmed.
   *
   * Only ever the caller's own row, and only for a subscription the provider
   * already agreed is no longer enabled for them — so this cannot be used to
   * remove anyone else from an audience. Silent when the row is unknown: the
   * device may never have registered, and a logout must not fail over
   * bookkeeping.
   */
  async revoke(actor: Actor, subscriptionId: string): Promise<void> {
    const userId = requireUser(actor);
    const revoked = await this.db
      .update(schema.pushSubscriptions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(schema.pushSubscriptions.subscriptionId, subscriptionId),
          eq(schema.pushSubscriptions.userId, userId),
          isNull(schema.pushSubscriptions.revokedAt),
        ),
      )
      .returning({ id: schema.pushSubscriptions.id });
    if (revoked.length > 0) {
      this.metrics.increment('push_subscription_registrations_total', { result: 'revoked' });
    }
  }
}
