import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from './app-error';
import { CREDIT_SEEDS, type CreditRule } from './credit-catalogue';
import {
  attributeLegacyCredit,
  discoverLegacyCredits,
  reserveCreditBudget,
  writeCatalogueGrant,
} from './credit-grants';
import { CreditCandidateChanged } from './credit-event-protocol';

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

/** The sole award formula, also used by CMS previews. */
export function submissionCreditFacts(approvedMenuBillPhotoCount = 0, grantBase = true) {
  const base = grantBase ? 50 : 0;
  const photoBonus = approvedMenuBillPhotoCount > 0 ? 10 : 0;
  return { base, photoBonus, total: base + photoBonus };
}

/** Caller holds cutover -> BOTH seeded rules -> discovered accounts -> domain.
 * Reconcile old-writer conflicts before either component can be paid. */
export async function grantSubmissionCredits(
  tx: Exec,
  userId: string,
  submissionId: string,
  venueIdentity: string,
  approvedMenuBillPhotoCount = 0,
  grantBase = true,
  lockedAccounts: ReadonlySet<string> = new Set([userId]),
): Promise<void> {
  if (!grantBase && approvedMenuBillPhotoCount === 0) return;
  const active = await tx.execute(sql`select id from users where id=${userId} and status='active'`);
  if (!active.rows.length)
    throw AppError.conflict('CONTRIBUTOR_UNAVAILABLE', 'Contributor account is unavailable');
  for (const row of await discoverLegacyCredits(tx, submissionId, venueIdentity)) {
    if (row.user_id && !lockedAccounts.has(row.user_id)) throw new CreditCandidateChanged();
    if (!row.credit_event_id) await attributeLegacyCredit(tx, row);
  }
  const result = await tx.execute(sql`select * from credit_events where id in
    (${CREDIT_SEEDS[0].id}::uuid,${CREDIT_SEEDS[1].id}::uuid)
    and starts_at<=now() and (ends_at is null or now()<ends_at) order by id`);
  for (const rule of result.rows as CreditRule[]) {
    const base = rule.id === CREDIT_SEEDS[0].id;
    if (
      (base && !grantBase) ||
      (!base && approvedMenuBillPhotoCount === 0) ||
      rule.status !== 'active'
    )
      continue;
    const key = base ? `venue:${venueIdentity}` : `submission:${submissionId}`;
    const existing = await tx.execute(
      sql`select ledger_id from credit_entitlements where event_id=${rule.id}::uuid and key=${key}`,
    );
    if (existing.rows.length) continue;
    const capped = await tx.execute(
      sql`select count(distinct e.ledger_id)::int as n from credit_entitlements e join assistant_credit_ledger l on l.id=e.ledger_id where e.event_id=${rule.id}::uuid and l.user_id=${userId}::uuid`,
    );
    if (
      rule.max_per_user !== null &&
      Number((capped.rows[0] as { n: number }).n) >= rule.max_per_user
    )
      continue;
    if (!(await reserveCreditBudget(tx, rule, rule.amount))) continue;
    await writeCatalogueGrant(tx, rule, userId, key, { submissionId, venueIdentity });
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
