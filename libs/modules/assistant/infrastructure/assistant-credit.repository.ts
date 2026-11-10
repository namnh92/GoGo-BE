import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { sql } from 'drizzle-orm';
import { DB } from '../../shared/tokens';
import type { CreditCursor } from '../domain/credit-visibility';

export type CreditSummaryRow = {
  balance: number;
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
};

@Injectable()
export class AssistantCreditRepository {
  constructor(@Inject(DB) private readonly db: Pick<Db, 'execute'>) {}

  async summary(userId: string): Promise<CreditSummaryRow | undefined> {
    // One statement snapshot; lifetime arithmetic never joins retained usage,
    // source rows or entitlements, and GET never repairs/creates accounts.
    const result = await this.db.execute(sql`
      select coalesce(a.balance, 0)::int as balance,
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
      select l.id, l.created_at, l.delta, l.reason, l.event_id, l.usage_linked
      from users u
      left join lateral (
        select id, delta, reason,
          to_jsonb(assistant_credit_ledger)->>'credit_event_id' as event_id,
          usage_ledger_id is not null as usage_linked,
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
        from assistant_credit_ledger
        where user_id = u.id
          ${cursor ? sql`and (created_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
        order by assistant_credit_ledger.created_at desc, id desc
        limit 11
      ) l on true
      where u.id = ${userId} and u.status = 'active'
      order by l.created_at desc, l.id desc
    `);
    return result.rows as CreditHistoryRow[];
  }
}
