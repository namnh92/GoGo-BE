import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from './app-error';

type Exec = Pick<Db, 'execute'>;

/** Shared by sends, grants and erasure. Always before budget/user-row locks. */
export async function lockAssistantAccount(tx: Exec, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:${userId}`}, 0))`,
  );
}

export async function creditBalance(exec: Exec, userId: string): Promise<number> {
  const result = await exec.execute(
    sql`select balance from assistant_credit_accounts where user_id = ${userId}`,
  );
  return Number((result.rows[0] as { balance: number } | undefined)?.balance ?? 0);
}

/** Caller holds account lock; source uniqueness survives source deletion. */
export async function grantSubmissionCredits(
  tx: Exec,
  userId: string,
  submissionId: string,
  venueIdentity: string,
  approvedMenuBillPhotoCount = 0,
  grantBase = true,
): Promise<void> {
  const delta = (grantBase ? 50 : 0) + (approvedMenuBillPhotoCount > 0 ? 20 : 0);
  if (!delta) return;
  await lockAssistantAccount(tx, userId);
  const active = await tx.execute(
    sql`select id from users where id = ${userId} and status = 'active' for share`,
  );
  if (!active.rows.length)
    throw AppError.conflict('CONTRIBUTOR_UNAVAILABLE', 'Contributor account is unavailable');
  const grant =
    await tx.execute(sql`insert into assistant_credit_ledger(user_id,delta,reason,submission_id,venue_identity)
    values (${userId},${delta},'submission_approved',${submissionId},${venueIdentity}) on conflict do nothing returning id`);
  if (grant.rows.length) {
    await tx.execute(sql`insert into assistant_credit_accounts(user_id,balance) values (${userId},${delta})
      on conflict (user_id) do update set balance = assistant_credit_accounts.balance + ${delta}`);
  }
}

/** Called once after usage reservation, inside the same transaction and account lock. */
export async function spendAssistantCredit(
  tx: Exec,
  userId: string,
  usageLedgerId: string,
): Promise<void> {
  const inserted =
    await tx.execute(sql`insert into assistant_credit_ledger(user_id,delta,reason,usage_ledger_id)
    values (${userId},-1,'message_spent',${usageLedgerId}) on conflict do nothing returning id`);
  if (!inserted.rows.length) return;
  const debit = await tx.execute(sql`update assistant_credit_accounts set balance=balance-1
    where user_id=${userId} and balance>0 returning balance`);
  if (!debit.rows.length)
    throw AppError.conflict('CREDIT_BALANCE_CHANGED', 'Credit balance changed');
}
