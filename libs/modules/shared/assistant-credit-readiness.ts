import { sql } from 'drizzle-orm';
import { AppError } from './app-error';
import { assertCreditIndexes, type CreditExec } from './credit-catalogue';
export const ASSISTANT_CREDIT_INDEXES = [
  {
    name: 'assistant_credit_usage_revision_unique',
    table: 'assistant_credit_ledger',
    keys: ['usage_ledger_id', 'cost_revision'],
    unique: true,
    predicate: 'usage_ledger_idISNOTNULLANDcost_revisionISNOTNULL',
  },
  {
    name: 'assistant_credit_turns_held',
    table: 'assistant_credit_turns',
    keys: ['user_id'],
    unique: false,
    predicate: 'held_credits>0',
  },
  {
    name: 'assistant_credit_turns_reconcile',
    table: 'assistant_credit_turns',
    keys: ['state', 'next_reconcile_at'],
    unique: false,
  },
  {
    name: 'assistant_credit_turns_conversation',
    table: 'assistant_credit_turns',
    keys: ['user_id', 'conversation_id', 'accepted_at', 'usage_ledger_id'],
    unique: false,
  },
  {
    name: 'assistant_usage_calls_receipt_unique',
    table: 'assistant_usage_calls',
    keys: ['provider', 'usage_ledger_id', 'call_index', 'receipt_fingerprint'],
    unique: true,
    predicate: 'receipt_fingerprintISNOTNULL',
  },
] as const;
export async function assertAssistantCreditSpendReady(db: CreditExec): Promise<void> {
  await assertCreditIndexes(db, ASSISTANT_CREDIT_INDEXES);
  const c = await db.execute(
    sql`select singleton from assistant_credit_spend_control where singleton=true`,
  );
  if (!c.rows.length)
    throw AppError.serviceUnavailable('ASSISTANT_DISABLED', 'Spend policy unavailable', false);
  await db.execute(sql`select u.billing_policy,u.billing_epoch,u.cost_revision,u.dispatch_closed_at,u.cost_finalized_at,
   l.cost_revision,t.reserved_ceiling,t.held_credits,t.applied_credits,t.policy_epoch,t.applied_cost_revision,
   c.dispatch_state,c.direct_cost_usd,c.upstream_cost_usd,c.fee_cost_usd,c.receipt_revision
  from assistant_usage_ledger u cross join assistant_credit_ledger l cross join assistant_credit_turns t cross join assistant_usage_calls c limit 0`);
}
