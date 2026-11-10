import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CreditEvaluator } from '../../../libs/modules/shared/credit-evaluator';
import { CREDIT_SEEDS } from '../../../libs/modules/shared/credit-catalogue';
import { CREDIT_TRIGGERS } from '../../../libs/modules/shared/credit-triggers';
import { creditDatabase, creditOutbox, creditUser } from './support/credit-events';
import type { Tx } from '../../../libs/modules/shared/outbox';
let f: Awaited<ReturnType<typeof creditDatabase>>;
let evaluator: CreditEvaluator;
const options = { environment: 'dev', subjectKeySecret: 's'.repeat(32) };
async function review(userId: string, placeId = randomUUID()) {
  return creditOutbox(f.pool, 'review.published', {
    reviewId: randomUUID(),
    userId,
    target: 'place',
    placeId,
    firstPublication: true,
    grantOwner: 'evaluator',
  });
}
async function groupRule(
  budget: number,
  maxPerUser: number | null = null,
  maxPerGroup: number | null = null,
) {
  return String(
    (
      await f.pool.query(
        `insert into credit_events(key,labels,trigger_event_type,trigger_schema_version,condition,audience,dedup_scope,amount,status,budget_total,max_per_user,max_per_group)
    values($1,'{"vi":"Nhóm","en":"Group"}','room.completed',2,'{"all":[]}', 'group','per_occurrence',10,'active',$2,$3,$4) returning id`,
        [`group_${randomUUID().replaceAll('-', '')}`, budget, maxPerUser, maxPerGroup],
      )
    ).rows[0].id,
  );
}
async function group(users: string[], roomId = randomUUID()) {
  return creditOutbox(f.pool, 'room.completed', {
    roomId,
    triggeredAt: new Date().toISOString(),
    room: { type: 'group', participantCount: users.length + 1 },
    plan: { stopsCompleted: 2 },
    subjects: users.map((userId) => ({ userId, memberId: randomUUID(), role: 'member' })),
    grantOwner: 'evaluator',
  });
}
beforeAll(async () => {
  f = await creditDatabase();
  evaluator = new CreditEvaluator(f.db, options);
});
afterAll(async () => {
  await f?.close();
});
describe('#829 S2 evaluator replay, concurrency and recovery', () => {
  it('leaves paused evaluator-owned backlog pending across sync rollback and protects retention', async () => {
    const id = await review(await creditUser(f.pool));
    expect(await evaluator.tick()).toBe(0);
    expect(
      (await f.pool.query('delete from outbox_events where id=$1 returning id', [id])).rows,
    ).toEqual([]);
    expect(
      (await f.pool.query('select * from credit_evaluations where event_id=$1', [id])).rows,
    ).toEqual([]);
    await f.pool.query("update credit_cutover set mode='sync'");
    await evaluator.evaluate(id);
    expect(
      (await f.pool.query('select grants from credit_evaluations where event_id=$1', [id])).rows,
    ).toEqual([{ grants: 1 }]);
  });
  it('two evaluators grant a delivery once; different deliveries share the same business entitlement', async () => {
    const user = await creditUser(f.pool),
      place = randomUUID();
    const a = await review(user, place),
      b = await review(user, place);
    await Promise.all([
      evaluator.evaluate(a),
      new CreditEvaluator(f.db, options).evaluate(a),
      evaluator.evaluate(b),
    ]);
    expect(
      (await f.pool.query('select balance from assistant_credit_accounts where user_id=$1', [user]))
        .rows,
    ).toEqual([{ balance: 5 }]);
    expect(
      (
        await f.pool.query(
          'select sum(grants)::int as grants from credit_evaluations where event_id=any($1::uuid[])',
          [[a, b]],
        )
      ).rows,
    ).toEqual([{ grants: 1 }]);
  });
  it('late-visible/dead-lettered notification rows are selected without a cursor', async () => {
    const user = await creditUser(f.pool),
      later = await review(user);
    await evaluator.evaluate(later);
    const late = await review(user);
    await f.pool.query(
      "update outbox_events set occurred_at=now()-interval '1 day',failed_at=now(),attempts=20 where id=$1",
      [late],
    );
    await f.pool.query(
      "insert into feature_flags(key,environment,platform,enabled) values('credit_events.enabled','all','all',true) on conflict(key,environment,platform) do update set enabled=true",
    );
    try {
      await evaluator.tick();
    } finally {
      await f.pool.query(
        "update feature_flags set enabled=false where key='credit_events.enabled'",
      );
    }
    expect(
      (await f.pool.query('select grants from credit_evaluations where event_id=$1', [late])).rows,
    ).toEqual([{ grants: 1 }]);
  });
  it('unknown decoder quarantines without a terminal ack; a decoder repair drains it', async () => {
    const id = await review(await creditUser(f.pool));
    await f.pool.query('update outbox_events set payload_schema_version=3 where id=$1', [id]);
    await evaluator.evaluate(id);
    expect(
      (await f.pool.query('select status from credit_evaluations where event_id=$1', [id])).rows,
    ).toEqual([{ status: 'quarantined' }]);
    expect(
      (await f.pool.query('delete from outbox_events where id=$1 returning id', [id])).rows,
    ).toEqual([]);
    const decoders = CREDIT_TRIGGERS['review.published']!.decoders;
    decoders[3] = decoders[2]!;
    try {
      await evaluator.evaluate(id);
    } finally {
      delete decoders[3];
    }
    expect(
      (await f.pool.query('select status,grants from credit_evaluations where event_id=$1', [id]))
        .rows,
    ).toEqual([{ status: 'evaluated', grants: 1 }]);
  });
  it('failure after balance writes but before ack rolls back budget, balance, entitlements and audit', async () => {
    const user = await creditUser(f.pool),
      id = await review(user),
      dialect = new PgDialect();
    const failingDb = new Proxy(f.db, {
      get(target, key) {
        if (key !== 'transaction') return Reflect.get(target, key);
        return (work: (tx: Tx) => Promise<void>) =>
          target.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property !== 'execute') return Reflect.get(transaction, property);
                  return async (q: SQL) => {
                    if (dialect.sqlToQuery(q).sql.includes('insert into credit_evaluations'))
                      throw new Error('crash before ack');
                    return transaction.execute(q);
                  };
                },
              }),
            ),
          );
      },
    });
    const before = (
      await f.pool.query('select budget_used from credit_events where id=$1', [CREDIT_SEEDS[2].id])
    ).rows[0].budget_used;
    await expect(new CreditEvaluator(failingDb, options).evaluate(id)).rejects.toThrow(
      'crash before ack',
    );
    expect(
      (await f.pool.query('select * from assistant_credit_accounts where user_id=$1', [user])).rows,
    ).toEqual([]);
    expect(
      (
        await f.pool.query('select budget_used from credit_events where id=$1', [
          CREDIT_SEEDS[2].id,
        ])
      ).rows[0].budget_used,
    ).toBe(before);
    await evaluator.evaluate(id);
    expect(
      (await f.pool.query('select balance from assistant_credit_accounts where user_id=$1', [user]))
        .rows[0].balance,
    ).toBe(5);
  });
  it('concurrent per-user capped reviews grant once under rule/account locks', async () => {
    const user = await creditUser(f.pool);
    await f.pool.query('update credit_events set max_per_user=1 where id=$1', [CREDIT_SEEDS[2].id]);
    try {
      await Promise.all([
        evaluator.evaluate(await review(user)),
        evaluator.evaluate(await review(user)),
      ]);
    } finally {
      await f.pool.query('update credit_events set max_per_user=null where id=$1', [
        CREDIT_SEEDS[2].id,
      ]);
    }
    expect(
      (await f.pool.query('select balance from assistant_credit_accounts where user_id=$1', [user]))
        .rows[0].balance,
    ).toBe(5);
  });
  it('group budget is all-or-none and overlapping workers never overspend; group caps survive distinct occurrences', async () => {
    const users = await Promise.all(Array.from({ length: 3 }, () => creditUser(f.pool)));
    const rule = await groupRule(20);
    const a = await group(users);
    await evaluator.evaluate(a);
    expect(
      (await f.pool.query('select budget_used from credit_events where id=$1', [rule])).rows[0]
        .budget_used,
    ).toBe(0);
    await f.pool.query('update credit_events set budget_total=30,max_per_group=1 where id=$1', [
      rule,
    ]);
    const room = randomUUID();
    const b = await group(users, room),
      c = await group(users, room);
    await Promise.all([evaluator.evaluate(b), evaluator.evaluate(c)]);
    expect(
      (await f.pool.query('select budget_used,status from credit_events where id=$1', [rule])).rows,
    ).toEqual([{ budget_used: 30, status: 'closed' }]);
    expect(
      (
        await f.pool.query(
          'select count(*)::int as n,count(distinct group_grant_id)::int as groups from assistant_credit_ledger where credit_event_id=$1',
          [rule],
        )
      ).rows,
    ).toEqual([{ n: 3, groups: 1 }]);
    // Separate cap proof with spare budget, per_occurrence keys and identical room.
    const capped = await groupRule(100, null, 1);
    await Promise.all([
      evaluator.evaluate(await group(users, room)),
      evaluator.evaluate(await group(users, room)),
    ]);
    expect(
      (await f.pool.query('select budget_used from credit_events where id=$1', [capped])).rows[0]
        .budget_used,
    ).toBe(30);
    await f.pool.query("update credit_events set status='closed' where id=$1", [capped]);
  });
});
