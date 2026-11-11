import { eraseCreditSubjectKeys } from '../../shared/credit-erasure';
import { lockAssistantAccount } from '../../shared/assistant-credits';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { RETENTION_DAYS } from '../infrastructure/assistant.repository';
import { isoUs } from '../domain/cursor';
import { BUFFER_LIFETIME_SECONDS } from '../infrastructure/frame-buffer';
import { placeTokensAsIds } from '../domain/place-tokens';

type Exec = Pick<Db, 'execute'>;

/** The usage ledger holds money, not conversation; its rows go after this long. */
export const LEDGER_RETENTION_DAYS = 400;

/**
 * Account deletion / privacy erasure (ADR-0023 list gains "assistant
 * conversations: deleted"): hard delete, not pseudonymize. Runs inside the
 * erasure transaction. The ledger keeps its cost rows without the person.
 */
export async function eraseAssistantDataForUser(tx: Exec, userId: string): Promise<void> {
  await lockAssistantAccount(tx, userId);
  // Retained draft bytes have a durable cleanup deadline; erasure advances it.
  await tx.execute(sql`update media_cleanup_queue set next_attempt_at = now()
    where bucket = 'private' and object_key in (
      select storage_key from media_uploads where actor_type = 'user' and actor_id = ${userId}
      and attached_to_type = 'contribution_draft')`);
  await tx.execute(sql`update media_uploads set status = 'expired', expires_at = now()
    where actor_type = 'user' and actor_id = ${userId} and attached_to_type = 'contribution_draft'`);
  await tx.execute(sql`delete from place_contribution_drafts where user_id = ${userId}`);
  await tx.execute(
    sql`update place_submissions set enrichment = null where submitted_by_user_id = ${userId}`,
  );
  await tx.execute(
    sql`update place_submissions set submitted_by_user_id = null where submitted_by_user_id = ${userId}`,
  );
  await eraseCreditSubjectKeys(tx, userId);
  await tx.execute(sql`update assistant_usage_calls set provider_request_id=null,provider_generation_id=null,correlation_id=null
    where usage_ledger_id in (select id from assistant_usage_ledger where user_id=${userId})`);
  // Account -> turn -> outbox, shared with worker completion. Capture the IDs
  // before clearing ownership so all delivered/undelivered linkage is scrubbed.
  const erased =
    await tx.execute(sql`update assistant_credit_turns set user_id=null,message_id=null,conversation_id=null,
    held_credits=0,state='erased',lease_owner=null,lease_expires_at=null,next_reconcile_at=null,updated_at=now()
    where user_id=${userId} returning usage_ledger_id`);
  const usageIds = erased.rows.map((r) => (r as { usage_ledger_id: string }).usage_ledger_id);
  if (usageIds.length)
    await tx.execute(sql`update outbox_events set actor_id=null,correlation_id=null,payload='{}'::jsonb,
      resource_id='erased',published_at=coalesce(published_at,now()),last_error=null,next_attempt_at=null
      where event_type in ('assistant.cost_reconcile','assistant.credit_applied')
      and resource_id in (${sql.join(
        usageIds.map((id) => sql`${id}`),
        sql`,`,
      )})`);
  await tx.execute(sql`delete from assistant_credit_accounts where user_id = ${userId}`);
  await tx.execute(
    sql`update assistant_credit_ledger set user_id = null where user_id = ${userId}`,
  );
  // A-R-08: replies of the last hour may still sit in a live frame buffer;
  // the reaper on every instance drops them. A reply still streaming loses
  // its row here, so its runner stops at its next lease renewal.
  await tx.execute(sql`
    insert into assistant_buffer_purges (message_id)
    select id from assistant_messages
    where user_id = ${userId} and role = 'assistant'
      and created_at > now() - ${sql.raw(`interval '${BUFFER_LIFETIME_SECONDS} seconds'`)}
    on conflict do nothing`);
  await tx.execute(sql`delete from assistant_conversations where user_id = ${userId}`);
  // Send replay records hold ids only, but they are this person's too.
  await tx.execute(sql`
    delete from idempotency_keys
    where actor_id = ${`user:${userId}`} and endpoint like '% /v1/assistant/%'`);
  await tx.execute(
    sql`update assistant_usage_ledger set user_id = null,message_id=null,dispatch_closed_at=coalesce(dispatch_closed_at,now()) where user_id = ${userId}`,
  );
}

export type UserExportAssistantConversation = {
  title: string | null;
  createdAt: string;
  lastMessageAt: string;
  messages: {
    role: 'user' | 'assistant';
    status: string;
    text: string;
    createdAt: string;
    completedAt: string | null;
    feedback: { rating: 'up' | 'down'; reason?: string; createdAt: string } | null;
  }[];
};

/**
 * Q2 — `assistantConversations` in the export: titles, each message's role,
 * text, timestamps, terminal status and the account's own feedback. No
 * prompts, retrieval internals, model ids, upload keys, cards or proposals;
 * attachments excluded pending owner approval.
 */
export async function collectAssistantExport(
  exec: Exec,
  userId: string,
  charge: (value: unknown) => void,
): Promise<UserExportAssistantConversation[]> {
  const conversations = await exec.execute(sql`
    select id, title, ${sql.raw(isoUs('created_at'))} as created_at,
      ${sql.raw(isoUs('last_message_at'))} as last_message_at
    from assistant_conversations
    where user_id = ${userId} and last_message_at > now() - ${sql.raw(`interval '${RETENTION_DAYS} days'`)}
    order by created_at, id`);
  const out: UserExportAssistantConversation[] = [];
  for (const c of conversations.rows as {
    id: string;
    title: string | null;
    created_at: string;
    last_message_at: string;
  }[]) {
    const messages = await exec.execute(sql`
      select m.role, m.status, m.text, ${sql.raw(isoUs('m.created_at'))} as created_at,
        ${sql.raw(isoUs('m.completed_at'))} as completed_at,
        f.rating, f.reason, ${sql.raw(isoUs('f.created_at'))} as feedback_at
      from assistant_messages m
      left join assistant_feedback f on f.message_id = m.id and f.user_id = ${userId}
      where m.conversation_id = ${c.id}
      order by m.created_at, m.id`);
    const rows = messages.rows as {
      role: 'user' | 'assistant';
      status: string;
      text: string;
      created_at: string;
      completed_at: string | null;
      rating: 'up' | 'down' | null;
      reason: string | null;
      feedback_at: string | null;
    }[];
    // The export is stored (sealed, in R2) until it expires, so it must not
    // hold a place's name either (A-R2-03, owner decision 2026-10-27): a
    // place reads as "GoGo place" with its id, which the app resolves.
    const texts = rows.map((m) => placeTokensAsIds(m.text));
    const item: UserExportAssistantConversation = {
      title: c.title,
      createdAt: c.created_at,
      lastMessageAt: c.last_message_at,
      messages: rows.map((m, i) => ({
        role: m.role,
        status: m.status,
        text: texts[i]!,
        createdAt: m.created_at,
        completedAt: m.completed_at,
        feedback:
          m.role === 'assistant' && m.rating
            ? {
                rating: m.rating,
                ...(m.reason ? { reason: m.reason } : {}),
                createdAt: m.feedback_at!,
              }
            : null,
      })),
    };
    charge(item);
    out.push(item);
  }
  return out;
}

export type AssistantRetentionReport = {
  assistantConversationsPurged: number;
  assistantLedgerRowsPurged: number;
};

/** The daily 90-day purge (owner decision). Dry run counts without deleting. */
export async function purgeAssistantRetention(
  db: Pick<Db, 'execute' | 'transaction'>,
  dryRun: boolean,
): Promise<AssistantRetentionReport> {
  const window = sql.raw(`now() - interval '${RETENTION_DAYS} days'`);
  const ledgerWindow = sql.raw(`now() - interval '${LEDGER_RETENTION_DAYS} days'`);
  // Unknown liabilities survive the usage TTL, including free provider cost.
  const resolved = sql`not exists(select 1 from assistant_credit_billing_incidents i
    where i.usage_ledger_id=assistant_usage_ledger.id and i.resolved_at is null)
    and (coalesce(billing_policy,'legacy_allowance_v1')='legacy_allowance_v1'
      or (dispatch_closed_at is not null and cost_finalized_at is not null
        and not exists(select 1 from assistant_credit_turns t where t.usage_ledger_id=assistant_usage_ledger.id
          and (t.state in ('pending','reconciling','quarantined')
            or (t.funding_source='credit' and t.state<>'erased'
              and (t.applied_cost_revision<assistant_usage_ledger.cost_revision
                or t.applied_cost_revision<t.cost_revision))))))`;
  if (dryRun) {
    const res = await db.execute(sql`
      select
        (select count(*)::int from assistant_conversations where last_message_at <= ${window}) as conversations,
        (select count(*)::int from assistant_usage_ledger where accepted_at <= ${ledgerWindow} and ${resolved}) as ledger`);
    const row = res.rows[0] as { conversations: number; ledger: number };
    return {
      assistantConversationsPurged: row.conversations,
      assistantLedgerRowsPurged: row.ledger,
    };
  }
  const conversations = await db.execute(sql`
    delete from assistant_conversations where last_message_at <= ${window} returning id`);
  // Discover without locks, then recheck eligibility under the same account
  // lock as ingestion. Scrub and delete commit together; a correction cannot
  // land between them. One account per transaction avoids cross-account cycles.
  const candidates = await db.execute(sql`select id,user_id from assistant_usage_ledger
    where accepted_at<=${ledgerWindow} and ${resolved}`);
  let purged = 0;
  for (const candidate of candidates.rows as { id: string; user_id: string | null }[]) {
    purged += await db.transaction(async (tx) => {
      if (candidate.user_id) await lockAssistantAccount(tx, candidate.user_id);
      const eligible = await tx.execute(sql`select id from assistant_usage_ledger
        where id=${candidate.id} and user_id is not distinct from ${candidate.user_id}::uuid
        and accepted_at<=${ledgerWindow} and ${resolved} for update`);
      if (!eligible.rows.length) return 0;
      await tx.execute(sql`update assistant_usage_calls c set provider_request_id=null,provider_generation_id=null,correlation_id=null
        where usage_ledger_id=${candidate.id}`);
      const deleted = await tx.execute(
        sql`delete from assistant_usage_ledger where id=${candidate.id} returning id`,
      );
      return deleted.rows.length;
    });
  }
  return {
    assistantConversationsPurged: conversations.rows.length,
    assistantLedgerRowsPurged: purged,
  };
}

/** Own financial facts, paged and byte-budgeted. No provider/correlation/usage IDs. */
export async function collectAssistantCreditExport(
  exec: Exec,
  userId: string,
  charge: (value: unknown) => void,
) {
  const r = await exec.execute(sql`select coalesce(a.balance,0)::int as balance,
    (select coalesce(sum(held_credits),0)::text from assistant_credit_turns where user_id=${userId}) as reserved
    from (select 1) seed left join assistant_credit_accounts a on a.user_id=${userId}`);
  const wallet = r.rows[0] as { balance: number; reserved: string };
  const reserved = Number(wallet.reserved);
  if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved > wallet.balance)
    throw new RangeError('Credit export invariant');
  const turns: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (;;) {
    const rows =
      await exec.execute(sql`select usage_ledger_id,message_id,conversation_id,accepted_at,policy_key,funding_source,
      reserved_ceiling,held_credits,applied_credits,state,updated_at from assistant_credit_turns where user_id=${userId}
      and (${after}::uuid is null or usage_ledger_id>${after}::uuid) order by usage_ledger_id limit 500`);
    for (const raw of rows.rows as Record<string, unknown>[]) {
      after = raw.usage_ledger_id as string;
      const { usage_ledger_id: _identity, ...facts } = raw;
      charge(facts);
      turns.push(facts);
    }
    if (rows.rows.length < 500) break;
  }
  const entries: Record<string, unknown>[] = [];
  after = null;
  for (;;) {
    const rows =
      await exec.execute(sql`select id,delta,reason,created_at from assistant_credit_ledger where user_id=${userId}
      and (${after}::uuid is null or id>${after}::uuid) order by id limit 500`);
    for (const raw of rows.rows as Record<string, unknown>[]) {
      after = raw.id as string;
      const { id: _id, ...facts } = raw;
      charge(facts);
      entries.push(facts);
    }
    if (rows.rows.length < 500) break;
  }
  const summary = { balance: wallet.balance, reserved, available: wallet.balance - reserved };
  charge(summary);
  return { ...summary, turns, entries };
}
