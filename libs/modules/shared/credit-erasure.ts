import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { CreditExec } from './credit-catalogue';

/** Caller holds the account lock. One random map for ALL subject-key copies. */
export async function eraseCreditSubjectKeys(tx: CreditExec, userId: string): Promise<void> {
  const result = await tx.execute(sql`select distinct e.key from credit_entitlements e
    join assistant_credit_ledger l on l.id=e.ledger_id join credit_events c on c.id=e.event_id
    where l.user_id=${userId}::uuid and (c.dedup_scope in ('per_subject','per_place_subject','per_occurrence')
      or (c.dedup_scope='per_source' and c.audience='group'))
    union select distinct l.entitlement_key as key from assistant_credit_ledger l
    join credit_events c on c.id=l.credit_event_id where l.user_id=${userId}::uuid and l.entitlement_key is not null
      and (c.dedup_scope in ('per_subject','per_place_subject','per_occurrence') or (c.dedup_scope='per_source' and c.audience='group'))`);
  const map = new Map(
    (result.rows as { key: string }[]).map((r) => [r.key, `erased:${randomUUID()}`]),
  );
  for (const [key, tombstone] of map) {
    await tx.execute(sql`update credit_entitlements set key=${tombstone} where key=${key}`);
    await tx.execute(
      sql`update assistant_credit_ledger set entitlement_key=${tombstone} where entitlement_key=${key}`,
    );
  }
}
