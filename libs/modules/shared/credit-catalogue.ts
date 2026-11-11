import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from './app-error';

export type CreditExec = Pick<Db, 'execute'>;
export type CreditScope =
  'per_venue' | 'per_source' | 'per_place_subject' | 'per_subject' | 'per_occurrence';
export type CreditCondition =
  | { all: CreditCondition[] }
  | { any: CreditCondition[] }
  | {
      fact: string;
      op: 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'exists';
      value?: unknown;
    };
export type CreditRule = {
  id: string;
  key: string;
  trigger_event_type: string;
  trigger_schema_version: number;
  condition: CreditCondition;
  condition_version: number;
  audience: 'individual' | 'group';
  dedup_scope: CreditScope;
  amount: number;
  status: 'draft' | 'active' | 'closed';
  starts_at: Date | string;
  ends_at: Date | string | null;
  max_per_user: number | null;
  max_per_group: number | null;
  budget_total: number | null;
  budget_used: number;
};
export const CREDIT_SEEDS = [
  {
    id: '82900000-0000-4000-8000-000000000001',
    key: 'submission_approved',
    trigger: 'place.submission_decided',
    scope: 'per_venue',
    amount: 50,
    condition: { all: [{ fact: 'decision', op: 'eq', value: 'approved' }] },
  },
  {
    id: '82900000-0000-4000-8000-000000000002',
    key: 'submission_evidence',
    trigger: 'place.submission_evidence_approved',
    scope: 'per_source',
    amount: 10,
    condition: { all: [] },
  },
  {
    id: '82900000-0000-4000-8000-000000000003',
    key: 'review_published',
    trigger: 'review.published',
    scope: 'per_place_subject',
    amount: 5,
    condition: {
      all: [
        { fact: 'target', op: 'eq', value: 'place' },
        { fact: 'firstPublication', op: 'eq', value: true },
      ],
    },
  },
] as const;
export const CREDIT_INDEXES = [
  {
    name: 'credit_entitlements_event_key_unique',
    table: 'credit_entitlements',
    keys: ['event_id', 'key'],
    unique: true,
  },
  {
    name: 'credit_evaluations_event_unique',
    table: 'credit_evaluations',
    keys: ['event_id'],
    unique: true,
  },
  {
    name: 'assistant_credit_event_user',
    table: 'assistant_credit_ledger',
    keys: ['credit_event_id', 'user_id'],
    unique: false,
  },
  {
    name: 'assistant_credit_event_group',
    table: 'assistant_credit_ledger',
    keys: ['credit_event_id', 'group_source_key', 'group_grant_id'],
    unique: false,
  },
  {
    name: 'credit_entitlements_ledger',
    table: 'credit_entitlements',
    keys: ['ledger_id'],
    unique: false,
  },
  {
    name: 'credit_outbox_candidates',
    table: 'outbox_events',
    keys: ['occurred_at', 'id'],
    unique: false,
    predicate:
      "event_type=ANYARRAY['place.submission_decided','place.submission_evidence_approved','review.published','room.completed']",
  },
  {
    name: 'assistant_credit_submission_unique',
    table: 'assistant_credit_ledger',
    keys: ['submission_id'],
    unique: true,
    predicate: "reason='submission_approved'",
  },
  {
    name: 'assistant_credit_venue_unique',
    table: 'assistant_credit_ledger',
    keys: ['venue_identity'],
    unique: true,
    predicate: "reason='submission_approved'",
  },
  {
    name: 'assistant_credit_spend_unique',
    table: 'assistant_credit_ledger',
    keys: ['usage_ledger_id'],
    unique: true,
    predicate: "reason='message_spent'",
  },
  {
    name: 'assistant_credit_legacy_pending',
    table: 'assistant_credit_ledger',
    keys: ['id'],
    unique: false,
    predicate: "reason='submission_approved'ANDcredit_event_idISNULL",
  },
] as const;

/** Executed before API/worker traffic. Validation/backfill are later activation gates. */
export async function assertCreditWriterReady(db: CreditExec): Promise<void> {
  for (const seed of CREDIT_SEEDS) {
    const result = await db.execute(sql`select id from credit_events where id=${seed.id}::uuid
      and key=${seed.key} and trigger_event_type=${seed.trigger} and trigger_schema_version=2
      and audience='individual' and dedup_scope=${seed.scope} and amount=${seed.amount}
      and condition_version=1 and condition=${JSON.stringify(seed.condition)}::jsonb`);
    if (!result.rows.length)
      throw AppError.serviceUnavailable(
        'CREDIT_SEED_MISMATCH',
        'Credit seed definition does not match',
        false,
      );
  }
  const cutover = await db.execute(sql`select singleton from credit_cutover where singleton=true`);
  if (!cutover.rows.length)
    throw AppError.serviceUnavailable(
      'CREDIT_CUTOVER_NOT_READY',
      'Credit cutover is missing',
      false,
    );
  // Resolve every column our writers need, including prerequisite schema.
  await db.execute(sql`select l.credit_event_id,l.entitlement_key,l.group_grant_id,l.group_source_key,
    c.mode,c.epoch,c.first_activated_at,r.credit_epoch,r.first_published_at
    from assistant_credit_ledger l cross join credit_cutover c cross join reviews r limit 0`);
  await db.execute(sql`select event_id,key,ledger_id,created_at from credit_entitlements limit 0`);
  await db.execute(
    sql`select event_id,status,reason,grants,evaluated_at from credit_evaluations limit 0`,
  );
  await db.execute(sql`select labels,trigger_event_type,trigger_schema_version,condition,condition_version,audience,dedup_scope,
    amount,starts_at,ends_at,status,closed_reason,max_per_user,max_per_group,budget_total,budget_used from credit_events limit 0`);
  for (const index of CREDIT_INDEXES) {
    const result = await db.execute(sql`select i.indexrelid from pg_index i
      join pg_class x on x.oid=i.indexrelid
      where x.oid=to_regclass(${index.name}) and i.indrelid=to_regclass(${index.table})
      and i.indisvalid and i.indisready and i.indisunique=${index.unique}
      and i.indnkeyatts=${index.keys.length} and i.indnatts=${index.keys.length} and i.indexprs is null
      and (select array_agg(a.attname::text order by k.n)
        from unnest(i.indkey) with ordinality k(attnum,n)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
        where k.n<=i.indnkeyatts)=ARRAY[${sql.join(
          index.keys.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]
      and regexp_replace(replace(coalesce(pg_get_expr(i.indpred,i.indrelid),''),'::text',''),'[[:space:]()]','','g')=${'predicate' in index ? index.predicate : ''}`);
    if (!result.rows.length)
      throw AppError.serviceUnavailable(
        'CREDIT_INDEX_NOT_READY',
        'Credit index is missing, invalid or incompatible',
        false,
      );
  }
}

/** Tier two. Must be called before ANY account/domain lock. */
export async function lockSyncCreditRules(tx: CreditExec): Promise<void> {
  await assertCreditWriterReady(tx);
  const definitions = CREDIT_SEEDS.slice(0, 2).map(
    (seed) => sql`(id=${seed.id}::uuid and key=${seed.key}
    and amount=${seed.amount} and trigger_event_type=${seed.trigger} and audience='individual'
    and dedup_scope=${seed.scope} and trigger_schema_version=2 and condition_version=1
    and condition=${JSON.stringify(seed.condition)}::jsonb)`,
  );
  const result = await tx.execute(
    sql`select * from credit_events where ${sql.join(definitions, sql` or `)} order by id for update`,
  );
  if (result.rows.length !== 2)
    throw AppError.serviceUnavailable(
      'CREDIT_SEED_MISMATCH',
      'Sync credit rule is missing or incompatible',
      false,
    );
}
