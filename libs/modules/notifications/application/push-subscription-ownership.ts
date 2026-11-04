import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DEVICE_CLEANUP_DELAY_SECONDS } from '../domain/device-identity';

/**
 * ADR-0037, ADR-0038 — the one protocol every ownership write of a push
 * subscription follows, for a user and for a device alike.
 *
 * Lock order, in every transaction that takes more than one: identity row
 * (`for update`) → fence → subscription row. Identities in id order, so two
 * transactions naming the same pair cannot deadlock.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Pick<Db, 'execute'>;

export type SubscriptionOwner =
  { kind: 'user'; userId: string } | { kind: 'device'; deviceId: string };

/**
 * What an ownership write saw before it asked the provider. The provider call
 * holds no lock, so the write proves nothing changed meanwhile by comparing
 * against this: a row by its revision, an absent row by the generation of its
 * fence.
 */
export type OwnershipRead = {
  /** Null when no row exists for this subscription id. */
  revision: number | null;
  /** Zero when no fence exists: nothing has logged out of an absent row yet. */
  fenceGeneration: number;
  /** The device identity owning the row at `revision`; a takeover retires it. */
  deviceId: string | null;
  /** False for a row already revoked at `revision`, or no row. */
  live: boolean;
};

export async function readOwnership(db: Exec, subscriptionId: string): Promise<OwnershipRead> {
  // One statement, so the row and the fence come from one snapshot.
  const result = await db.execute<{
    revision: number | null;
    device_id: string | null;
    live: boolean | null;
    generation: number | null;
  }>(sql`
    select r.revision, r.device_id, r.live,
      (select generation from push_subscription_fences where subscription_id = ${subscriptionId}) as generation
    from (select 1) one
    left join (
      select revision, device_id, revoked_at is null as live
      from push_subscriptions where subscription_id = ${subscriptionId}
    ) r on true
  `);
  const row = result.rows[0];
  return {
    revision: row?.revision ?? null,
    fenceGeneration: row?.generation ?? 0,
    deviceId: row?.device_id ?? null,
    live: row?.live === true,
  };
}

export type ClaimedRow = { platform: 'ios' | 'android' | 'web'; lastConfirmedAt: Date };

/** The write a verification was for. Undefined when what it saw no longer holds. */
export async function claimOwnership(
  tx: Tx,
  input: {
    subscriptionId: string;
    platform: ClaimedRow['platform'];
    owner: SubscriptionOwner;
  },
  seen: OwnershipRead,
): Promise<ClaimedRow | undefined> {
  const f = schema.pushSubscriptionFences;
  const p = schema.pushSubscriptions;
  const written = { platform: p.platform, lastConfirmedAt: p.lastConfirmedAt };
  const { subscriptionId, platform, owner } = input;
  const ownerColumns =
    owner.kind === 'user'
      ? { ownerKind: 'user' as const, userId: owner.userId, deviceId: null }
      : { ownerKind: 'device' as const, userId: null, deviceId: owner.deviceId };

  if (seen.revision !== null) {
    const [row] = await tx
      .update(p)
      .set({
        ...ownerColumns,
        platform,
        lastConfirmedAt: sql`now()`,
        // A device that reports again is subscribed again, whatever an
        // earlier logout recorded.
        revokedAt: null,
        revision: sql`${p.revision} + 1`,
      })
      .where(and(eq(p.subscriptionId, subscriptionId), eq(p.revision, seen.revision)))
      .returning(written);
    return row;
  }

  // Touching the fence takes its row lock, which a logout holds until it
  // commits. Comparing a plain read instead would leave a gap between this
  // statement's snapshot and the logout's commit for the row to land in.
  const [fence] = await tx
    .insert(f)
    .values({ subscriptionId })
    .onConflictDoUpdate({
      target: f.subscriptionId,
      set: { generation: sql`${f.generation}` },
    })
    .returning({ generation: f.generation });
  if (fence!.generation !== seen.fenceGeneration) return undefined;
  const [row] = await tx
    .insert(p)
    .values({ ...ownerColumns, platform, subscriptionId })
    .onConflictDoNothing({ target: p.subscriptionId })
    .returning(written);
  return row;
}

/** Takes the identity rows' locks, first in every multi-row ownership transaction. */
export async function lockIdentities(tx: Tx, deviceIds: string[]) {
  const rows = [];
  for (const id of [...new Set(deviceIds)].sort()) {
    const result = await tx.execute<{
      id: string;
      secret_hash: string;
      revoked_at: Date | string | null;
      promotions_enabled: boolean | null;
      preference_version: number;
    }>(sql`
      select id, secret_hash, revoked_at, promotions_enabled, preference_version
      from push_device_identities where id = ${id}::uuid for update
    `);
    if (result.rows[0]) rows.push(result.rows[0]);
  }
  return rows;
}

/**
 * Retires identities the caller already holds the lock on: revoked, every row
 * they still own revoked with them, provider cleanup queued. An identity already
 * retired keeps its dates.
 */
export async function retireIdentities(tx: Tx, deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  const d = schema.pushDeviceIdentities;
  const p = schema.pushSubscriptions;
  await tx
    .update(d)
    .set({
      revokedAt: sql`coalesce(${d.revokedAt}, now())`,
      cleanupState: sql`case when ${d.cleanupState} = 'none' then 'pending'::push_device_cleanup_state else ${d.cleanupState} end`,
      cleanupNextAt: sql`case when ${d.cleanupState} = 'none'
        then now() + make_interval(secs => ${DEVICE_CLEANUP_DELAY_SECONDS})
        else ${d.cleanupNextAt} end`,
    })
    .where(inArray(d.id, deviceIds));
  await tx
    .update(p)
    .set({ revokedAt: sql`coalesce(${p.revokedAt}, now())`, revision: sql`${p.revision} + 1` })
    .where(and(inArray(p.deviceId, deviceIds), ne(p.ownerKind, 'user')));
}
