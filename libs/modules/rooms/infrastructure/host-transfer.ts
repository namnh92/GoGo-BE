import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { lockAssistantAccount } from '../../shared/assistant-credits';
import { CreditCandidateChanged, retryCreditDiscovery } from '../../shared/credit-event-protocol';
import {
  beginIdempotent,
  completeIdempotentWithin,
  type IdempotencyScope,
} from '../../shared/idempotency.interceptor';
import { writeOutbox } from '../../shared/outbox';
import { writeAudit } from '../../shared/audit';
import { currentRequestContext } from '../../shared/request-context';
import { requireHostWithin } from '../domain/host-authority';
import { assertRoomDetailsEditable } from '../domain/room-state';

export type TransferRoomHostRequest = { memberId: string; expectedHostVersion: number };
export type TransferRoomHostResult = {
  transferId: string;
  roomId: string;
  previousHostMemberId: string;
  hostMemberId: string;
  hostVersion: number;
  transferredAt: string;
};

/** SQLSTATE may be wrapped by Drizzle. Never expose driver errors to the caller. */
function lockTimeout(error: unknown): boolean {
  for (let e = error; e; e = (e as { cause?: unknown }).cause)
    if ((e as { code?: string }).code === '55P03') return true;
  return false;
}

export async function transferRoomHost(
  db: Db,
  actor: Actor,
  roomId: string,
  input: TransferRoomHostRequest,
  scope: IdempotencyScope,
): Promise<{ body: TransferRoomHostResult; replay: boolean }> {
  try {
    return await retryCreditDiscovery(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        // This claim, the mutation and its receipt share a commit. A competing
        // INSERT waits for this transaction, then sees its completed receipt.
        const begun = await beginIdempotent(tx, scope);
        if (begun.kind === 'replay')
          return { body: begun.body as TransferRoomHostResult, replay: true };
        // Discovery grants no authority. Re-discover after rollback if identity changed.
        const [discovered] = await tx
          .select()
          .from(schema.roomMembers)
          .where(
            and(eq(schema.roomMembers.id, input.memberId), eq(schema.roomMembers.roomId, roomId)),
          );
        const accounts = [
          ...new Set([
            ...(actor.type === 'user' ? [actor.id] : []),
            ...(discovered?.userId ? [discovered.userId] : []),
          ]),
        ].sort();
        for (const id of accounts) await lockAssistantAccount(tx, id);
        const users = accounts.length
          ? await tx
              .select()
              .from(schema.users)
              .where(
                sql`${schema.users.id} in (${sql.join(
                  accounts.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})`,
              )
              .orderBy(asc(schema.users.id))
              .for('share')
          : [];
        if (actor.type === 'user' && !users.some((u) => u.id === actor.id && u.status === 'active'))
          throw AppError.unauthorized('SESSION_REVOKED', 'Session is no longer valid');
        const [room] = await tx
          .select()
          .from(schema.rooms)
          .where(eq(schema.rooms.id, roomId))
          .for('update');
        if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'Room not found');
        // Active membership check comes before state/target/readiness, even for guests.
        const identity =
          actor.type === 'user'
            ? eq(schema.roomMembers.userId, actor.id)
            : eq(schema.roomMembers.guestSessionId, actor.id);
        const [me] = await tx
          .select()
          .from(schema.roomMembers)
          .where(and(eq(schema.roomMembers.roomId, roomId), identity, sql`removed_at is null`));
        await requireHostWithin(tx, room, {
          kind: 'host',
          actor,
          memberId: me?.id ?? '',
          hostVersion: input.expectedHostVersion,
        });
        assertRoomDetailsEditable(room.status);
        const clock = await tx.execute<{ checked_at: Date }>(
          sql`select clock_timestamp() as checked_at`,
        );
        const at = new Date(clock.rows[0]!.checked_at);
        if (room.expiresAt && room.expiresAt <= at)
          throw AppError.gone('ROOM_EXPIRED', 'Room has expired');
        const members = await tx
          .select()
          .from(schema.roomMembers)
          .where(
            and(
              eq(schema.roomMembers.roomId, roomId),
              sql`${schema.roomMembers.id} in (${me!.id}::uuid, ${input.memberId}::uuid)`,
            ),
          )
          .orderBy(asc(schema.roomMembers.id))
          .for('update');
        const target = members.find((m) => m.id === input.memberId);
        if (!target || target.removedAt)
          throw AppError.notFound('MEMBER_NOT_FOUND', 'Member not found');
        if (target.id === me!.id)
          throw AppError.conflict('CANNOT_TRANSFER_TO_SELF', 'Choose another member');
        if (
          target.userId !== discovered?.userId ||
          target.guestSessionId !== discovered?.guestSessionId
        )
          throw new CreditCandidateChanged();
        if (
          !target.userId ||
          target.guestSessionId ||
          target.role !== 'member' ||
          !users.some((u) => u.id === target.userId && u.status === 'active')
        )
          throw AppError.conflict(
            'HOST_TRANSFER_TARGET_INELIGIBLE',
            'Target must be an active user member',
          );
        await tx.execute(
          sql`select singleton from room_host_transfer_rollout where singleton for share`,
        );
        const ready = await tx.execute<{ ready: boolean }>(
          sql`select room_host_transfer_ready() as ready`,
        );
        if (!ready.rows[0]?.ready)
          throw AppError.serviceUnavailable(
            'ROOM_HOST_TRANSFER_UNAVAILABLE',
            'Host transfer is not activated or ready',
            false,
          );
        await tx
          .update(schema.roomMembers)
          .set({ role: 'member' })
          .where(eq(schema.roomMembers.id, me!.id));
        await tx
          .update(schema.roomMembers)
          .set({ role: 'host' })
          .where(eq(schema.roomMembers.id, target.id));
        const hostVersion = room.hostVersion + 1;
        await tx
          .update(schema.rooms)
          .set({ hostUserId: target.userId, hostVersion, updatedAt: at })
          .where(eq(schema.rooms.id, roomId));
        const transferId = await writeOutbox(tx, {
          eventType: 'room.host_transferred',
          resourceType: 'room',
          resourceId: roomId,
          occurredAt: at,
          actorId: users.find((u) => u.id === actor.id)?.analyticsId,
          correlationId: currentRequestContext().requestId,
          payload: { previousHostMemberId: me!.id, newHostMemberId: target.id, hostVersion },
        });
        await writeAudit(tx, {
          actorType: 'user',
          actorId: actor.id,
          action: 'room.host_transferred',
          resourceType: 'room',
          resourceId: roomId,
          diff: {
            before: { hostMemberId: me!.id, hostVersion: room.hostVersion },
            after: { hostMemberId: target.id, hostVersion },
          },
        });
        const body: TransferRoomHostResult = {
          transferId,
          roomId,
          previousHostMemberId: me!.id,
          hostMemberId: target.id,
          hostVersion,
          transferredAt: at.toISOString(),
        };
        if (!(await completeIdempotentWithin(tx, begun.claim, 200, body)))
          throw AppError.internal('Transfer receipt could not be completed');
        return { body, replay: false };
      }),
    );
  } catch (error) {
    if (
      lockTimeout(error) ||
      (error instanceof AppError && error.code === 'IDEMPOTENT_REQUEST_IN_FLIGHT')
    )
      throw new AppError(
        'IDEMPOTENT_REQUEST_IN_FLIGHT',
        'Operation is busy; retry with the same key',
        409,
        { retryable: true, retryAfterSeconds: 1 },
      );
    throw error;
  }
}
