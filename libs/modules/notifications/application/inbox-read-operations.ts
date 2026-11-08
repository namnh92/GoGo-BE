import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { Tx } from '../../shared/outbox';

export type ReadOperationRow = {
  id: string;
  user_id: string;
  cutoff: string;
  action_at: Date | string;
  status: 'running' | 'completed';
  changed_count: string;
};
export function readOperationDto(row: ReadOperationRow) {
  return {
    operationId: row.id,
    status: row.status,
    asOf: new Date(row.action_at).toISOString(),
    changedCount: Number(row.changed_count),
  };
}

/** Caller holds the operation row lock. At most 500 notification writes/tx.
 * Row locks + unread predicate make concurrent single/bulk reads count once.
 */
export async function advanceReadOperation(tx: Tx, row: ReadOperationRow) {
  if (row.status === 'completed') return row;
  const changed = await tx.execute<{ count: number }>(sql`
    with batch as (
      select id from notifications
      where user_id = ${row.user_id}::uuid and inbox_sequence <= ${row.cutoff}::bigint and read_at is null
      order by inbox_sequence limit 500 for update
    ), changed as (
      update notifications n set read_at = ${new Date(row.action_at).toISOString()}::timestamptz
      from batch b where n.id = b.id and n.read_at is null returning n.id
    ) select count(*)::int as count from changed
  `);
  const result = await tx.execute<ReadOperationRow>(sql`
    update notification_read_operations o set
      changed_count = changed_count + ${changed.rows[0]!.count},
      status = case when exists (
        select 1 from notifications n where n.user_id = o.user_id
          and n.inbox_sequence <= o.cutoff and n.read_at is null
      ) then 'running' else 'completed' end
    where id = ${row.id}::uuid returning *
  `);
  return result.rows[0]!;
}

/** Durable polling: no in-memory queue/progress. Each tick is bounded to 10 tx. */
export class InboxReadAllWorker {
  constructor(
    private readonly db: Db,
    private readonly metrics?: {
      increment(name: string, labels?: Record<string, string>, by?: number): void;
    },
  ) {}
  async runTick(): Promise<number> {
    let handled = 0;
    for (let i = 0; i < 10; i++) {
      const progress = await this.db.transaction(async (tx) => {
        const { rows } = await tx.execute<ReadOperationRow>(sql`
          select * from notification_read_operations where status = 'running'
          order by action_at, id limit 1 for update skip locked
        `);
        const row = rows[0];
        if (!row) return null;
        const next = await advanceReadOperation(tx, row);
        return {
          changed: Number(next.changed_count) - Number(row.changed_count),
          status: next.status,
        };
      });
      if (!progress) break;
      handled++;
      this.metrics?.increment('notification_read_all_batches_total', { status: progress.status });
      this.metrics?.increment('notification_read_all_changed_total', {}, progress.changed);
    }
    return handled;
  }
}
