import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { PushIdentityService, type DeviceUnsubscribeConfirmation } from './push-identity.service';
import {
  claimOwnership,
  lockIdentities,
  readOwnership,
  retireIdentities,
  type OwnershipRead,
} from './push-subscription-ownership';

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
   * to. That write is also the account-switch path — the previous owner stops
   * being reachable on a device they no longer hold, without a second endpoint
   * and without the client having to say so.
   *
   * What it saw is captured before the provider is asked, and the write only
   * lands if that still holds. Anything else means the answer may be stale, so
   * the caller gets a 409 and has to be verified again.
   *
   * Taking a row from a device identity retires that identity in the same
   * transaction, so a copied device secret cannot go on renewing (ADR-0038).
   */
  async register(
    actor: Actor,
    input: PushSubscriptionRegistration,
  ): Promise<PushSubscriptionRecord> {
    const userId = requireUser(actor);
    const seen = await readOwnership(this.db, input.subscriptionId);
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

    const row = await this.db.transaction(async (tx) => {
      const previous = seen.deviceId ? [seen.deviceId] : [];
      await lockIdentities(tx, previous);
      const claimed = await claimOwnership(tx, { ...input, owner: { kind: 'user', userId } }, seen);
      if (claimed) await retireIdentities(tx, previous);
      return claimed;
    });
    if (!row) {
      this.metrics.increment('push_subscription_registrations_total', { result: 'conflict' });
      throw new AppError(
        'PUSH_SUBSCRIPTION_CONFLICT',
        'This subscription changed while it was being verified; report it again',
        409,
        { retryable: true },
      );
    }

    this.metrics.increment('push_subscription_registrations_total', { result: 'registered' });
    return { platform: row.platform, registeredAt: row.lastConfirmedAt.toISOString() };
  }

  /**
   * NTF-APP-004 (#160), NTF-BE-011 (#515) — the provider's answer to "is this
   * device off for me", and the record of it when it is.
   *
   * The ownership read comes first: a revocation that read the row after the
   * provider could take away a registration newer than the answer it acts on.
   */
  async confirmLogout(
    actor: Actor,
    subscriptionId: string,
  ): Promise<DeviceUnsubscribeConfirmation> {
    const seen = await readOwnership(this.db, subscriptionId);
    const confirmation = await this.identity.confirmDeviceUnsubscribed(actor, subscriptionId);
    // Only on a confirmation — a device that is still enabled stays in the
    // audience, and only the caller's own row is ever touched.
    if (confirmation.confirmed) await this.revoke(actor, subscriptionId, seen);
    return confirmation;
  }

  /**
   * Marks a subscription gone, after a logout the provider itself confirmed.
   *
   * Only ever the caller's own row, and only for a subscription the provider
   * already agreed is no longer enabled for them — so this cannot be used to
   * remove anyone else from an audience. Silent when the row is unknown or has
   * moved on: the device may never have registered, a newer registration is not
   * this logout's to undo, and a logout must not fail over bookkeeping.
   *
   * The fence advances whatever the row says. Fence before row is the order every
   * ownership write takes (ADR-0037), and it is what stops a registration verified
   * before this logout from creating the row after it.
   */
  private async revoke(actor: Actor, subscriptionId: string, seen: OwnershipRead): Promise<void> {
    const userId = requireUser(actor);
    const f = schema.pushSubscriptionFences;
    const p = schema.pushSubscriptions;
    const revoked = await this.db.transaction(async (tx) => {
      await tx
        .insert(f)
        .values({ subscriptionId, generation: 1 })
        .onConflictDoUpdate({
          target: f.subscriptionId,
          set: { generation: sql`${f.generation} + 1`, updatedAt: sql`now()` },
        });
      if (seen.revision === null || seen.rowId === null) return [];
      // An already revoked row advances too: a registration verified before this
      // logout read the same revision, and would otherwise clear `revoked_at`.
      return tx
        .update(p)
        .set({ revokedAt: sql`coalesce(${p.revokedAt}, now())`, revision: sql`${p.revision} + 1` })
        .where(and(eq(p.id, seen.rowId), eq(p.userId, userId), eq(p.revision, seen.revision)))
        .returning({ id: p.id });
    });
    // Only a row this logout took out of the audience. The compare-and-set makes
    // `seen.live` the state it acted on, and an already revoked row advances too.
    if (revoked.length > 0 && seen.live) {
      this.metrics.increment('push_subscription_registrations_total', { result: 'revoked' });
    }
  }
}
