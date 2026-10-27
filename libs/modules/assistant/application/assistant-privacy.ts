import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { RETENTION_DAYS } from '../infrastructure/assistant.repository';
import { isoUs } from '../domain/cursor';
import { FRAME_TTL_SECONDS } from '../infrastructure/frame-buffer';
import { renderPlaceTexts } from './place-text';

type Exec = Pick<Db, 'execute'>;

/** The usage ledger holds money, not conversation; its rows go after this long. */
export const LEDGER_RETENTION_DAYS = 400;

/**
 * Account deletion / privacy erasure (ADR-0023 list gains "assistant
 * conversations: deleted"): hard delete, not pseudonymize. Runs inside the
 * erasure transaction. The ledger keeps its cost rows without the person.
 */
export async function eraseAssistantDataForUser(tx: Exec, userId: string): Promise<void> {
  // A-R-08: replies of the last hour may still sit in a live frame buffer;
  // the reaper on every instance drops them. A reply still streaming loses
  // its row here, so its runner stops at its next lease renewal.
  await tx.execute(sql`
    insert into assistant_buffer_purges (message_id)
    select id from assistant_messages
    where user_id = ${userId} and role = 'assistant'
      and created_at > now() - ${sql.raw(`interval '${FRAME_TTL_SECONDS} seconds'`)}
    on conflict do nothing`);
  await tx.execute(sql`delete from assistant_conversations where user_id = ${userId}`);
  // Send replay records hold ids only, but they are this person's too.
  await tx.execute(sql`
    delete from idempotency_keys
    where actor_id = ${`user:${userId}`} and endpoint like '% /v1/assistant/%'`);
  await tx.execute(sql`update assistant_usage_ledger set user_id = null where user_id = ${userId}`);
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
    // Replies name places by token (A-R-04): the export carries today's names.
    const texts = await renderPlaceTexts(
      exec,
      rows.map((m) => m.text),
    );
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
  db: Exec,
  dryRun: boolean,
): Promise<AssistantRetentionReport> {
  const window = sql.raw(`now() - interval '${RETENTION_DAYS} days'`);
  const ledgerWindow = sql.raw(`now() - interval '${LEDGER_RETENTION_DAYS} days'`);
  if (dryRun) {
    const res = await db.execute(sql`
      select
        (select count(*)::int from assistant_conversations where last_message_at <= ${window}) as conversations,
        (select count(*)::int from assistant_usage_ledger where accepted_at <= ${ledgerWindow}) as ledger`);
    const row = res.rows[0] as { conversations: number; ledger: number };
    return {
      assistantConversationsPurged: row.conversations,
      assistantLedgerRowsPurged: row.ledger,
    };
  }
  const conversations = await db.execute(sql`
    delete from assistant_conversations where last_message_at <= ${window} returning id`);
  const ledger = await db.execute(sql`
    delete from assistant_usage_ledger where accepted_at <= ${ledgerWindow} returning id`);
  return {
    assistantConversationsPurged: conversations.rows.length,
    assistantLedgerRowsPurged: ledger.rows.length,
  };
}
