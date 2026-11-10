import { sql } from 'drizzle-orm';
import type { Tx } from '../../shared/outbox';
import { CreditCandidateChanged } from '../../shared/credit-event-protocol';

type Member = { user_id: string | null; member_id: string; role: string };

/** Discovery is intentionally unlocked; final membership is re-read under the room lock. */
export async function discoverRoomCreditAccounts(tx: Tx, roomId: string): Promise<string[]> {
  const result = await tx.execute(sql`select distinct user_id from room_members
    where room_id = ${roomId} and removed_at is null and user_id is not null`);
  return (result.rows as { user_id: string }[]).map((r) => r.user_id);
}

/** Caller holds the room FOR UPDATE and every discovered account until commit. */
export async function captureRoomCreditSnapshot(
  tx: Tx,
  roomId: string,
  discovered: readonly string[],
  active: ReadonlySet<string>,
) {
  const result = await tx.execute(sql`
    select clock_timestamp() as triggered_at,
      (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id,
        'member_id', m.id, 'role', m.role) order by m.id), '[]'::jsonb)
       from room_members m where m.room_id = ${roomId} and m.removed_at is null) as members,
      (select count(*)::int from plan_stops s where s.status = 'completed' and s.plan_id =
        (select p.id from plans p where p.room_id = ${roomId} and p.status = 'current' limit 1)) as stops_completed`);
  const row = result.rows[0] as {
    triggered_at: Date | string;
    members: Member[];
    stops_completed: number;
  };
  const held = new Set(discovered);
  if (row.members.some((m) => m.user_id !== null && !held.has(m.user_id)))
    throw new CreditCandidateChanged();
  return {
    triggeredAt: new Date(row.triggered_at).toISOString(),
    participantCount: row.members.length,
    plan: { stopsCompleted: row.stops_completed },
    subjects: row.members
      .filter((m) => m.user_id !== null && active.has(m.user_id))
      .map((m) => ({ userId: m.user_id!, memberId: m.member_id, role: m.role })),
  };
}
