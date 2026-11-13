import {
  InviteTtlSettingUnavailable,
  isTransientInviteStorageError,
  readInviteTtlWithin,
} from '../../shared/invite-ttl';
import { randomUUID } from 'node:crypto';
import type { Db } from '@gogo/database';
import { schema } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import { NoopMetrics } from '@gogo/observability';
import { sql } from 'drizzle-orm';
import { type InviteCodeCrypto, InviteFoundationError } from '../application/invite-code-crypto';
import { assertInviteFoundationReady } from './invite-foundation-readiness';

export type InviteTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
export type AllocateInviteCode = {
  roomId: string;
  actorUserId: string;
  expectedInvitationEpoch: bigint;
  reissueAfterRevocation?: boolean;
  automatic?: boolean;
};
const MAX_ATTEMPTS = 20;

/**
 * I03 internal storage primitive only. No Nest provider/controller or scheduled caller.
 * Future caller reserves exposure BEFORE opening tx (I06), and commits audit/completion
 * with this insert (I08). Never call a security store/provider while tx is held.
 */
export class InviteCodeReservations {
  constructor(
    private readonly crypto: InviteCodeCrypto,
    private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async allocate(tx: InviteTransaction, input: AllocateInviteCode) {
    await assertInviteFoundationReady(tx, this.metrics);
    try {
      // Room first. Never lock a conflicting code's room, even for cleanup.
      const room = await tx.execute<{
        invitation_epoch: string;
        automatic_invites_suppressed: boolean;
        code6_backfill_completed_at: string | null;
        expires_at: string | null;
        eligible: boolean;
      }>(sql`select invitation_epoch,automatic_invites_suppressed,code6_backfill_completed_at,expires_at,
        status in ('draft','collecting','matching','ready') as eligible
        from rooms where id=${input.roomId} for update`);
      const r = room.rows[0];
      if (!r || !r.eligible) throw new InviteFoundationError('ROOM_NOT_ELIGIBLE');
      const host = await tx.execute<{
        id: string;
      }>(sql`select id from room_members where room_id=${input.roomId}
        and user_id=${input.actorUserId} and role='host' and removed_at is null`);
      if (!host.rows[0]) throw new InviteFoundationError('HOST_REQUIRED');
      if (BigInt(r.invitation_epoch) !== input.expectedInvitationEpoch)
        throw new InviteFoundationError('INVITATION_STATE_CHANGED');
      if (input.automatic && (r.automatic_invites_suppressed || r.code6_backfill_completed_at))
        throw new InviteFoundationError('AUTOMATIC_ISSUANCE_SUPPRESSED');
      if (r.automatic_invites_suppressed && !input.reissueAfterRevocation)
        throw new InviteFoundationError('INVITATIONS_REISSUE_REQUIRED');
      const { ttlSeconds, issuedAt } = await readInviteTtlWithin(tx, 'code6', this.metrics);
      const roomExpiresAt = r.expires_at ? new Date(r.expires_at) : null;
      const expiresAt = new Date(
        Math.min(
          issuedAt.getTime() + ttlSeconds * 1000,
          issuedAt.getTime() + 172800 * 1000,
          roomExpiresAt?.getTime() ?? Infinity,
        ),
      );
      if (expiresAt <= issuedAt) throw new InviteFoundationError('ROOM_NOT_ELIGIBLE');
      const history = await tx.execute<{ reservation_state: string }>(
        sql`select reservation_state from room_invite_codes where room_id=${input.roomId}`,
      );
      if (history.rows.some((row) => row.reservation_state === 'OPEN'))
        throw new InviteFoundationError('OPEN_GENERATION_EXISTS');
      if (input.automatic && history.rows.length)
        throw new InviteFoundationError('AUTOMATIC_ISSUANCE_SUPPRESSED');
      if (input.automatic) {
        const oldRevocations = await tx.execute<{ suppressed: boolean }>(sql`select
          exists(select 1 from room_invites where room_id=${input.roomId} and revoked_at is not null)
          and not exists(select 1 from room_invites where room_id=${input.roomId} and revoked_at is null
            and expires_at>${issuedAt} and (max_uses is null or use_count<max_uses)) as suppressed`);
        if (oldRevocations.rows[0]?.suppressed)
          throw new InviteFoundationError('AUTOMATIC_ISSUANCE_SUPPRESSED');
      }
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const id = randomUUID();
        const code = this.crypto.generateCode();
        const encrypted = this.crypto.encryptCode(code, { roomId: input.roomId, generationId: id });
        try {
          // PostgreSQL aborts a transaction after 23505. A real savepoint is required.
          await tx.transaction(async (savepoint) => {
            await savepoint.insert(schema.roomInviteCodes).values({
              id,
              roomId: input.roomId,
              invitationEpoch: input.expectedInvitationEpoch,
              codeLookup: this.crypto.lookupCode(code),
              ...encrypted,
              issuedAt,
              expiresAt,
              createdByMemberId: host.rows[0]!.id,
            });
          });
          if (input.automatic)
            await tx.execute(
              sql`update rooms set code6_backfill_completed_at=${issuedAt} where id=${input.roomId}`,
            );
          this.metrics.increment('room_invite_allocation_total', {
            operation: 'code6',
            result: 'allocated',
          });
          // Transient secret: callers must never put this object in generic replay/logs.
          return { id, code, invitationEpoch: input.expectedInvitationEpoch, issuedAt, expiresAt };
        } catch (error) {
          if (!isUniqueConstraint(error, 'room_invite_codes_open_lookup_unique')) throw error;
          this.metrics.increment('room_invite_collision_total', {
            operation: 'code6',
            result: 'retry',
          });
        }
      }
      this.metrics.increment('room_invite_allocation_total', {
        operation: 'code6',
        result: 'exhausted',
      });
      throw new InviteFoundationError('COLLISIONS_EXHAUSTED');
    } catch (error) {
      if (isTransientInviteStorageError(error)) throw new InviteTtlSettingUnavailable('db_error');
      throw safeStorageError(error);
    }
  }

  /** Lazy alias allocation is independent of CODE6 capacity and room locks. */
  async allocateHostAlias(tx: InviteTransaction, userId: string): Promise<string> {
    await assertInviteFoundationReady(tx, this.metrics);
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const current = await tx.execute<{ host_share_id: string | null }>(
          sql`select host_share_id from users where id=${userId} and status<>'deleted'`,
        );
        if (!current.rows[0]) throw new InviteFoundationError('USER_NOT_FOUND');
        if (current.rows[0].host_share_id) return current.rows[0].host_share_id;
        try {
          const result = await tx.transaction(async (savepoint) =>
            savepoint.execute<{ host_share_id: string }>(sql`
            update users set host_share_id=${this.crypto.generateHostShareId()}
            where id=${userId} and host_share_id is null and status<>'deleted' returning host_share_id`),
          );
          if (result.rows[0]) {
            this.metrics.increment('room_invite_allocation_total', {
              operation: 'host_alias',
              result: 'allocated',
            });
            return result.rows[0].host_share_id;
          }
          // A concurrent transaction committed its alias. READ COMMITTED sees it here.
        } catch (error) {
          if (!isUniqueConstraint(error, 'users_host_share_id_unique')) throw error;
          this.metrics.increment('room_invite_collision_total', {
            operation: 'host_alias',
            result: 'retry',
          });
        }
      }
      this.metrics.increment('room_invite_allocation_total', {
        operation: 'host_alias',
        result: 'exhausted',
      });
      throw new InviteFoundationError('COLLISIONS_EXHAUSTED');
    } catch (error) {
      throw safeStorageError(error);
    }
  }
}
function safeStorageError(error: unknown): InviteFoundationError | InviteTtlSettingUnavailable {
  return error instanceof InviteFoundationError || error instanceof InviteTtlSettingUnavailable
    ? error
    : new InviteFoundationError('STORAGE_UNAVAILABLE');
}
function isUniqueConstraint(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  return (
    (e.code === '23505' && e.constraint === constraint) ||
    (e.cause !== undefined && isUniqueConstraint(e.cause, constraint))
  );
}
