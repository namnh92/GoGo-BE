import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { sql } from 'drizzle-orm';
import { DB } from '../../shared/tokens';
import type { CreditCursor } from '../domain/credit-visibility';
import { RETENTION_DAYS } from './assistant.repository';

export type CreditSummaryRow = {
  balance: number;
  reserved: string;
  policy_key: string;
  earned: string;
  spent: string;
  as_of: string;
};
export type CreditHistoryRow = {
  id: string | null;
  created_at: string | null;
  delta: number | null;
  reason: string | null;
  event_id: string | null;
  usage_linked: boolean | null;
  conversation: { id: string; title: string | null } | null;
  event_labels: { vi: string; en: string } | null;
};

@Injectable()
export class AssistantCreditRepository {
  constructor(@Inject(DB) private readonly db: Pick<Db, 'execute'>) {}

  async summary(userId: string): Promise<CreditSummaryRow | undefined> {
    // One statement snapshot; lifetime arithmetic never joins retained usage,
    // source rows or entitlements, and GET never repairs/creates accounts.
    const result = await this.db.execute(sql`
      select coalesce(a.balance, 0)::int as balance,
        (select coalesce(sum(held_credits),0)::text from assistant_credit_turns where user_id=u.id) as reserved,
        (select policy_key from assistant_credit_spend_control where singleton=true) as policy_key,
        coalesce(t.earned, 0)::text as earned, coalesce(t.spent, 0)::text as spent,
        to_char(statement_timestamp() at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of
      from users u
      left join assistant_credit_accounts a on a.user_id = u.id
      left join lateral (
        select sum(delta) filter (where not (reason = 'message_spent' or (reason = 'assistant_usage_adjustment' and usage_ledger_id is not null))) as earned,
          -sum(delta) filter (where reason = 'message_spent' or (reason = 'assistant_usage_adjustment' and usage_ledger_id is not null)) as spent
        from assistant_credit_ledger where user_id = u.id
      ) t on true
      where u.id = ${userId} and u.status = 'active'
    `);
    return result.rows[0] as CreditSummaryRow | undefined;
  }

  async history(userId: string, cursor: CreditCursor | null): Promise<CreditHistoryRow[]> {
    const result = await this.db.execute(sql`
      select l.id, l.created_at, l.delta, l.reason, l.event_id, l.usage_linked,
        case when c.id is not null then jsonb_build_object('id', c.id, 'title', c.title) end as conversation,
        case when e.id is not null then jsonb_build_object('vi', e.labels->>'vi', 'en', e.labels->>'en') end as event_labels
      from users u
      left join lateral (
        select id, delta, reason, usage_ledger_id,
          to_jsonb(assistant_credit_ledger)->>'credit_event_id' as event_id,
          usage_ledger_id is not null as usage_linked,
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
        from assistant_credit_ledger
        where user_id = u.id
          ${cursor ? sql`and (created_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
        order by assistant_credit_ledger.created_at desc, id desc
        limit 11
      ) l on true
      -- Enrich only the bounded page. Every join targets a primary key, so no
      -- grant components/revisions can duplicate rows or change the cursor.
      left join assistant_credit_turns t on t.usage_ledger_id = l.usage_ledger_id
        and l.reason in ('message_spent', 'assistant_usage_adjustment')
      left join assistant_usage_ledger ul on ul.id = l.usage_ledger_id
        and t.usage_ledger_id is null and ul.user_id = u.id
        and l.reason in ('message_spent', 'assistant_usage_adjustment')
      left join assistant_messages m on m.id = ul.message_id and m.user_id = u.id
      -- A known D turn is authoritative, including missing/erased attribution:
      -- never fall back to a legacy message when that turn is unreadable.
      left join assistant_conversations c on c.id = case
          when t.usage_ledger_id is null then m.conversation_id
          when t.user_id = u.id then t.conversation_id
        end
        and c.user_id = u.id
        and c.last_message_at > now() - make_interval(days => ${RETENTION_DAYS})
      left join credit_events e on e.id = l.event_id::uuid and e.key = l.reason
        and l.delta > 0 and l.reason not in ('message_spent', 'assistant_usage_adjustment')
      where u.id = ${userId} and u.status = 'active'
      order by l.created_at desc, l.id desc
    `);
    return result.rows as CreditHistoryRow[];
  }
}
