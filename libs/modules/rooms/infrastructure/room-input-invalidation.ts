import { eq, sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import type { Tx } from '../../shared/outbox';
import { syncReminderSchedule } from '../../shared/reminder-schedule';

/** Caller holds the room lock and writes the new constraint revision in this transaction. */
export async function invalidateRoomInputs(tx: Tx, roomId: string): Promise<void> {
  await tx
    .update(schema.candidateScores)
    .set({ isStale: true })
    .where(eq(schema.candidateScores.roomId, roomId));
  await tx
    .update(schema.plans)
    .set({ isStale: true, updatedAt: sql`now()` })
    .where(eq(schema.plans.roomId, roomId));
  await syncReminderSchedule(tx, roomId);
}
