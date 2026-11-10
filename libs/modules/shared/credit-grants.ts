import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import {
  CREDIT_SEEDS,
  type CreditExec,
  type CreditRule,
  lockSyncCreditRules,
} from './credit-catalogue';
import { CreditCandidateChanged, lockCreditRecipients } from './credit-event-protocol';

export type LegacyCreditRow = {
  id: string;
  user_id: string | null;
  delta: number;
  submission_id: string;
  venue_identity: string;
  credit_event_id: string | null;
};
export function legacyCreditEntitlements(row: LegacyCreditRow): { eventId: string; key: string }[] {
  if (![20, 50, 70].includes(row.delta) || !row.submission_id || !row.venue_identity)
    throw new Error('Unsupported legacy credit row');
  const keys: { eventId: string; key: string }[] = [
    { eventId: CREDIT_SEEDS[0].id, key: `venue:${row.venue_identity}` },
  ];
  if (row.delta === 20 || row.delta === 70)
    keys.push({ eventId: CREDIT_SEEDS[1].id, key: `submission:${row.submission_id}` });
  return keys;
}
export async function discoverLegacyCredits(
  tx: CreditExec,
  submissionId: string,
  venueIdentity: string,
): Promise<LegacyCreditRow[]> {
  const result =
    await tx.execute(sql`select id,user_id,delta,submission_id,venue_identity,credit_event_id
    from assistant_credit_ledger where reason='submission_approved'
    and (submission_id=${submissionId}::uuid or venue_identity=${venueIdentity}) order by id`);
  return result.rows as LegacyCreditRow[];
}
/** Rules and all discovered accounts already held. Never change historical deltas. */
export async function attributeLegacyCredit(tx: CreditExec, row: LegacyCreditRow): Promise<void> {
  const keys = legacyCreditEntitlements(row);
  for (const key of keys) {
    await tx.execute(sql`insert into credit_entitlements(event_id,key,ledger_id)
      values(${key.eventId}::uuid,${key.key},${row.id}::uuid) on conflict(event_id,key) do nothing`);
  }
  if (!row.credit_event_id) {
    const updated =
      await tx.execute(sql`update assistant_credit_ledger set credit_event_id=${CREDIT_SEEDS[0].id}::uuid,
      entitlement_key=${keys[0]!.key} where id=${row.id}::uuid and credit_event_id is null returning id`);
    if (updated.rows.length) {
      await tx.execute(
        sql`update credit_events set budget_used=budget_used+${row.delta === 20 ? 0 : 50} where id=${CREDIT_SEEDS[0].id}::uuid`,
      );
      if (row.delta !== 50)
        await tx.execute(
          sql`update credit_events set budget_used=budget_used+20 where id=${CREDIT_SEEDS[1].id}::uuid`,
        );
    }
  }
}

export async function reserveCreditBudget(
  tx: CreditExec,
  rule: CreditRule,
  required: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(required) || required <= 0)
    throw new Error('Invalid credit reservation');
  const result = await tx.execute(sql`update credit_events set budget_used=budget_used+${required},
    status=case when budget_total is not null and budget_used+${required}=budget_total then 'closed' else status end,
    closed_reason=case when budget_total is not null and budget_used+${required}=budget_total then 'budget_exhausted' else closed_reason end,
    updated_at=clock_timestamp()
    where id=${rule.id}::uuid and status='active' and (budget_total is null or budget_used::bigint+${required}<=budget_total)
    returning id`);
  return result.rows.length > 0;
}
/** No ON CONFLICT: an unexpected collision must roll back budget, balance AND ack. */
export async function writeCatalogueGrant(
  tx: CreditExec,
  rule: CreditRule,
  userId: string,
  key: string,
  options: {
    groupGrantId?: string;
    groupSourceKey?: string;
    submissionId?: string;
    venueIdentity?: string;
  } = {},
): Promise<string> {
  const ledgerId = randomUUID();
  try {
    await tx.execute(sql`insert into assistant_credit_ledger(id,user_id,delta,reason,credit_event_id,entitlement_key,group_grant_id,group_source_key,submission_id,venue_identity)
    values(${ledgerId}::uuid,${userId}::uuid,${rule.amount},${rule.key},${rule.id}::uuid,${key},${options.groupGrantId ?? null}::uuid,${options.groupSourceKey ?? null},
      ${options.submissionId ?? null}::uuid,${options.venueIdentity ?? null})`);
  } catch (error) {
    const pgError = error as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    const cause = pgError.cause ?? pgError;
    if (
      cause.code === '23505' &&
      ['assistant_credit_submission_unique', 'assistant_credit_venue_unique'].includes(
        cause.constraint ?? '',
      )
    )
      throw new CreditCandidateChanged();
    throw error;
  }
  await tx.execute(
    sql`insert into credit_entitlements(event_id,key,ledger_id) values(${rule.id}::uuid,${key},${ledgerId}::uuid)`,
  );
  await tx.execute(sql`insert into assistant_credit_accounts(user_id,balance) values(${userId}::uuid,${rule.amount})
    on conflict(user_id) do update set balance=assistant_credit_accounts.balance+${rule.amount}`);
  await tx.execute(sql`insert into audit_logs(actor_type,action,resource_type,resource_id,diff)
    values('system','credit.granted','assistant_credit_ledger',${ledgerId},'{}'::jsonb)`);
  return ledgerId;
}

/** One separately committed, bounded batch. Discovery never locks ledger/outbox first. */
export async function attributeLegacyCreditBatch(
  db: Pick<Db, 'execute' | 'transaction'>,
  limit = 1000,
): Promise<{ updated: number; remaining: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Batch limit must be 1..1000');
  const updated = await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout='5s'`);
    await tx.execute(sql`set local statement_timeout='30s'`);
    await lockSyncCreditRules(tx);
    const discovered = await tx.execute(sql`select id,user_id from assistant_credit_ledger
      where reason='submission_approved' and credit_event_id is null order by id limit ${limit}`);
    const rows = discovered.rows as { id: string; user_id: string | null }[];
    if (!rows.length) return 0;
    await lockCreditRecipients(
      tx,
      rows.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    );
    const current =
      await tx.execute(sql`select id,user_id,delta,submission_id,venue_identity,credit_event_id from assistant_credit_ledger
      where id in (${sql.join(
        rows.map((r) => sql`${r.id}::uuid`),
        sql`, `,
      )}) and credit_event_id is null order by id`);
    const locked = new Set(rows.map((r) => r.user_id));
    for (const row of current.rows as LegacyCreditRow[]) {
      if (row.user_id && !locked.has(row.user_id)) throw new CreditCandidateChanged();
      await attributeLegacyCredit(tx, row);
    }
    return current.rows.length;
  });
  const result = await db.execute(
    sql`select count(*)::int as n from assistant_credit_ledger where reason='submission_approved' and credit_event_id is null`,
  );
  return { updated, remaining: Number((result.rows[0] as { n: number }).n) };
}
