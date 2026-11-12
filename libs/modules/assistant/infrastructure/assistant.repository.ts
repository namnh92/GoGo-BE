import {
  placeQaTransaction,
  type PlaceQaReadOptions,
} from '../../search/infrastructure/place-qa-read';
import { AssistantUsageEvidenceRepository } from './assistant-usage-evidence.repository';
import { AppError } from '../../shared/app-error';
import {
  AssistantCreditSpendRepository,
  conversationCreditsSql,
  turnCreditsSql,
} from './assistant-credit-spend.repository';
import { lockAssistantAccount } from '../../shared/assistant-credits';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import type { Tx } from '../../shared/outbox';
import { isoUs } from '../domain/cursor';
import { storedPreview } from '../domain/place-tokens';
import type { QaProbe } from '../domain/place-qa/classifier';
import { UNPRODUCED_GROUP } from '../domain/place-qa/reference-group';
import type {
  AssistantTurnCredits,
  AssistantConversationCredits,
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
  credits: AssistantConversationCredits;
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
  /** The matched message's trace: the snippet is validated as a whole message. Never on the wire. */
  match_trace?: Record<string, unknown> | null;
};

export type MessageRow = {
  credits?: AssistantTurnCredits;
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

const CONVERSATION_COLUMNS = sql`c.id, c.user_id, c.title, c.context_kind, c.context_id,
  c.message_count, c.preview, ${sql.raw(isoUs('c.created_at'))} as created_at,
  ${sql.raw(isoUs('c.last_message_at'))} as last_message_at, ${conversationCreditsSql(sql`c.id`, sql`c.user_id`)} as credits`;

/**
 * GoGo-BE#873 — the assistant partner (`qa`) that keeps a user message out of
 * recommendation history: a QA route, or a terminal row whose provisional
 * marker was never resolved (legacy finalization or interrupted settlement). A marker on a still-streaming row hides nothing: that turn needs its
 * own question, and one conversation has one streaming turn.
 */
const QA_PARTNER = sql`(qa.trace->>'route'='place_qa' or (qa.status<>'streaming' and qa.trace->>'qaProbe' is not null))`;
/**
 * Whether an UNDECIDED provisional marker on row `m` is QA, from durable facts
 * only: a `question` when the observed (or recovery) flag is on; a `name`/`reply` only as a typed
 * reply to a QA turn. Never once the producer published ordinary frames or
 * dispatched a model call — that turn already ran the ordinary path.
 */
function qaRecovered(merged: SQL, enabled: boolean): SQL {
  return sql`(
    m.trace->>'qaProbe' is not null
    and coalesce(${merged}->>'route', '') <> 'place_qa'
    and coalesce(m.trace->>'streamRoute', '') <> 'ordinary'
    and not exists (
      select 1 from assistant_usage_ledger u
      join assistant_usage_calls c on c.usage_ledger_id = u.id
      where u.message_id = m.id)
    and (
      (m.trace->>'qaProbe' = 'question' and
        case when jsonb_typeof(m.trace->'qaEnabled') = 'boolean'
          then (m.trace->>'qaEnabled')::boolean else ${enabled} end)
      or (m.trace->>'qaProbe' in ('name', 'reply') and (
        select l.trace->>'route' from assistant_messages l
        where l.conversation_id = m.conversation_id and l.user_id = m.user_id
          and l.role = 'assistant' and l.created_at < m.created_at
        order by l.created_at desc, l.id desc limit 1) = 'place_qa')
    )
  )`;
}
/** The trace after settlement: the marker always goes; a recovered turn gets the route. */
function qaSettled(recovered: SQL, merged: SQL): SQL {
  return sql`(case when ${recovered}
    then ${JSON.stringify({ placeAnswerGroup: UNPRODUCED_GROUP })}::jsonb || ${merged}
      || '{"route":"place_qa","streamRoute":"place_qa"}'::jsonb
    else ${merged} end) - 'qaProbe'`;
}
const MESSAGE_COLUMNS = sql`m.id, m.conversation_id, m.user_id, m.role, m.status, m.text,
  m.locale, m.context_kind, m.context_id, m.cards, m.follow_ups, m.notice, m.error, m.frames,
  m.trace, m.lease_owner, ${sql.raw(isoUs('m.lease_expires_at'))} as lease_expires_at,
  ${sql.raw(isoUs('m.created_at'))} as created_at, ${sql.raw(isoUs('m.completed_at'))} as completed_at, ${turnCreditsSql(sql`m.id`, sql`m.user_id`)} as credits`;

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
    let matchSelect = sql`, null::text as match_field, null::uuid as match_message_id, null::text as match_text, null::jsonb as match_trace`;
    let matchJoin = sql``;
    if (options.q) {
      const pattern = likePattern(options.q);
      const titleHit = sql`lower(f_unaccent(coalesce(c.title, ''))) like lower(f_unaccent(${pattern}))`;
      matchJoin = sql`left join lateral (
          select m.id, m.text, m.trace from assistant_messages m
          where m.conversation_id = c.id and lower(f_unaccent(m.text)) like lower(f_unaccent(${pattern}))
          order by m.created_at desc, m.id desc limit 1
        ) hit on true`;
      conditions.push(sql`(${titleHit} or hit.id is not null)`);
      matchSelect = sql`, case when ${titleHit} then 'title' else 'message' end as match_field,
        case when ${titleHit} then null else hit.id end as match_message_id,
        case when ${titleHit} then c.title else hit.text end as match_text,
        case when ${titleHit} then null else hit.trace end as match_trace`;
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

  /**
   * Hard delete, queuing in the same transaction a buffer purge for every
   * reply young enough to still have a live buffer (A-R2-08). Returns them.
   */
  async deleteConversationQueuingPurges(
    userId: string,
    conversationId: string,
    lifetimeSeconds: number,
  ): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        insert into assistant_buffer_purges (message_id)
        select m.id from assistant_messages m
        join assistant_conversations c on c.id = m.conversation_id
        where c.id = ${conversationId} and c.user_id = ${userId} and m.role = 'assistant'
          and m.created_at > now() - (${lifetimeSeconds} * interval '1 second')
        on conflict do nothing
        returning message_id`);
      await tx.execute(
        sql`delete from assistant_conversations where id = ${conversationId} and user_id = ${userId}`,
      );
      return rowsOf<{ message_id: string }>(res).map((r) => r.message_id);
    });
  }

  /** Buffers an erasure left behind (A-R-08); see `assistant_buffer_purges`. */
  async pendingBufferPurges(limit: number): Promise<string[]> {
    const res = await this.db.execute(
      sql`select message_id from assistant_buffer_purges order by created_at limit ${limit}`,
    );
    return rowsOf<{ message_id: string }>(res).map((r) => r.message_id);
  }

  async completeBufferPurges(messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.db.execute(sql`
      delete from assistant_buffer_purges where message_id in (${sql.join(
        messageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
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
        and coalesce(m.trace->>'route', '') <> 'place_qa'
        and m.trace->>'qaProbe' is null
        and not exists (
          select 1 from assistant_messages qa
          where qa.conversation_id=m.conversation_id and qa.user_id=m.user_id
            and qa.role='assistant' and ${QA_PARTNER}
            and qa.trace->>'questionMessageId'=m.id::text
        )
      order by m.created_at desc, m.id desc limit ${limit}`);
    return rowsOf<MessageRow>(res).reverse();
  }

  /** The true latest accessible assistant turn, including failed/empty QA turns. */
  async latestAssistant(
    userId: string,
    conversationId: string,
    beforeMessageId: string,
  ): Promise<MessageRow | null> {
    const result = await this.db.execute(sql`
      select ${MESSAGE_COLUMNS} from assistant_messages m
      join assistant_conversations c on c.id=m.conversation_id and c.user_id=m.user_id
      where m.conversation_id=${conversationId} and m.user_id=${userId}
        and c.last_message_at > ${LIVE} and m.role='assistant'
        and m.created_at < (select created_at from assistant_messages where id=${beforeMessageId} and user_id=${userId} and conversation_id=${conversationId})
      order by m.created_at desc,m.id desc limit 1`);
    return rowsOf<MessageRow>(result)[0] ?? null;
  }

  /** Durable route fence BEFORE resolver/fact/area reads; never accepts client pair IDs. */
  async markPlaceQa(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<string | null> {
    const result = await this.db.execute(sql`
      update assistant_messages m set trace=coalesce(m.trace,'{}'::jsonb) || jsonb_build_object('route','place_qa','streamRoute','place_qa')
      where m.id=${messageId} and m.user_id=${userId} and m.conversation_id=${conversationId}
        and m.role='assistant' and m.status='streaming'
        and m.trace->>'questionMessageId' is not null
      returning m.trace->>'questionMessageId' as question_id`);
    return rowsOf<{ question_id: string }>(result)[0]?.question_id ?? null;
  }

  /** Bounded episode sources, scoped to the already-authorized conversation. */
  async episodeMessages(
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<MessageRow[]> {
    if (messageIds.length === 0 || messageIds.length > 8) return [];
    const res = await this.db.execute(sql`
      select ${MESSAGE_COLUMNS} from assistant_messages m
      where m.conversation_id = ${conversationId} and m.role = 'user'
        and m.created_at > ${LIVE}
        and not exists (select 1 from assistant_messages qa where qa.conversation_id=m.conversation_id and qa.user_id=m.user_id and qa.role='assistant' and ${QA_PARTNER} and qa.trace->>'questionMessageId'=m.id::text)
        and m.id in (${sql.join(
          messageIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    return rowsOf<MessageRow>(res);
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
      allowanceSource?: 'daily' | 'credit';
      billingPolicy?: string;
      billingEpoch?: string;
      acceptedAt?: Date;
      /** GoGo-BE#873: pure classification of the text, no read (`qaProbeOf`). */
      qaProbe?: QaProbe | null;
    },
  ): Promise<{ user: MessageRow; assistant: MessageRow; ledgerId: string }> {
    // The QA association exists from the commit of the send itself, so no
    // window is left for a crash or another writer before a later fence write.
    // `control` is QA in every flag state; the others are a provisional marker
    // that only the terminal write resolves (finalizeMessage).
    const qaTrace =
      input.qaProbe === 'control'
        ? { route: 'place_qa', streamRoute: 'place_qa' }
        : input.qaProbe
          ? { qaProbe: input.qaProbe }
          : {};
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
         lease_owner, lease_expires_at, created_at, trace)
      values (${input.conversationId}, ${input.userId}, 'assistant', 'streaming', '', ${input.locale},
        ${ctxKind}, ${ctxId}, ${input.leaseOwner},
        clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'), clock_timestamp(),
        jsonb_build_object('questionMessageId', ${rowsOf<MessageRow>(userRes)[0]!.id}::text)
          || ${JSON.stringify(qaTrace)}::jsonb)
      returning ${MESSAGE_COLUMNS}`);
    const user = rowsOf<MessageRow>(userRes)[0]!;
    const assistant = rowsOf<MessageRow>(assistantRes)[0]!;
    const ledgerRes = await tx.execute(sql`
      insert into assistant_usage_ledger (user_id, message_id, allowance_source, billing_policy, billing_epoch, accepted_at) values (${input.userId}, ${assistant.id}, ${input.allowanceSource ?? 'daily'}, ${input.billingPolicy ?? null}, ${input.billingEpoch ?? null}::bigint, ${input.acceptedAt?.toISOString() ?? new Date().toISOString()}::timestamptz)
      returning id`);
    await tx.execute(sql`
      update assistant_conversations set
        message_count = message_count + 2,
        last_message_at = clock_timestamp(),
        preview = left(${input.text}, 160)
      where id = ${input.conversationId}`);
    return { user, assistant, ledgerId: rowsOf<{ id: string }>(ledgerRes)[0]!.id };
  }

  async acceptanceTime(tx: Tx): Promise<Date> {
    const r = await tx.execute(sql`select clock_timestamp() as accepted_at`);
    return new Date((r.rows[0] as { accepted_at: Date | string }).accepted_at);
  }

  async lockAdmissionSubject(tx: Tx, userId: string, conversationId: string): Promise<void> {
    const u = await tx.execute(
      sql`select id from users where id=${userId} and status='active' for share`,
    );
    if (!u.rows.length)
      throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
    const c = await tx.execute(
      sql`select id from assistant_conversations where id=${conversationId} and user_id=${userId} and last_message_at>${LIVE} for update`,
    );
    if (!c.rows.length) throw AppError.notFound();
  }
  /** Serializes one account's sends so two cannot both take the last slot. */
  async lockAccount(tx: Tx, userId: string): Promise<void> {
    await lockAssistantAccount(tx, userId);
  }

  /**
   * A-R-01 — serializes every account's budget check with its reservation (the
   * ledger row), so concurrent sends cannot all read the same remaining
   * budget. Always taken after the account lock, so the order never inverts.
   */
  async lockBudget(tx: Tx): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('assistant:budget', 0))`);
  }

  /** Persist the immutable buffer classification before its first append.
   * Lease ownership prevents a losing/deleted producer from publishing frames.
   */
  async persistStreamRoute(
    messageId: string,
    owner: string,
    route: 'place_qa' | 'ordinary',
  ): Promise<boolean> {
    const res = await this.db.execute(sql`
      update assistant_messages set
        trace = coalesce(trace, '{}'::jsonb) || ${JSON.stringify({ streamRoute: route })}::jsonb
      where id = ${messageId} and status = 'streaming' and lease_owner = ${owner}
        and (trace->>'streamRoute' is null or trace->>'streamRoute' = ${route})
      returning id`);
    return res.rows.length === 1;
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

  /** Immutable producer observation, committed before any QA/ordinary dispatch.
   * Pool acquisition, row lock, UPDATE and commit share the turn's deadline and cancellation.
   */
  async persistQaEnabled(
    userId: string,
    conversationId: string,
    messageId: string,
    enabled: boolean,
    options: PlaceQaReadOptions,
  ): Promise<boolean> {
    const res = await placeQaTransaction(this.db, 1500, options, (tx) =>
      tx.execute(sql`
        update assistant_messages set
          trace = coalesce(trace, '{}'::jsonb) || jsonb_build_object('qaEnabled', ${enabled}::boolean)
        where id=${messageId} and conversation_id=${conversationId} and user_id=${userId}
          and role='assistant' and status='streaming'
          and (trace->'qaEnabled' is null or trace->'qaEnabled' = to_jsonb(${enabled}::boolean))
        returning id`),
    );
    return res.rows.length === 1;
  }

  /**
   * GoGo-BE#873 round 2 — settles a provisional marker of a turn that is still
   * streaming and whose producer never decided, from the same durable facts
   * the terminal write uses, BEFORE any ordinary frame is published (the
   * first-text deadline fallback). True: the turn is QA now. A row another
   * writer already ended matches nothing.
   */
  async settleQaProbe(
    messageId: string,
    enabled: boolean,
    options: PlaceQaReadOptions = {},
  ): Promise<boolean> {
    const current = sql`coalesce(m.trace, '{}'::jsonb)`;
    const res = await placeQaTransaction(this.db, 1500, options, (tx) =>
      tx.execute(sql`
      update assistant_messages m set trace = ${qaSettled(qaRecovered(current, enabled), current)}
      where m.id = ${messageId} and m.status = 'streaming'
        and m.trace->>'qaProbe' is not null
      returning m.trace->>'route' as route`),
    );
    return rowsOf<{ route: string | null }>(res)[0]?.route === 'place_qa';
  }

  /**
   * The one terminal write. Conditional on `streaming`, so of a turn, a stop
   * and the reaper, exactly one finalizes and the others see `null`. The
   * reaper also re-checks, in the same statement, that the lease lapsed
   * (A-R-11): a runner that renewed meanwhile keeps its turn.
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
    options: {
      onlyIfLeaseExpired?: boolean;
      /**
       * GoGo-BE#873 round 2 — how a provisional `qaProbe` marker ends.
       * `decided`: this writer's producer already chose (its trace carries the
       * route or not). Otherwise the turn ended before that choice and this
       * statement makes it, from durable facts only; `enabled` is the QA flag
       * as read by the caller, used for a `question` marker alone.
       */
      qa?: { decided: true } | { decided: false; enabled: boolean } | { uncertain: true };
    } = {},
  ): Promise<MessageRow | null> {
    const leaseLapsed = options.onlyIfLeaseExpired
      ? sql`and (m.lease_expires_at is null or m.lease_expires_at < now())`
      : sql``;
    const merged = sql`(coalesce(m.trace, '{}'::jsonb) || ${JSON.stringify(update.trace ?? {})}::jsonb)`;
    const qa = options.qa ?? { decided: true };
    const recovered =
      'uncertain' in qa || qa.decided ? sql`false` : qaRecovered(merged, qa.enabled);
    const settled = 'uncertain' in qa ? merged : qaSettled(recovered, merged);
    return this.db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        update assistant_messages m set
          status = ${update.status}, text = ${update.text},
          cards = ${JSON.stringify(update.cards)}::jsonb,
          follow_ups = ${JSON.stringify(update.followUps)}::jsonb,
          notice = ${update.notice ? JSON.stringify(update.notice) : null}::jsonb,
          error = ${update.error ? JSON.stringify(update.error) : null}::jsonb,
          frames = ${update.frames ? JSON.stringify(update.frames) : null}::jsonb,
          trace = ${settled},
          completed_at = now(), lease_owner = null, lease_expires_at = null
        where m.id = ${messageId} and m.status = 'streaming' ${leaseLapsed}
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
          preview = coalesce(nullif(${storedPreview(update.text, row.trace)}, ''), preview)
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
          where user_id = ${userId} and allowance_source = 'daily' and accepted_at >= ${dayStart.toISOString()}::timestamptz) as today,
        coalesce((select json_agg(accepted_at order by accepted_at) from assistant_usage_ledger
          where user_id = ${userId} and accepted_at >= ${burstStart.toISOString()}::timestamptz), '[]'::json) as burst`);
    const row = rowsOf<{ today: number; burst: (string | Date)[] }>(res)[0]!;
    return { acceptedToday: row.today, burst: row.burst.map((d) => new Date(d)) };
  }

  /**
   * This month's spend for the ceiling: reported costs where known, the
   * configured per-turn ceiling where a cost is still unknown — in flight,
   * never reported, or `unsettled` (its runner died, so whether a provider was
   * called and what it charged is unknown: A-R-02). Never 0 for an unknown,
   * and each cost component a call has must be known.
   */
  async monthSpendUsd(exec: Exec, monthStart: Date, unknownTurnUsd: number): Promise<number> {
    const res = await exec.execute(sql`
      select coalesce(sum(
        case
          when status in ('accepted', 'unsettled')
            or (jev_calls > 0 and jev_cost_usd is null)
            or (haiku_calls > 0 and (haiku_upstream_cost_usd is null or haiku_openrouter_cost_usd is null))
          then ${unknownTurnUsd}::numeric
          else coalesce(jev_cost_usd, 0) + coalesce(haiku_upstream_cost_usd, 0)
            + coalesce(haiku_openrouter_cost_usd, 0)
        end), 0)::float8 as usd
      from assistant_usage_ledger where accepted_at >= ${monthStart.toISOString()}::timestamptz`);
    return rowsOf<{ usd: number }>(res)[0]!.usd;
  }

  /** Frozen policy, identity and funding are checked before the runner starts. */
  async runnableFunding(userId: string, usageId: string, messageId: string): Promise<boolean> {
    const r = await this.db.execute(sql`select u.id from assistant_usage_ledger u
      left join assistant_credit_turns t on t.usage_ledger_id=u.id
      where u.id=${usageId} and u.user_id=${userId} and u.message_id=${messageId}
      and (coalesce(u.billing_policy,'legacy_allowance_v1')='legacy_allowance_v1'
        or (u.billing_policy='free_then_actual_cost_v1' and t.policy_key=u.billing_policy and t.policy_epoch=u.billing_epoch
          and t.user_id=u.user_id and t.message_id=u.message_id and t.state<>'erased'
          and ((t.funding_source='free' and t.state='settled' and t.reserved_ceiling=0)
            or (t.funding_source='credit' and t.state='pending' and t.applied_credits=0 and t.held_credits=t.reserved_ceiling and t.held_credits>0))))`);
    return r.rows.length === 1;
  }

  async releaseUndispatchedTurn(
    userId: string,
    usageId: string,
    messageId: string,
    environment: 'all' | 'dev' | 'staging' | 'production',
  ): Promise<void> {
    await new AssistantCreditSpendRepository(this.db).releaseUndispatched(
      userId,
      usageId,
      environment,
      { messageId },
    );
  }

  async completeLedger(ledgerId: string, status: string, costs: LedgerCosts): Promise<void> {
    await new AssistantUsageEvidenceRepository(this.db).closeDispatch(ledgerId);
    await this.db.execute(sql`
      with qa_zero as (
        select u.id from assistant_usage_ledger u join assistant_messages m on m.id=u.message_id
        where u.id=${ledgerId} and m.status<>'streaming' and m.trace->>'route'='place_qa'
          and u.jev_calls=0 and u.haiku_calls=0 and ${costs.jevCalls}=0 and ${costs.haikuCalls}=0
          and not exists(select 1 from assistant_usage_calls c where c.usage_ledger_id=u.id)
      )
      update assistant_usage_ledger set
        status = ${status}, completed_at = now(),
        jev_calls = ${costs.jevCalls}, jev_model = ${costs.jevModel},
        jev_input_tokens = ${costs.jevInputTokens}, jev_output_tokens = ${costs.jevOutputTokens},
        jev_cost_usd = case when id in (select id from qa_zero) then 0::numeric else ${costs.jevCostUsd}::numeric end,
        haiku_calls = ${costs.haikuCalls}, haiku_model = ${costs.haikuModel},
        haiku_input_tokens = ${costs.haikuInputTokens}, haiku_output_tokens = ${costs.haikuOutputTokens},
        haiku_upstream_cost_usd = case when id in (select id from qa_zero) then 0::numeric else ${costs.haikuUpstreamCostUsd}::numeric end,
        haiku_openrouter_cost_usd = case when id in (select id from qa_zero) then 0::numeric else ${costs.haikuOpenrouterCostUsd}::numeric end,
        haiku_is_byok = ${costs.haikuIsByok}
      where id = ${ledgerId}`);
  }

  /**
   * A turn finalized by someone other than its runner (stop, reaper). Its
   * runner may have called a provider before dying, so the reservation is
   * kept as `unsettled` — counted at the per-turn ceiling, never released to 0
   * (A-R-02). A runner still alive overwrites it with what it reported.
   */
  async closeLedgerForMessage(messageId: string): Promise<void> {
    // A durable QA route proves no model dispatch is permitted. Still require
    // zero attempts, so a corrupt/mixed trace can never launder unknown cost.
    await this.db.execute(sql`update assistant_usage_ledger u set status=m.status,
      completed_at=now(),jev_cost_usd=0,haiku_upstream_cost_usd=0,haiku_openrouter_cost_usd=0
      from assistant_messages m where u.message_id=${messageId} and m.id=u.message_id
      and u.status='accepted' and m.status<>'streaming' and m.trace->>'route'='place_qa'
      and u.jev_calls=0 and u.haiku_calls=0
      and not exists(select 1 from assistant_usage_calls c where c.usage_ledger_id=u.id)`);
    await this.db.execute(sql`
      update assistant_usage_ledger set status = 'unsettled', completed_at = now()
      where message_id = ${messageId} and status = 'accepted'`);
    const u = await this.db.execute(
      sql`select id from assistant_usage_ledger where message_id=${messageId}`,
    );
    for (const row of u.rows as { id: string }[])
      await new AssistantUsageEvidenceRepository(this.db).closeDispatch(row.id);
  }

  /**
   * A-R-03 — the BYOK quarantine lives in the shared ledger, not in one
   * process: written the moment a non-BYOK answer is seen, read by every
   * replica's admission, and it survives a restart.
   */
  async markByokViolation(ledgerId: string): Promise<void> {
    await this.db.execute(
      sql`update assistant_usage_ledger set haiku_is_byok = false where id = ${ledgerId}`,
    );
  }

  async byokViolationSince(exec: Exec, since: Date): Promise<boolean> {
    const res = await exec.execute(sql`
      select exists(
        select 1 from assistant_usage_ledger
        where haiku_is_byok = false and accepted_at >= ${since.toISOString()}::timestamptz
      ) as hit`);
    return rowsOf<{ hit: boolean }>(res)[0]!.hit;
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

  /**
   * #733 D-3 — inserts a card and, in the same statement, retires the
   * conversation's other pending cards of that kind (status `dismissed`,
   * assistant table only), so one stays live and no failure can leave both.
   * The conversation lock serializes this with refused confirms returning a
   * card to pending. Returns the row and how many retired.
   */
  async insertSupersedingProposal(input: {
    conversationId: string;
    messageId: string;
    userId: string;
    kind: string;
    values: AssistantProposalValue[];
    expiresAt: Date;
  }): Promise<{ row: ProposalRow; superseded: number }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        select id from assistant_conversations where id = ${input.conversationId} for update`);
      const res = await tx.execute(sql`
      with p as (
        insert into assistant_proposals
          (conversation_id, message_id, user_id, kind, values, expires_at, created_at)
        values (${input.conversationId}, ${input.messageId}, ${input.userId}, ${input.kind},
          ${JSON.stringify(input.values)}::jsonb, ${input.expiresAt.toISOString()}::timestamptz,
          clock_timestamp())
        returning *
      ), retired as (
        update assistant_proposals set status = 'dismissed', dismissed_at = now()
        where conversation_id = ${input.conversationId} and kind = ${input.kind}
          and status = 'pending' and id <> (select id from p)
        returning id
      )
      select ${PROPOSAL_COLUMNS}, (select count(*)::int from retired) as superseded from p`);
      const { superseded, ...row } = rowsOf<ProposalRow & { superseded: number }>(res)[0]!;
      return { row, superseded };
    });
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

  /**
   * A refused confirm hands the card back — unless a newer card of
   * the same kind replaced it meanwhile (#733 D-3, Astra A-F-06): then it is
   * retired, so a conversation never ends with two live room cards.
   */
  async releaseProposal(proposalId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        select id from assistant_conversations where id = (
          select conversation_id from assistant_proposals where id = ${proposalId}
        ) for update`);
      await tx.execute(sql`
      update assistant_proposals p set
        status = case when exists (
          select 1 from assistant_proposals n
          where n.conversation_id = p.conversation_id and n.kind = p.kind
            and n.id <> p.id and n.created_at > p.created_at
        ) then 'dismissed' else 'pending' end,
        dismissed_at = case when exists (
          select 1 from assistant_proposals n
          where n.conversation_id = p.conversation_id and n.kind = p.kind
            and n.id <> p.id and n.created_at > p.created_at
        ) then now() else p.dismissed_at end
      where p.id = ${proposalId} and p.status = 'confirming'`);
    });
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
