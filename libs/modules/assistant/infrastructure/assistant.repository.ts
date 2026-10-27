import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import type { Tx } from '../../shared/outbox';
import { isoUs } from '../domain/cursor';
import type {
  AssistantCardRef,
  AssistantContextKind,
  AssistantFollowUpGroup,
  AssistantFrame,
  AssistantMessageStatus,
  AssistantNotice,
  AssistantProposalValue,
  AssistantSourceData,
  AssistantTerminalStatus,
  ErrorEnvelope,
} from '../domain/assistant.types';
import type { AssistantProposalStatusDb } from '../domain/proposal';

/** 90-day retention (owner decision, MobileApp#377): past it a row is gone to every reader. */
export const RETENTION_DAYS = 90;
const LIVE = sql.raw(`now() - interval '${RETENTION_DAYS} days'`);

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string | null;
  context_kind: AssistantContextKind | null;
  context_id: string | null;
  message_count: number;
  preview: string | null;
  created_at: string;
  last_message_at: string;
  match_field?: 'title' | 'message' | null;
  match_message_id?: string | null;
  match_text?: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  status: AssistantMessageStatus;
  text: string;
  locale: 'vi' | 'en' | null;
  context_kind: AssistantContextKind | null;
  context_id: string | null;
  cards: AssistantCardRef[];
  follow_ups: AssistantFollowUpGroup[];
  notice: AssistantNotice | null;
  error: ErrorEnvelope | null;
  frames: AssistantFrame[] | null;
  trace: Record<string, unknown> | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  completed_at: string | null;
};

export type ProposalRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  user_id: string;
  kind: string;
  status: AssistantProposalStatusDb;
  values: AssistantProposalValue[];
  result: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
};

export type FeedbackRow = {
  message_id: string;
  rating: 'up' | 'down';
  reason: string | null;
  created_at: string;
};

export type LedgerCosts = {
  jevCalls: number;
  jevModel: string | null;
  jevInputTokens: number | null;
  jevOutputTokens: number | null;
  jevCostUsd: number | null;
  haikuCalls: number;
  haikuModel: string | null;
  haikuInputTokens: number | null;
  haikuOutputTokens: number | null;
  haikuUpstreamCostUsd: number | null;
  haikuOpenrouterCostUsd: number | null;
  haikuIsByok: boolean | null;
};

type Exec = Pick<Db, 'execute'>;

const rowsOf = <T>(res: { rows: unknown[] }) => res.rows as T[];

const CONVERSATION_COLUMNS = sql.raw(`c.id, c.user_id, c.title, c.context_kind, c.context_id,
  c.message_count, c.preview, ${isoUs('c.created_at')} as created_at,
  ${isoUs('c.last_message_at')} as last_message_at`);

const MESSAGE_COLUMNS = sql.raw(`m.id, m.conversation_id, m.user_id, m.role, m.status, m.text,
  m.locale, m.context_kind, m.context_id, m.cards, m.follow_ups, m.notice, m.error, m.frames,
  m.trace, m.lease_owner, ${isoUs('m.lease_expires_at')} as lease_expires_at,
  ${isoUs('m.created_at')} as created_at, ${isoUs('m.completed_at')} as completed_at`);

/** `%`, `_` and `\` are literal in a user's search text. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class AssistantRepository {
  constructor(@Inject(DB) readonly db: Db) {}

  // --- conversations -------------------------------------------------------

  async createConversation(
    exec: Exec,
    input: {
      userId: string;
      title: string | null;
      context: { kind: AssistantContextKind; id: string } | null;
    },
  ): Promise<ConversationRow> {
    const res = await exec.execute(sql`
      insert into assistant_conversations as c (user_id, title, context_kind, context_id)
      values (${input.userId}, ${input.title}, ${input.context?.kind ?? null}, ${input.context?.id ?? null})
      returning ${CONVERSATION_COLUMNS}`);
    return rowsOf<ConversationRow>(res)[0]!;
  }

  /** The caller's own, live conversation — or nothing, without saying why. */
  async findConversation(
    userId: string,
    id: string,
    exec: Exec = this.db,
  ): Promise<ConversationRow | null> {
    const res = await exec.execute(sql`
      select ${CONVERSATION_COLUMNS} from assistant_conversations c
      where c.id = ${id} and c.user_id = ${userId} and c.last_message_at > ${LIVE}`);
    return rowsOf<ConversationRow>(res)[0] ?? null;
  }

  async listConversations(
    userId: string,
    options: { q: string | null; limit: number; cursor: { at: string; id: string } | null },
  ): Promise<ConversationRow[]> {
    const conditions: SQL[] = [sql`c.user_id = ${userId}`, sql`c.last_message_at > ${LIVE}`];
    if (options.cursor) {
      conditions.push(
        sql`(c.last_message_at, c.id) < (${options.cursor.at}::timestamptz, ${options.cursor.id}::uuid)`,
      );
    }
    let matchSelect = sql`, null::text as match_field, null::uuid as match_message_id, null::text as match_text`;
    let matchJoin = sql``;
    if (options.q) {
      const pattern = likePattern(options.q);
      const titleHit = sql`lower(f_unaccent(coalesce(c.title, ''))) like lower(f_unaccent(${pattern}))`;
      matchJoin = sql`left join lateral (
          select m.id, m.text from assistant_messages m
          where m.conversation_id = c.id and lower(f_unaccent(m.text)) like lower(f_unaccent(${pattern}))
          order by m.created_at desc, m.id desc limit 1
        ) hit on true`;
      conditions.push(sql`(${titleHit} or hit.id is not null)`);
      matchSelect = sql`, case when ${titleHit} then 'title' else 'message' end as match_field,
        case when ${titleHit} then null else hit.id end as match_message_id,
        case when ${titleHit} then c.title else hit.text end as match_text`;
    }
    const res = await this.db.execute(sql`
      select ${CONVERSATION_COLUMNS} ${matchSelect}
      from assistant_conversations c ${matchJoin}
      where ${sql.join(conditions, sql` and `)}
      order by c.last_message_at desc, c.id desc
      limit ${options.limit + 1}`);
    return rowsOf<ConversationRow>(res);
  }

  async renameConversation(
    userId: string,
    id: string,
    title: string,
  ): Promise<ConversationRow | null> {
    const res = await this.db.execute(sql`
      update assistant_conversations c set title = ${title}
      where c.id = ${id} and c.user_id = ${userId} and c.last_message_at > ${LIVE}
      returning ${CONVERSATION_COLUMNS}`);
    return rowsOf<ConversationRow>(res)[0] ?? null;
  }

  /** Hard delete; cascades to messages, sources, proposals, feedback. */
  async deleteConversation(userId: string, id: string): Promise<void> {
    await this.db.execute(
      sql`delete from assistant_conversations where id = ${id} and user_id = ${userId}`,
    );
  }

  async streamingMessageIds(userId: string, conversationId: string): Promise<string[]> {
    const res = await this.db.execute(sql`
      select id from assistant_messages
      where conversation_id = ${conversationId} and user_id = ${userId} and status = 'streaming'`);
    return rowsOf<{ id: string }>(res).map((r) => r.id);
  }

  // --- messages ------------------------------------------------------------

  async listMessages(
    conversationId: string,
    options: { limit: number; cursor: { at: string; id: string } | null },
  ): Promise<MessageRow[]> {
    const cursor = options.cursor
      ? sql`and (m.created_at, m.id) < (${options.cursor.at}::timestamptz, ${options.cursor.id}::uuid)`
      : sql``;
    const res = await this.db.execute(sql`
      select ${MESSAGE_COLUMNS} from assistant_messages m
      where m.conversation_id = ${conversationId} ${cursor}
      order by m.created_at desc, m.id desc
      limit ${options.limit + 1}`);
    return rowsOf<MessageRow>(res);
  }

  async findMessage(
    userId: string,
    conversationId: string,
    messageId: string,
    exec: Exec = this.db,
  ): Promise<MessageRow | null> {
    const res = await exec.execute(sql`
      select ${MESSAGE_COLUMNS} from assistant_messages m
      join assistant_conversations c on c.id = m.conversation_id
      where m.id = ${messageId} and m.conversation_id = ${conversationId}
        and m.user_id = ${userId} and c.last_message_at > ${LIVE}`);
    return rowsOf<MessageRow>(res)[0] ?? null;
  }

  async findMessageById(messageId: string): Promise<MessageRow | null> {
    const res = await this.db.execute(
      sql`select ${MESSAGE_COLUMNS} from assistant_messages m where m.id = ${messageId}`,
    );
    return rowsOf<MessageRow>(res)[0] ?? null;
  }

  /** Completed turns before a message, newest last, for bounded context. */
  async history(
    conversationId: string,
    beforeMessageId: string,
    limit: number,
  ): Promise<MessageRow[]> {
    const res = await this.db.execute(sql`
      select ${MESSAGE_COLUMNS} from assistant_messages m
      where m.conversation_id = ${conversationId}
        and m.created_at < (select created_at from assistant_messages where id = ${beforeMessageId})
        and m.status <> 'streaming' and m.text <> ''
      order by m.created_at desc, m.id desc limit ${limit}`);
    return rowsOf<MessageRow>(res).reverse();
  }

  async sourcesFor(messageIds: readonly string[]): Promise<Map<string, AssistantSourceData[]>> {
    const out = new Map<string, AssistantSourceData[]>();
    if (messageIds.length === 0) return out;
    const res = await this.db.execute(sql`
      select message_id, idx, kind, document_id, version_id, slug, title, description,
        ${sql.raw(isoUs('checked_at'))} as checked_at
      from assistant_message_sources
      where message_id in (${sql.join(
        messageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      order by message_id, idx`);
    for (const r of rowsOf<{
      message_id: string;
      idx: number;
      kind: 'guide_document' | 'place_data';
      document_id: string | null;
      version_id: string | null;
      slug: string | null;
      title: string;
      description: string | null;
      checked_at: string | null;
    }>(res)) {
      const list = out.get(r.message_id) ?? [];
      list.push({
        index: r.idx,
        kind: r.kind,
        ...(r.document_id ? { documentId: r.document_id } : {}),
        ...(r.version_id ? { versionId: r.version_id } : {}),
        ...(r.slug ? { slug: r.slug } : {}),
        title: r.title,
        ...(r.description ? { description: r.description } : {}),
        ...(r.checked_at ? { checkedAt: r.checked_at } : {}),
      });
      out.set(r.message_id, list);
    }
    return out;
  }

  async feedbackFor(messageIds: readonly string[]): Promise<Map<string, FeedbackRow>> {
    const out = new Map<string, FeedbackRow>();
    if (messageIds.length === 0) return out;
    const res = await this.db.execute(sql`
      select message_id, rating, reason, ${sql.raw(isoUs('created_at'))} as created_at
      from assistant_feedback
      where message_id in (${sql.join(
        messageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
    for (const r of rowsOf<FeedbackRow>(res)) out.set(r.message_id, r);
    return out;
  }

  async proposalsFor(messageIds: readonly string[]): Promise<Map<string, ProposalRow[]>> {
    const out = new Map<string, ProposalRow[]>();
    if (messageIds.length === 0) return out;
    const res = await this.db.execute(sql`
      select ${PROPOSAL_COLUMNS} from assistant_proposals p
      where p.message_id in (${sql.join(
        messageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      order by p.created_at, p.id`);
    for (const r of rowsOf<ProposalRow>(res)) {
      const list = out.get(r.message_id) ?? [];
      list.push(r);
      out.set(r.message_id, list);
    }
    return out;
  }

  /**
   * The accepted send: the user turn, the streaming assistant turn (holding the
   * generation lease), the ledger row and the conversation's counters, in the
   * caller's transaction. No provider is called inside it.
   */
  async insertTurn(
    tx: Tx,
    input: {
      userId: string;
      conversationId: string;
      text: string;
      locale: 'vi' | 'en';
      context: { kind: AssistantContextKind; id: string } | null;
      leaseOwner: string;
      leaseMs: number;
    },
  ): Promise<{ user: MessageRow; assistant: MessageRow; ledgerId: string }> {
    const ctxKind = input.context?.kind ?? null;
    const ctxId = input.context?.id ?? null;
    // clock_timestamp(): two rows in one transaction would share now(), and the
    // reply must sort after the question.
    const userRes = await tx.execute(sql`
      insert into assistant_messages as m
        (conversation_id, user_id, role, status, text, locale, context_kind, context_id, created_at, completed_at)
      values (${input.conversationId}, ${input.userId}, 'user', 'complete', ${input.text}, ${input.locale},
        ${ctxKind}, ${ctxId}, clock_timestamp(), clock_timestamp())
      returning ${MESSAGE_COLUMNS}`);
    const assistantRes = await tx.execute(sql`
      insert into assistant_messages as m
        (conversation_id, user_id, role, status, text, locale, context_kind, context_id,
         lease_owner, lease_expires_at, created_at)
      values (${input.conversationId}, ${input.userId}, 'assistant', 'streaming', '', ${input.locale},
        ${ctxKind}, ${ctxId}, ${input.leaseOwner},
        clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'), clock_timestamp())
      returning ${MESSAGE_COLUMNS}`);
    const user = rowsOf<MessageRow>(userRes)[0]!;
    const assistant = rowsOf<MessageRow>(assistantRes)[0]!;
    const ledgerRes = await tx.execute(sql`
      insert into assistant_usage_ledger (user_id, message_id) values (${input.userId}, ${assistant.id})
      returning id`);
    await tx.execute(sql`
      update assistant_conversations set
        message_count = message_count + 2,
        last_message_at = clock_timestamp(),
        preview = left(${input.text}, 160)
      where id = ${input.conversationId}`);
    return { user, assistant, ledgerId: rowsOf<{ id: string }>(ledgerRes)[0]!.id };
  }

  /** Serializes one account's sends so two cannot both take the last slot. */
  async lockAccount(tx: Tx, userId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:${userId}`}, 0))`,
    );
  }

  async renewLease(
    messageId: string,
    owner: string,
    leaseMs: number,
    text: string,
  ): Promise<boolean> {
    const res = await this.db.execute(sql`
      update assistant_messages set
        lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
        text = ${text}
      where id = ${messageId} and status = 'streaming' and lease_owner = ${owner}
      returning id`);
    return res.rows.length === 1;
  }

  /**
   * The one terminal write. Conditional on `streaming`, so of a turn, a stop
   * and the reaper, exactly one finalizes and the others see `null`.
   */
  async finalizeMessage(
    messageId: string,
    update: {
      status: AssistantTerminalStatus;
      text: string;
      cards: AssistantCardRef[];
      followUps: AssistantFollowUpGroup[];
      notice: AssistantNotice | null;
      error: ErrorEnvelope | null;
      frames: AssistantFrame[] | null;
      trace: Record<string, unknown> | null;
      sources: AssistantSourceData[];
    },
  ): Promise<MessageRow | null> {
    return this.db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        update assistant_messages m set
          status = ${update.status}, text = ${update.text},
          cards = ${JSON.stringify(update.cards)}::jsonb,
          follow_ups = ${JSON.stringify(update.followUps)}::jsonb,
          notice = ${update.notice ? JSON.stringify(update.notice) : null}::jsonb,
          error = ${update.error ? JSON.stringify(update.error) : null}::jsonb,
          frames = ${update.frames ? JSON.stringify(update.frames) : null}::jsonb,
          trace = ${update.trace ? JSON.stringify(update.trace) : null}::jsonb,
          completed_at = now(), lease_owner = null, lease_expires_at = null
        where m.id = ${messageId} and m.status = 'streaming'
        returning ${MESSAGE_COLUMNS}`);
      const row = rowsOf<MessageRow>(res)[0] ?? null;
      if (!row) return null;
      for (const s of update.sources) {
        await tx.insert(schema.assistantMessageSources).values({
          messageId,
          index: s.index,
          kind: s.kind,
          documentId: s.documentId ?? null,
          versionId: s.versionId ?? null,
          slug: s.slug ?? null,
          title: s.title,
          description: s.description ?? null,
          checkedAt: s.checkedAt ? new Date(s.checkedAt) : null,
        });
      }
      await tx.execute(sql`
        update assistant_conversations set
          last_message_at = greatest(last_message_at, now()),
          preview = coalesce(nullif(left(${update.text}, 160), ''), preview)
        where id = ${row.conversation_id}`);
      return row;
    });
  }

  async setTitleIfEmpty(conversationId: string, title: string): Promise<void> {
    await this.db.execute(sql`
      update assistant_conversations set title = ${title} where id = ${conversationId} and title is null`);
  }

  /** Streaming turns whose lease lapsed: their process died mid-reply. */
  async expiredStreaming(limit: number): Promise<MessageRow[]> {
    const res = await this.db.execute(sql`
      select ${MESSAGE_COLUMNS} from assistant_messages m
      where m.status = 'streaming' and (m.lease_expires_at is null or m.lease_expires_at < now())
      order by m.lease_expires_at nulls first limit ${limit}`);
    return rowsOf<MessageRow>(res);
  }

  // --- ledger ----------------------------------------------------------------

  async allowanceUsage(
    exec: Exec,
    userId: string,
    dayStart: Date,
    burstStart: Date,
  ): Promise<{ acceptedToday: number; burst: Date[] }> {
    const res = await exec.execute(sql`
      select
        (select count(*)::int from assistant_usage_ledger
          where user_id = ${userId} and accepted_at >= ${dayStart.toISOString()}::timestamptz) as today,
        coalesce((select json_agg(accepted_at order by accepted_at) from assistant_usage_ledger
          where user_id = ${userId} and accepted_at >= ${burstStart.toISOString()}::timestamptz), '[]'::json) as burst`);
    const row = rowsOf<{ today: number; burst: (string | Date)[] }>(res)[0]!;
    return { acceptedToday: row.today, burst: row.burst.map((d) => new Date(d)) };
  }

  /**
   * This month's spend for the ceiling: reported costs where known, the
   * configured per-turn ceiling where a cost is still unknown (in flight, or
   * never reported) — never 0 for an unknown.
   */
  async monthSpendUsd(exec: Exec, monthStart: Date, unknownTurnUsd: number): Promise<number> {
    const res = await exec.execute(sql`
      select coalesce(sum(
        case
          when status = 'accepted' or (jev_calls > 0 and jev_cost_usd is null)
            or (haiku_calls > 0 and haiku_upstream_cost_usd is null)
          then ${unknownTurnUsd}::numeric
          else coalesce(jev_cost_usd, 0) + coalesce(haiku_upstream_cost_usd, 0)
            + coalesce(haiku_openrouter_cost_usd, 0)
        end), 0)::float8 as usd
      from assistant_usage_ledger where accepted_at >= ${monthStart.toISOString()}::timestamptz`);
    return rowsOf<{ usd: number }>(res)[0]!.usd;
  }

  async completeLedger(ledgerId: string, status: string, costs: LedgerCosts): Promise<void> {
    await this.db.execute(sql`
      update assistant_usage_ledger set
        status = ${status}, completed_at = now(),
        jev_calls = ${costs.jevCalls}, jev_model = ${costs.jevModel},
        jev_input_tokens = ${costs.jevInputTokens}, jev_output_tokens = ${costs.jevOutputTokens},
        jev_cost_usd = ${costs.jevCostUsd},
        haiku_calls = ${costs.haikuCalls}, haiku_model = ${costs.haikuModel},
        haiku_input_tokens = ${costs.haikuInputTokens}, haiku_output_tokens = ${costs.haikuOutputTokens},
        haiku_upstream_cost_usd = ${costs.haikuUpstreamCostUsd},
        haiku_openrouter_cost_usd = ${costs.haikuOpenrouterCostUsd},
        haiku_is_byok = ${costs.haikuIsByok}
      where id = ${ledgerId}`);
  }

  /** A turn finalized by someone other than its runner (stop, reaper). */
  async closeLedgerForMessage(messageId: string, status: string): Promise<void> {
    await this.db.execute(sql`
      update assistant_usage_ledger set status = ${status}, completed_at = now()
      where message_id = ${messageId} and status = 'accepted'`);
  }

  // --- proposals -------------------------------------------------------------

  async insertProposal(input: {
    conversationId: string;
    messageId: string;
    userId: string;
    kind: string;
    values: AssistantProposalValue[];
    expiresAt: Date;
  }): Promise<ProposalRow> {
    const res = await this.db.execute(sql`
      insert into assistant_proposals as p (conversation_id, message_id, user_id, kind, values, expires_at)
      values (${input.conversationId}, ${input.messageId}, ${input.userId}, ${input.kind},
        ${JSON.stringify(input.values)}::jsonb, ${input.expiresAt.toISOString()}::timestamptz)
      returning ${PROPOSAL_COLUMNS}`);
    return rowsOf<ProposalRow>(res)[0]!;
  }

  async findProposal(userId: string, proposalId: string): Promise<ProposalRow | null> {
    const res = await this.db.execute(sql`
      select ${PROPOSAL_COLUMNS} from assistant_proposals p
      join assistant_conversations c on c.id = p.conversation_id
      where p.id = ${proposalId} and p.user_id = ${userId} and c.last_message_at > ${LIVE}`);
    return rowsOf<ProposalRow>(res)[0] ?? null;
  }

  /** pending + unexpired → confirming, atomically; `null` when it was not. */
  async claimProposal(userId: string, proposalId: string): Promise<ProposalRow | null> {
    const res = await this.db.execute(sql`
      update assistant_proposals p set status = 'confirming'
      where p.id = ${proposalId} and p.user_id = ${userId}
        and p.status = 'pending' and p.expires_at > now()
      returning ${PROPOSAL_COLUMNS}`);
    return rowsOf<ProposalRow>(res)[0] ?? null;
  }

  async releaseProposal(proposalId: string): Promise<void> {
    await this.db.execute(sql`
      update assistant_proposals set status = 'pending' where id = ${proposalId} and status = 'confirming'`);
  }

  async confirmProposal(
    proposalId: string,
    values: AssistantProposalValue[],
    result: Record<string, unknown>,
  ): Promise<ProposalRow | null> {
    const res = await this.db.execute(sql`
      update assistant_proposals p set status = 'confirmed', confirmed_at = now(),
        values = ${JSON.stringify(values)}::jsonb, result = ${JSON.stringify(result)}::jsonb
      where p.id = ${proposalId} and p.status = 'confirming'
      returning ${PROPOSAL_COLUMNS}`);
    return rowsOf<ProposalRow>(res)[0] ?? null;
  }

  async dismissProposal(userId: string, proposalId: string): Promise<void> {
    await this.db.execute(sql`
      update assistant_proposals set status = 'dismissed', dismissed_at = now()
      where id = ${proposalId} and user_id = ${userId} and status = 'pending' and expires_at > now()`);
  }

  // --- feedback ----------------------------------------------------------------

  async upsertFeedback(input: {
    messageId: string;
    conversationId: string;
    userId: string;
    rating: 'up' | 'down';
    reason: string | null;
  }): Promise<FeedbackRow> {
    const res = await this.db.execute(sql`
      insert into assistant_feedback (message_id, conversation_id, user_id, rating, reason)
      values (${input.messageId}, ${input.conversationId}, ${input.userId}, ${input.rating}, ${input.reason})
      on conflict (message_id) do update set
        rating = excluded.rating, reason = excluded.reason, created_at = now(), updated_at = now()
      returning message_id, rating, reason, ${sql.raw(isoUs('created_at'))} as created_at`);
    return rowsOf<FeedbackRow>(res)[0]!;
  }

  async deleteFeedback(userId: string, messageId: string): Promise<void> {
    await this.db.execute(
      sql`delete from assistant_feedback where message_id = ${messageId} and user_id = ${userId}`,
    );
  }
}

const PROPOSAL_COLUMNS =
  sql.raw(`p.id, p.conversation_id, p.message_id, p.user_id, p.kind, p.status,
  p.values, p.result, ${isoUs('p.created_at')} as created_at, ${isoUs('p.expires_at')} as expires_at,
  ${isoUs('p.confirmed_at')} as confirmed_at`);
