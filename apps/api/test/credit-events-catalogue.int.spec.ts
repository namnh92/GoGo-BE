import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCreditWriterReady,
  CREDIT_SEEDS,
} from '../../../libs/modules/shared/credit-catalogue';
import { attributeLegacyCreditBatch } from '../../../libs/modules/shared/credit-grants';
import { creditDatabase, creditOps, creditUser } from './support/credit-events';
let fixture: Awaited<ReturnType<typeof creditDatabase>>;
const historic = new Map<string, number>();
beforeAll(async () => {
  fixture = await creditDatabase(async (pool) => {
    for (const delta of [20, 50, 70]) {
      const id = randomUUID();
      historic.set(id, delta);
      await pool.query(
        "insert into assistant_credit_ledger(id,delta,reason,submission_id,venue_identity) values($1,$2,'submission_approved',gen_random_uuid(),$3)",
        [id, delta, `google:legacy-${id}`],
      );
    }
  });
});
afterAll(async () => {
  await fixture?.close();
});
describe('#829 S2 catalogue migration and writer readiness', () => {
  it('keeps sync/paused ownership and stable seed definitions, with no historical scan/attribution', async () => {
    await assertCreditWriterReady(fixture.db);
    expect(
      (await fixture.pool.query('select mode,epoch,first_activated_at from credit_cutover')).rows,
    ).toEqual([{ mode: 'sync', epoch: 0, first_activated_at: null }]);
    expect(
      (
        await fixture.pool.query(
          "select enabled from feature_flags where key='credit_events.enabled'",
        )
      ).rows.every((r) => r.enabled === false),
    ).toBe(true);
    const result = await fixture.pool.query(
      'select id,delta,credit_event_id from assistant_credit_ledger where id=any($1::uuid[])',
      [[...historic.keys()]],
    );
    for (const row of result.rows) {
      expect(row.delta).toBe(historic.get(row.id));
      expect(row.credit_event_id).toBeNull();
    }
    expect(
      (
        await fixture.pool.query(
          "select convalidated from pg_constraint where conname='assistant_credit_ledger_check'",
        )
      ).rows[0].convalidated,
    ).toBe(false);
  });
  it('rejects mismatched seeds and a named but invalid-shape index', async () => {
    await fixture.pool.query('update credit_events set amount=51 where id=$1', [
      CREDIT_SEEDS[0].id,
    ]);
    try {
      await expect(assertCreditWriterReady(fixture.db)).rejects.toMatchObject({
        code: 'CREDIT_SEED_MISMATCH',
      });
    } finally {
      await fixture.pool.query('update credit_events set amount=50 where id=$1', [
        CREDIT_SEEDS[0].id,
      ]);
    }
    await fixture.pool.query('drop index concurrently assistant_credit_event_user');
    await fixture.pool.query(
      'create index concurrently assistant_credit_event_user on assistant_credit_ledger(user_id,credit_event_id)',
    );
    try {
      await expect(assertCreditWriterReady(fixture.db)).rejects.toMatchObject({
        code: 'CREDIT_INDEX_NOT_READY',
      });
    } finally {
      await fixture.pool.query('drop index concurrently assistant_credit_event_user');
      await fixture.pool.query(
        'create index concurrently assistant_credit_event_user on assistant_credit_ledger(credit_event_id,user_id)',
      );
    }
  });
  it('accepts exactly legacy/spend/catalogue shapes while NOT VALID, with reason bound to catalogue key', async () => {
    const user = await creditUser(fixture.pool),
      submission = randomUUID();
    await fixture.pool.query(
      "insert into assistant_credit_ledger(user_id,delta,reason,submission_id,venue_identity,credit_event_id,entitlement_key) values($1,50,'submission_approved',$2,$3,$4,$5)",
      [user, submission, `google:${submission}`, CREDIT_SEEDS[0].id, `venue:google:${submission}`],
    );
    await fixture.pool.query(
      "insert into assistant_credit_ledger(delta,reason,credit_event_id,entitlement_key) values(10,'submission_evidence',$1,$2)",
      [CREDIT_SEEDS[1].id, `submission:${submission}`],
    );
    await fixture.pool.query(
      "insert into assistant_credit_ledger(delta,reason,credit_event_id,entitlement_key) values(5,'review_published',$1,'place:test:subject')",
      [CREDIT_SEEDS[2].id],
    );
    await fixture.pool.query(
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id) values(-1,'message_spent',gen_random_uuid())",
    );
    for (const statement of [
      "insert into assistant_credit_ledger(delta,reason,usage_ledger_id) values(-2,'message_spent',gen_random_uuid())",
      `insert into assistant_credit_ledger(delta,reason,credit_event_id) values(5,'review_published','${CREDIT_SEEDS[2].id}')`,
      `insert into assistant_credit_ledger(delta,reason,credit_event_id,entitlement_key) values(5,'wrong_key','${CREDIT_SEEDS[2].id}','key')`,
      "insert into assistant_credit_ledger(delta,reason) values(50,'unbound')",
    ])
      await expect(fixture.pool.query(statement)).rejects.toThrow();
  });
  it('commits bounded resumable attribution without changing historical deltas; validates separately', async () => {
    const first = await attributeLegacyCreditBatch(fixture.db, 1);
    expect(first.updated).toBe(1);
    expect(first.remaining).toBe(2);
    const second = await attributeLegacyCreditBatch(fixture.db, 1);
    expect(second.updated).toBe(1);
    const last = await attributeLegacyCreditBatch(fixture.db, 1000);
    expect(last).toEqual({ updated: 1, remaining: 0 });
    expect(await attributeLegacyCreditBatch(fixture.db)).toEqual({ updated: 0, remaining: 0 });
    for (const [id, delta] of historic) {
      const ledger = (
        await fixture.pool.query(
          'select delta,credit_event_id,entitlement_key from assistant_credit_ledger where id=$1',
          [id],
        )
      ).rows[0];
      expect(ledger.delta).toBe(delta);
      expect(ledger.credit_event_id).toBe(CREDIT_SEEDS[0].id);
      expect(ledger.entitlement_key).not.toContain('google:google:');
      const keys = (
        await fixture.pool.query(
          'select event_id,key from credit_entitlements where ledger_id=$1',
          [id],
        )
      ).rows;
      expect(keys).toHaveLength(delta === 50 ? 1 : 2);
    }
    await fixture.pool.query(await readFile(creditOps('validate-credit-events.sql'), 'utf8'));
    expect(
      (
        await fixture.pool.query(
          "select convalidated from pg_constraint where conname in ('assistant_credit_ledger_check','assistant_credit_event_reason_fk')",
        )
      ).rows.every((r) => r.convalidated),
    ).toBe(true);
    // Simulate an old writer finishing just before drain: a later scan must see it.
    await fixture.pool.query(
      "insert into assistant_credit_ledger(delta,reason,submission_id,venue_identity) values(70,'submission_approved',gen_random_uuid(),'google:late-old-writer')",
    );
    expect(await attributeLegacyCreditBatch(fixture.db)).toEqual({ updated: 1, remaining: 0 });
  });
});
