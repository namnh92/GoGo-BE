import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import path from 'node:path';
import { schema } from '@gogo/database';
import { assertAssistantCreditSpendReady } from '@gogo/modules';
import {
  creditDatabase,
  assistantSpendIndexes,
  migrateWithCreditIndexes,
} from './support/credit-events';
let f: Awaited<ReturnType<typeof creditDatabase>>;
const oldGrant = randomUUID(),
  oldSpend = randomUUID();
beforeAll(async () => {
  f = await creditDatabase(undefined, async (pool) => {
    await pool.query(
      "insert into assistant_credit_ledger(id,delta,reason,submission_id,venue_identity) values($1,50,'submission_approved',gen_random_uuid(),'google:d1-historical')",
      [oldGrant],
    );
    await pool.query(
      "insert into assistant_credit_ledger(id,delta,reason,usage_ledger_id) values($1,-1,'message_spent',gen_random_uuid())",
      [oldSpend],
    );
  });
});
afterAll(async () => {
  await f?.close();
});
describe('#851 D09 successor migration and readiness', () => {
  it('preserves old grants/-1 and starts legacy epoch zero without attribution', async () => {
    expect(
      (
        await f.pool.query(
          'select policy_key,epoch::text,activated_at,bound_version from assistant_credit_spend_control',
        )
      ).rows,
    ).toEqual([
      { policy_key: 'legacy_allowance_v1', epoch: '0', activated_at: null, bound_version: null },
    ]);
    expect(
      (
        await f.pool.query(
          'select id,delta,cost_revision,credit_event_id from assistant_credit_ledger where id=any($1::uuid[]) order by delta',
          [[oldGrant, oldSpend]],
        )
      ).rows,
    ).toEqual([
      { id: oldSpend, delta: -1, cost_revision: null, credit_event_id: null },
      { id: oldGrant, delta: 50, cost_revision: null, credit_event_id: null },
    ]);
    expect(
      (await f.pool.query('select count(*)::int n from assistant_credit_turns')).rows[0].n,
    ).toBe(0);
    await assertAssistantCreditSpendReady(f.db);
    // Drained-old-writer overlap remains valid while the initial policy is legacy.
    await f.pool.query(
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id) values(-1,'message_spent',gen_random_uuid())",
    );
  });
  it('accepts variable debits/signed adjustments, rejects usage/grant mixing and non-finite cost', async () => {
    const usage = randomUUID();
    await f.pool.query(
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id,cost_revision) values(-12,'message_spent',$1,1),(4,'assistant_usage_adjustment',$1,2)",
      [usage],
    );
    for (const q of [
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id,cost_revision) values(0,'assistant_usage_adjustment',gen_random_uuid(),1)",
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id) values(1,'assistant_usage_adjustment',gen_random_uuid())",
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id,cost_revision,submission_id) values(-2,'message_spent',gen_random_uuid(),1,gen_random_uuid())",
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id,cost_revision) values(-2,'message_spent',gen_random_uuid(),0)",
      "insert into assistant_usage_calls(usage_ledger_id,call_index,provider,model,direct_cost_usd) values(gen_random_uuid(),0,'test','test','NaN')",
    ])
      await expect(f.pool.query(q)).rejects.toThrow();
    const exact = '0.000000000000000001';
    const r = await f.pool.query(
      "insert into assistant_usage_calls(usage_ledger_id,call_index,provider,model,direct_cost_usd) values(gen_random_uuid(),0,'test','test',$1) returning direct_cost_usd::text",
      [exact],
    );
    expect(r.rows[0].direct_cost_usd).toBe(exact);
  });
  it('fails a misdefined index and recovers using the real concurrent ops script', async () => {
    await f.pool.query('drop index concurrently assistant_credit_usage_revision_unique');
    await f.pool.query(
      'create index concurrently assistant_credit_usage_revision_unique on assistant_credit_ledger(cost_revision,usage_ledger_id)',
    );
    try {
      await expect(assertAssistantCreditSpendReady(f.db)).rejects.toMatchObject({
        code: 'CREDIT_INDEX_NOT_READY',
      });
    } finally {
      await f.pool.query('drop index concurrently assistant_credit_usage_revision_unique');
      await assistantSpendIndexes(f.pool);
    }
    await assertAssistantCreditSpendReady(f.db);
  });
  it('detects a real interrupted concurrent-index remnant and recovers only after dropping it', async () => {
    await f.pool.query('drop index concurrently assistant_credit_usage_revision_unique');
    const usage = randomUUID();
    await f.pool.query(
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id,cost_revision) values(1,'assistant_usage_adjustment',$1,42),(1,'assistant_usage_adjustment',$1,42)",
      [usage],
    );
    try {
      await expect(assistantSpendIndexes(f.pool)).rejects.toThrow();
      expect(
        (
          await f.pool.query(
            "select indisvalid from pg_index where indexrelid='assistant_credit_usage_revision_unique'::regclass",
          )
        ).rows[0].indisvalid,
      ).toBe(false);
      await expect(assertAssistantCreditSpendReady(f.db)).rejects.toMatchObject({
        code: 'CREDIT_INDEX_NOT_READY',
      });
      await f.pool.query('delete from assistant_credit_ledger where usage_ledger_id=$1', [usage]);
      // IF NOT EXISTS cannot heal the invalid index even after duplicate cleanup.
      await expect(assistantSpendIndexes(f.pool)).rejects.toThrow();
    } finally {
      await f.pool.query('delete from assistant_credit_ledger where usage_ledger_id=$1', [usage]);
      await f.pool.query(
        'drop index concurrently if exists assistant_credit_usage_revision_unique',
      );
      await assistantSpendIndexes(f.pool);
    }
    await assertAssistantCreditSpendReady(f.db);
  });
  it('applies the complete journal on a fresh database, with post-commit indexes', async () => {
    await f.pool.query('create database assistant_d1_fresh');
    const uri = new URL(f.container.getConnectionUri());
    uri.pathname = '/assistant_d1_fresh';
    const pool = new Pool({ connectionString: uri.toString() });
    try {
      const db = drizzle(pool, { schema });
      await migrateWithCreditIndexes(db, {
        migrationsFolder: path.resolve(__dirname, '../../../migrations'),
      });
      await assertAssistantCreditSpendReady(db);
      expect(
        (await pool.query('select count(*)::int n from assistant_usage_calls')).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.end();
    }
  });
  it('preflights reserved catalogue collisions instead of renaming them', async () => {
    await expect(
      creditDatabase(undefined, async (pool) => {
        await pool.query(
          "insert into credit_events(key,labels,trigger_event_type,trigger_schema_version,condition,audience,dedup_scope,amount) values('assistant_usage','{}','test',1,'{}','individual','per_source',1)",
        );
      }),
    ).rejects.toThrow();
  });
});
