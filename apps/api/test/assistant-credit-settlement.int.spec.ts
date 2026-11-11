import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { NoopMetrics } from '@gogo/observability';
import { resetBreakers } from '../../../libs/providers/src/resilience';
import { OpenRouterDecisionProvider, type AssistantCostReceipt } from '@gogo/providers';
import { creditDatabase, creditUser } from './support/credit-events';
import { AssistantUsageEvidenceRepository } from '../../../libs/modules/assistant/infrastructure/assistant-usage-evidence.repository';
import { AssistantCreditSettlementService } from '../../../libs/modules/assistant/application/assistant-credit-settlement.service';
import { AssistantCreditSettlementWorker } from '../../worker/src/assistant-credit-settlement';
import {
  eraseAssistantDataForUser,
  collectAssistantCreditExport,
  purgeAssistantRetention,
} from '../../../libs/modules/assistant/application/assistant-privacy';
let f: Awaited<ReturnType<typeof creditDatabase>>;
let evidence: AssistantUsageEvidenceRepository;
const signal = new AbortController().signal;
beforeAll(async () => {
  f = await creditDatabase();
  evidence = new AssistantUsageEvidenceRepository(f.db);
}, 240000);
afterAll(async () => {
  await f?.close();
});
beforeEach(async () => {
  resetBreakers();
  await f.pool.query(
    "insert into feature_flags(key,environment,platform,enabled) values('assistant.enabled','all','all',true),('assistant_credits.settlement_enabled','all','all',true) on conflict(key,environment,platform) do update set enabled=true",
  );
});
async function turn(free = false) {
  const userId = await creditUser(f.pool),
    usageId = randomUUID(),
    messageId = randomUUID(),
    conversationId = randomUUID();
  await f.db.transaction(async (tx) => {
    await tx.execute(
      sql`insert into assistant_conversations(id,user_id) values(${conversationId},${userId})`,
    );
    await tx.execute(
      sql`insert into assistant_messages(id,user_id,conversation_id,role,status,lease_expires_at) values(${messageId},${userId},${conversationId},'assistant','streaming',now()+interval '1 hour')`,
    );
    await tx.execute(sql`insert into assistant_usage_ledger(id,user_id,message_id,billing_policy,billing_epoch,allowance_source)
      values(${usageId},${userId},${messageId},'free_then_actual_cost_v1',1,${free ? 'daily' : 'credit'})`);
    await tx.execute(sql`insert into assistant_credit_turns(usage_ledger_id,user_id,message_id,conversation_id,accepted_at,free_day,policy_key,policy_epoch,
      funding_source,reserved_ceiling,held_credits,applied_credits,bound_version,state,finalized_at)
      values(${usageId},${userId},${messageId},${conversationId},now(),case when ${free} then current_date else null end,'free_then_actual_cost_v1',1,
      ${free ? 'free' : 'credit'},${free ? 0 : 20},${free ? 0 : 20},0,${free ? null : 'fixture-only'},${free ? 'settled' : 'pending'},case when ${free} then now() else null end)`);
    if (!free) {
      await tx.execute(
        sql`insert into assistant_credit_accounts(user_id,balance) values(${userId},50)`,
      );
      await tx.execute(sql`insert into assistant_credit_ledger(user_id,delta,reason,submission_id,venue_identity)
        values(${userId},50,'submission_approved',${randomUUID()},${randomUUID()})`);
    }
  });
  return { userId, usageId, messageId, conversationId };
}
const receipt = (revision: bigint, cost: string, final = false): AssistantCostReceipt => ({
  revision,
  direct: cost,
  upstream: '0',
  fee: '0',
  final,
});
async function end(t: Awaited<ReturnType<typeof turn>>) {
  await f.db.execute(sql`update assistant_messages set status='failed' where id=${t.messageId}`);
  await evidence.closeDispatch(t.usageId);
}
async function facts(t: Awaited<ReturnType<typeof turn>>) {
  const r = await f.db.execute(sql`select t.applied_credits a,t.held_credits h,t.state,
    coalesce((select balance from assistant_credit_accounts where user_id=${t.userId}),0)::int balance,
    (select count(*)::int from assistant_credit_ledger where usage_ledger_id=t.usage_ledger_id and reason='message_spent') bases,
    (select coalesce(sum(delta),0)::int from assistant_credit_ledger where usage_ledger_id=t.usage_ledger_id) net
    from assistant_credit_turns t where usage_ledger_id=${t.usageId}`);
  return r.rows[0];
}
const service = (db: Db = f.db) =>
  new AssistantCreditSettlementService(db, 'dev', new NoopMetrics());
describe('#853 D06 durable settlement recovery', () => {
  it('R20→12 final, absorb 14, refund to 10, duplicate/reordered evidence and late refund', async () => {
    const t = await turn();
    await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
    await end(t);
    for (const [revision, cost, a, h] of [
      [1n, '0.00012', 12, 0],
      [2n, '0.00014', 12, 0],
      [3n, '0.00010', 10, 0],
    ] as const) {
      expect(await evidence.ingest(t.usageId, 0, receipt(revision, cost))).toBe('ingested');
      await Promise.all([
        service().reconcile(t.usageId, signal),
        service().reconcile(t.usageId, signal),
      ]);
      expect(await facts(t)).toMatchObject({ a, h, balance: 50 - a, net: -a, bases: 1 });
      expect(await evidence.ingest(t.usageId, 0, receipt(revision, cost))).toBe('duplicate');
    }
    expect(await evidence.ingest(t.usageId, 0, receipt(2n, '0.00014'))).toBe('duplicate');
    expect(await evidence.ingest(t.usageId, 0, receipt(2n, '0.00011'))).toBe('stale');
    await evidence.ingest(t.usageId, 0, receipt(4n, '0.00010', true));
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 10, h: 0, balance: 40, net: -10, state: 'settled' });
    await evidence.ingest(t.usageId, 0, receipt(5n, '0.00004', true));
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 4, h: 0, balance: 46, net: -4, bases: 1 });
  });
  it.each([[['0', '0.00007', '0', '0.00007']], [['0.00012', '0', '0.00008']]])(
    'final charge never grows after refund-to-zero: %j',
    async (sequence) => {
      const t = await turn();
      await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
      await end(t);
      for (const [i, cost] of sequence.entries()) {
        await evidence.ingest(t.usageId, 0, receipt(BigInt(i + 1), cost));
        await service().reconcile(t.usageId, signal);
      }
      expect(await facts(t)).toMatchObject({ bases: sequence[0] === '0' ? 0 : 1, a: 0, h: 0 });
    },
  );
  it('crash before commit rolls back debit/account/revision/marker; after commit before ACK deduplicates', async () => {
    const t = await turn();
    await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.00012', true));
    let inject = true;
    const crashing = new Proxy(f.db, {
      get(target, key) {
        if (key === 'transaction')
          return async (fn: Parameters<Db['transaction']>[0]) =>
            target.transaction(async (tx) => {
              const value = await fn(tx);
              if (inject && value === 'applied') {
                inject = false;
                throw new Error('before commit');
              }
              return value;
            });
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(service(crashing).reconcile(t.usageId, signal)).rejects.toThrow('before commit');
    expect(await facts(t)).toMatchObject({ a: 0, h: 20, net: 0, balance: 50 });
    await service().reconcile(t.usageId, signal); // crash now: no ACK
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 12, h: 0, net: -12, bases: 1, balance: 38 });
  });
  it.each(['over-bound', 'invalid', 'overflow', 'same-version-conflict'])(
    'quarantines %s without debt or clipping',
    async (scenario) => {
      const t = await turn();
      await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
      await end(t);
      if (scenario === 'same-version-conflict') {
        await evidence.ingest(t.usageId, 0, receipt(1n, '0.0001'));
        await service().reconcile(t.usageId, signal);
      }
      await evidence.ingest(
        t.usageId,
        0,
        receipt(
          1n,
          scenario === 'invalid'
            ? '-1'
            : scenario === 'overflow'
              ? '999999'
              : scenario === 'same-version-conflict'
                ? '0.00009'
                : '0.00021',
          true,
        ),
      );
      await service().reconcile(t.usageId, signal);
      expect(await facts(t)).toMatchObject({
        state: 'quarantined',
        balance: scenario === 'same-version-conflict' ? 40 : 50,
      });
    },
  );
  it('sweep repairs a lost wakeup and retries while settlement is paused, never dispatching calls', async () => {
    const t = await turn();
    await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.00012', true));
    await f.pool.query('update outbox_events set published_at=now() where resource_id=$1', [
      t.usageId,
    ]);
    await f.pool.query(
      "update feature_flags set enabled=false where key='assistant_credits.settlement_enabled'",
    );
    const worker = new AssistantCreditSettlementWorker(f.db, service());
    await worker.tick(signal);
    expect(await facts(t)).toMatchObject({ a: 0, h: 20 });
    await f.pool.query(
      "update feature_flags set enabled=true where key='assistant_credits.settlement_enabled'",
    );
    await f.pool.query(
      'update assistant_credit_turns set next_reconcile_at=now() where usage_ledger_id=$1',
      [t.usageId],
    );
    await worker.tick(signal);
    expect(await facts(t)).toMatchObject({ a: 12, h: 0, bases: 1 });
  });
});
describe('#853 D07 provider failure boundaries', () => {
  it.each([false, true])(
    'free=%s: kill before dispatch proves zero, but ambiguous dispatch retains funding',
    async (free) => {
      const t = await turn(free);
      await end(t);
      await service().reconcile(t.usageId, signal);
      expect(await facts(t)).toMatchObject({ a: 0, h: 0, state: 'settled' });
      const other = await turn(free);
      const observer = evidence.observer({ ...other, ledgerId: other.usageId }, 'dev');
      await observer.start('jev', 'fixture/model');
      await end(other);
      await service().reconcile(other.usageId, signal);
      expect(await facts(other)).toMatchObject({
        a: 0,
        h: free ? 0 : 20,
        state: free ? 'settled' : 'pending',
      });
      await expect(observer.start('jev', 'fixture/model')).rejects.toThrow('Dispatch fenced');
    },
  );
  it.each([false, true])(
    'free=%s: crash after receipt/done before cost write recovers by identity, without redispatch',
    async (free) => {
      const t = await turn(free),
        base = evidence.observer({ ...t, ledgerId: t.usageId }, 'dev');
      const billing = {
        start: async (provider: 'jev' | 'haiku', model: string) => {
          const recorder = await base.start(provider, model);
          return {
            ...recorder,
            receipt: async () => {
              throw new Error('crash before cost write');
            },
          };
        },
      };
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            '{"id":"gen-recovery","model":"fixture/jev","usage":{"cost":0.00012},"answers":{}}',
          ),
      );
      const provider = new OpenRouterDecisionProvider({
        apiKey: 'fixture',
        model: 'fixture/jev',
        timeoutMs: 1000,
        fetchImpl,
      });
      await expect(
        provider.decide({ state: 'fixture', questions: {} }, { billing }),
      ).rejects.toThrow();
      // Durable terminal message, but the runner died before close/completeLedger.
      await f.pool.query("update assistant_messages set status='complete' where id=$1", [
        t.messageId,
      ]);
      const read = vi.fn(async () => {
        throw new Error('receipt retrieval unavailable');
      });
      const unavailable = new AssistantCreditSettlementService(f.db, 'dev', new NoopMetrics(), {
        read,
      });
      await f.pool.query(
        "update assistant_credit_turns set accepted_at=now()-interval '6 minutes' where usage_ledger_id=$1",
        [t.usageId],
      );
      expect(await unavailable.reconcile(t.usageId, signal)).toBe(free ? 'ignored' : 'pending');
      expect(await facts(t)).toMatchObject({ a: 0, h: free ? 0 : 20 });
      await f.pool.query(
        'update assistant_credit_turns set recovery_next_at=now() where usage_ledger_id=$1',
        [t.usageId],
      );
      const recovered = new AssistantCreditSettlementService(f.db, 'dev', new NoopMetrics(), {
        read: async () => receipt(2n, '0.00012', true),
      });
      await recovered.reconcile(t.usageId, signal);
      expect(await facts(t)).toMatchObject({ a: free ? 0 : 12, h: 0, state: 'settled' });
      expect(read).toHaveBeenCalledTimes(free ? 0 : 1);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
  it('crash after intent before dispatch claim is provably zero only after fencing', async () => {
    const t = await turn();
    let transactions = 0;
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key === 'transaction')
          return async (fn: Parameters<Db['transaction']>[0]) => {
            if (++transactions === 2) throw new Error('dispatch claim crash');
            return target.transaction(fn);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const billing = new AssistantUsageEvidenceRepository(db).observer(
      { ...t, ledgerId: t.usageId },
      'dev',
    );
    const fetchImpl = vi.fn();
    const provider = new OpenRouterDecisionProvider({
      apiKey: 'fixture',
      model: 'fixture/jev',
      timeoutMs: 1000,
      fetchImpl,
    });
    await expect(
      provider.decide({ state: 'fixture', questions: {} }, { billing }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await facts(t)).toMatchObject({ h: 20 });
    await end(t);
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ h: 0, a: 0, state: 'settled' });
  });
  it('billable timeout and explicit retry create distinct attempts; missing receipt never partially charges', async () => {
    const t = await turn();
    const billing = evidence.observer({ ...t, ledgerId: t.usageId }, 'dev');
    const fetchImpl = vi.fn(async () => {
      throw new Error('lost connection after dispatch');
    });
    const provider = new OpenRouterDecisionProvider({
      apiKey: 'fixture',
      model: 'fixture/jev',
      timeoutMs: 1000,
      fetchImpl,
    });
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        provider.decide({ state: 'fixture', questions: {} }, { billing }),
      ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.000004', true));
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 0, h: 20 });
    await evidence.ingest(t.usageId, 1, receipt(1n, '0.000004', true));
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 1, h: 0, net: -1 });
  });
});
describe('#853 D11 erasure and retention', () => {
  it('erasure racing settlement scrubs linkage/queue and late receipts cannot recreate a wallet', async () => {
    const t = await turn();
    const call = await evidence
      .observer({ ...t, ledgerId: t.usageId }, 'dev')
      .start('jev', 'fixture/model');
    await call.generation('gen-private');
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.00012', true));
    await Promise.all([
      service().reconcile(t.usageId, signal),
      f.db.transaction((tx) => eraseAssistantDataForUser(tx, t.userId)),
    ]);
    await evidence.ingest(t.usageId, 0, receipt(2n, '0.00014', true));
    await service().reconcile(t.usageId, signal);
    expect(
      (
        await f.pool.query(
          'select user_id,message_id,conversation_id,held_credits,state from assistant_credit_turns where usage_ledger_id=$1',
          [t.usageId],
        )
      ).rows[0],
    ).toEqual({
      user_id: null,
      message_id: null,
      conversation_id: null,
      held_credits: 0,
      state: 'erased',
    });
    expect(
      (
        await f.pool.query(
          'select provider_request_id,provider_generation_id,correlation_id from assistant_usage_calls where usage_ledger_id=$1',
          [t.usageId],
        )
      ).rows[0],
    ).toEqual({ provider_request_id: null, provider_generation_id: null, correlation_id: null });
    expect(
      (await f.pool.query('select * from assistant_credit_accounts where user_id=$1', [t.userId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "select * from outbox_events where event_type in ('assistant.cost_reconcile','assistant.credit_applied') and resource_id=$1",
          [t.usageId],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('erasing a disputed turn preserves the scrubbed billing incident safety block', async () => {
    const t = await turn();
    await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.00021', true));
    await service().reconcile(t.usageId, signal);
    await f.db.transaction((tx) => eraseAssistantDataForUser(tx, t.userId));
    expect(
      (
        await f.pool.query(
          'select reason,resolved_at from assistant_credit_billing_incidents where usage_ledger_id=$1',
          [t.usageId],
        )
      ).rows,
    ).toEqual([{ reason: 'bound_or_finality', resolved_at: null }]);
  });
  it('conversation deletion preserves holds, unresolved >400-day usage survives, own export excludes provider IDs', async () => {
    const t = await turn();
    const call = await evidence
      .observer({ ...t, ledgerId: t.usageId }, 'dev')
      .start('jev', 'fixture/model');
    await call.generation('gen-private');
    const charge = vi.fn();
    const exported = await collectAssistantCreditExport(f.db, t.userId, charge);
    expect(exported).toMatchObject({ balance: 50, reserved: 20, available: 30 });
    expect(JSON.stringify(exported)).not.toContain('gen-private');
    await f.pool.query('delete from assistant_conversations where id=$1', [t.conversationId]);
    await f.pool.query(
      "update assistant_usage_ledger set accepted_at=now()-interval '401 days' where id=$1",
      [t.usageId],
    );
    await purgeAssistantRetention(f.db, false);
    expect(
      (await f.pool.query('select * from assistant_usage_ledger where id=$1', [t.usageId]))
        .rowCount,
    ).toBe(1);
    expect(await facts(t)).toMatchObject({ h: 20, a: 0 });
  });
});

describe('#853 policy A bounded recovery and finality', () => {
  it.each([false, true])(
    'inline cost is final at ingestion; free=%s never polls or reschedules',
    async (free) => {
      const t = await turn(free);
      const call = await evidence
        .observer({ ...t, ledgerId: t.usageId }, 'dev')
        .start('jev', 'fixture/model');
      await call.receipt({ ...receipt(1n, '0.00012'), generationId: 'gen-inline' });
      const stored = await f.pool.query(
        'select cost_state,finality_policy from assistant_usage_calls where usage_ledger_id=$1',
        [t.usageId],
      );
      expect(stored.rows[0]).toEqual({ cost_state: 'final', finality_policy: 'inline_receipt_v1' });
      await end(t);
      const read = vi.fn(async () => receipt(2n, '0.00014'));
      const settlement = new AssistantCreditSettlementService(f.db, 'dev', new NoopMetrics(), {
        read,
      });
      const worker = new AssistantCreditSettlementWorker(f.db, settlement);
      for (let tick = 0; tick < 12; tick++) await worker.tick(signal);
      expect(read).not.toHaveBeenCalled();
      expect(await facts(t)).toMatchObject({ a: free ? 0 : 12, h: 0, state: 'settled' });
      expect(
        (
          await f.pool.query(
            'select next_reconcile_at from assistant_credit_turns where usage_ledger_id=$1',
            [t.usageId],
          )
        ).rows[0].next_reconcile_at,
      ).toBeNull();
    },
  );
  it('free unknown cost neither recovers, charges, quarantines nor reschedules after 24h', async () => {
    const t = await turn(true);
    const call = await evidence
      .observer({ ...t, ledgerId: t.usageId }, 'dev')
      .start('jev', 'fixture/model');
    await call.generation('gen-free-unknown');
    await end(t);
    await f.pool.query(
      "update assistant_credit_turns set accepted_at=now()-interval '25 hours' where usage_ledger_id=$1",
      [t.usageId],
    );
    const read = vi.fn(async () => null);
    const settlement = new AssistantCreditSettlementService(f.db, 'dev', new NoopMetrics(), {
      read,
    });
    const worker = new AssistantCreditSettlementWorker(f.db, settlement);
    for (let tick = 0; tick < 12; tick++) await worker.tick(signal);
    expect(read).not.toHaveBeenCalled();
    expect(await facts(t)).toMatchObject({ a: 0, h: 0, state: 'settled', bases: 0 });
    expect(
      (
        await f.pool.query(
          'select next_reconcile_at,recovery_attempts from assistant_credit_turns where usage_ledger_id=$1',
          [t.usageId],
        )
      ).rows[0],
    ).toEqual({ next_reconcile_at: null, recovery_attempts: 0 });
  });
  it.each([0, 1, 5, 19, 83])(
    'GETs per usage <=5 regardless of %s extra ticks, calls or overlapping deliveries',
    async (extraTicks) => {
      const t = await turn();
      for (let i = 0; i < 9; i++) {
        const call = await evidence
          .observer({ ...t, ledgerId: t.usageId }, 'dev')
          .start('jev', 'fixture/model');
        await call.generation('gen-' + i);
      }
      await end(t);
      const read = vi.fn(async () => null);
      const settlement = new AssistantCreditSettlementService(f.db, 'dev', new NoopMetrics(), {
        read,
      });
      await settlement.reconcile(t.usageId, signal); // before first 5m, no request
      expect(read).not.toHaveBeenCalled();
      await f.pool.query(
        "update assistant_credit_turns set accepted_at=now()-interval '6 minutes' where usage_ledger_id=$1",
        [t.usageId],
      );
      for (let tick = 0; tick < 5 + extraTicks; tick++) {
        // Force eligibility: even adversarial ticks cannot replenish the durable budget.
        await f.pool.query(
          'update assistant_credit_turns set recovery_next_at=now() where usage_ledger_id=$1',
          [t.usageId],
        );
        await Promise.all([
          settlement.reconcile(t.usageId, signal),
          settlement.reconcile(t.usageId, signal),
        ]);
      }
      expect(read).toHaveBeenCalledTimes(5);
      expect(
        (
          await f.pool.query(
            'select recovery_attempts from assistant_credit_turns where usage_ledger_id=$1',
            [t.usageId],
          )
        ).rows[0].recovery_attempts,
      ).toBe(5);
      expect(await facts(t)).toMatchObject({ a: 0, h: 20, state: 'pending' });
    },
  );
  it.each([false, true])(
    '24h unknown cost quarantines with or without generation ID (%s), retaining funding',
    async (withId) => {
      const t = await turn();
      const call = await evidence
        .observer({ ...t, ledgerId: t.usageId }, 'dev')
        .start('jev', 'fixture/model');
      if (withId) await call.generation('gen-missing');
      await end(t);
      await f.pool.query(
        "update assistant_credit_turns set accepted_at=now()-interval '24 hours' where usage_ledger_id=$1",
        [t.usageId],
      );
      const increment = vi.fn();
      const read = vi.fn(async () => null);
      const settlement = new AssistantCreditSettlementService(f.db, 'dev', { increment } as never, {
        read,
      });
      await settlement.reconcile(t.usageId, signal);
      expect(read).not.toHaveBeenCalled();
      expect(await facts(t)).toMatchObject({ a: 0, h: 20, state: 'quarantined', balance: 50 });
      expect(increment).toHaveBeenCalledWith('assistant_credit_bound_violation_total', {
        reason: 'receipt_missing',
      });
      expect(
        (
          await f.pool.query(
            'select reason from assistant_credit_billing_incidents where usage_ledger_id=$1',
            [t.usageId],
          )
        ).rows,
      ).toEqual([{ reason: 'receipt_missing' }]);
    },
  );
  it('post-final upward cost before/after settlement is journaled and absorbed; normal downward receipt refunds', async () => {
    const t = await turn();
    const increment = vi.fn();
    const repo = new AssistantUsageEvidenceRepository(f.db, { increment } as never);
    const call = await repo
      .observer({ ...t, ledgerId: t.usageId }, 'dev')
      .start('jev', 'fixture/model');
    await call.receipt(receipt(1n, '0.00012'));
    await end(t);
    await repo.ingest(t.usageId, 0, receipt(2n, '0.00014'));
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 12, h: 0, balance: 38, state: 'settled' });
    await repo.ingest(t.usageId, 0, receipt(3n, '0.00015'));
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 12, h: 0, balance: 38, state: 'settled' });
    expect(
      (
        await f.pool.query(
          'select direct_cost_usd::text,billable_cost_usd::text,cost_state from assistant_usage_calls where usage_ledger_id=$1',
          [t.usageId],
        )
      ).rows[0],
    ).toMatchObject({
      direct_cost_usd: '0.00015',
      billable_cost_usd: '0.00012',
      cost_state: 'final',
    });
    expect(increment).toHaveBeenCalledWith('assistant_credit_post_final_cost_absorbed_total', {});
    await repo.ingest(t.usageId, 0, receipt(4n, '0.00010'));
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 10, h: 0, balance: 40, state: 'settled' });
  });
});

// Real PostgreSQL regressions in this suite's Testcontainer. Barriers hold exact
// transaction boundaries; lock waits are observed in pg_stat_activity.
function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
const dialect = new PgDialect();
function observedDb(
  after: (query: { sql: string; params: unknown[] }, tx: Pick<Db, 'execute'>) => Promise<void>,
) {
  const wrap = <T extends Pick<Db, 'execute'>>(target: T): T =>
    new Proxy(target, {
      get(object, key) {
        if (key === 'execute')
          return async (query: SQL) => {
            const value = await object.execute(query);
            await after(dialect.sqlToQuery(query), object);
            return value;
          };
        const value = Reflect.get(object, key);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return new Proxy(wrap(f.db), {
    get(object, key) {
      if (key === 'transaction')
        return (fn: Parameters<Db['transaction']>[0]) => f.db.transaction((tx) => fn(wrap(tx)));
      return Reflect.get(object, key);
    },
  });
}

describe('#858 Astra round 1 DB regressions', () => {
  beforeEach(async () => {
    // Keep other cases' accounting evidence, without delivering their work here.
    await f.pool.query(
      "update outbox_events set published_at=now() where event_type='assistant.cost_reconcile'",
    );
    await f.pool.query(
      "update assistant_credit_turns set next_reconcile_at=now()+interval '1 year' where state in ('pending','reconciling','settled')",
    );
  });

  it('F-01 retains a >400-day settled usage with an unapplied 12→10 refund, then purges after application', async () => {
    const t = await turn();
    const call = await evidence
      .observer({ ...t, ledgerId: t.usageId }, 'dev')
      .start('jev', 'fixture/model');
    await call.generation('gen-retention-refund');
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.00012', true));
    await service().reconcile(t.usageId, signal);
    await f.pool.query(
      "update assistant_usage_ledger set accepted_at=now()-interval '401 days' where id=$1",
      [t.usageId],
    );
    await evidence.ingest(t.usageId, 0, receipt(2n, '0.00010', true));
    const dry = await purgeAssistantRetention(f.db, true);
    await purgeAssistantRetention(f.db, false);
    expect(
      (await f.pool.query('select id from assistant_usage_ledger where id=$1', [t.usageId]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await f.pool.query(
          'select provider_generation_id from assistant_usage_calls where usage_ledger_id=$1',
          [t.usageId],
        )
      ).rows[0],
    ).toEqual({ provider_generation_id: 'gen-retention-refund' });
    await service().reconcile(t.usageId, signal);
    expect(await facts(t)).toMatchObject({ a: 10, h: 0, balance: 40, net: -10 });
    expect((await purgeAssistantRetention(f.db, true)).assistantLedgerRowsPurged).toBe(
      dry.assistantLedgerRowsPurged + 1,
    );
    await purgeAssistantRetention(f.db, false);
    expect(
      (await f.pool.query('select id from assistant_usage_ledger where id=$1', [t.usageId]))
        .rowCount,
    ).toBe(0);
  });

  it('F-01 holds the ingestion account lock through retention correlation scrub and deletion', async () => {
    const t = await turn();
    await end(t);
    await service().reconcile(t.usageId, signal);
    await f.pool.query(
      "update assistant_usage_ledger set accepted_at=now()-interval '401 days' where id=$1",
      [t.usageId],
    );
    const scrubbed = barrier(),
      finish = barrier();
    const db = observedDb(async (query) => {
      if (query.sql.includes('update assistant_usage_calls c set provider_request_id=null')) {
        scrubbed.release();
        await finish.reached;
      }
    });
    const purge = purgeAssistantRetention(db, false);
    try {
      await scrubbed.reached;
      const lock = await f.pool.query(
        'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired',
        [`assistant:${t.userId}`],
      );
      expect(lock.rows[0].acquired).toBe(false);
    } finally {
      finish.release();
      await purge;
    }
    expect(
      (await f.pool.query('select id from assistant_usage_ledger where id=$1', [t.usageId]))
        .rowCount,
    ).toBe(0);
  });

  it('F-02 erasure overlapping worker completion cannot deadlock or restore scrubbed queue linkage', async () => {
    const t = await turn();
    await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.00012', true));
    const lockedTurn = barrier(),
      finish = barrier();
    const db = observedDb(async (query) => {
      if (
        query.sql.includes('returning usage_ledger_id,next_reconcile_at') &&
        query.params.includes(t.usageId)
      ) {
        lockedTurn.release();
        await finish.reached;
      }
    });
    const tick = new AssistantCreditSettlementWorker(db, service()).tick(signal);
    await lockedTurn.reached;
    let erasurePid = 0;
    const erase = f.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout='10s'`);
      erasurePid = Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
      await eraseAssistantDataForUser(tx, t.userId);
    });
    const outcomes = Promise.allSettled([tick, erase]);
    try {
      await vi.waitFor(
        async () => {
          expect(erasurePid).toBeGreaterThan(0);
          const waiting = await f.pool.query(
            'select wait_event_type from pg_stat_activity where pid=$1',
            [erasurePid],
          );
          expect(waiting.rows[0]?.wait_event_type).toBe('Lock');
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      finish.release();
    }
    expect((await outcomes).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await facts(t)).toMatchObject({ state: 'erased', h: 0 });
    expect(
      (
        await f.pool.query(
          "select count(*)::int n from outbox_events where resource_id=$1 and event_type in ('assistant.cost_reconcile','assistant.credit_applied')",
          [t.usageId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('F-04 excludes settled history from sweep work, discovers initial holds and repairs lost refund wakeups', async () => {
    const t = await turn();
    await evidence.observer({ ...t, ledgerId: t.usageId }, 'dev').start('jev', 'fixture/model');
    await end(t);
    await evidence.ingest(t.usageId, 0, receipt(1n, '0.00012', true));
    const settlement = service();
    await new AssistantCreditSettlementWorker(f.db, settlement).tick(signal);
    await evidence.ingest(t.usageId, 0, receipt(2n, '0.00010', true));
    await f.pool.query('update outbox_events set published_at=now() where resource_id=$1', [
      t.usageId,
    ]);
    const initial = await turn(); // Reservation discovery, before any enqueue.
    await f.pool.query(
      `with history as (
      insert into assistant_usage_ledger(user_id,billing_policy,billing_epoch,allowance_source,
        dispatch_closed_at,cost_finalized_at,cost_revision)
      select $1,'free_then_actual_cost_v1',1,'credit',now(),now(),1 from generate_series(1,5000)
      returning id,user_id,accepted_at
    ) insert into assistant_credit_turns(usage_ledger_id,user_id,accepted_at,policy_key,policy_epoch,
      funding_source,reserved_ceiling,held_credits,applied_credits,bound_version,state,finalized_at,cost_revision,applied_cost_revision)
      select id,user_id,accepted_at,'free_then_actual_cost_v1',1,'credit',20,0,12,'fixture-only','settled',now(),1,1 from history`,
      [t.userId],
    );
    await f.pool.query('analyze assistant_credit_turns');
    await f.pool.query('analyze assistant_usage_ledger');
    const sweeps: { sql: string; params: unknown[] }[] = [];
    const db = observedDb(async (q) => {
      if (q.sql.includes('select usage_ledger_id from assistant_credit_turns')) sweeps.push(q);
    });
    const reconcile = vi.spyOn(settlement, 'reconcile');
    await new AssistantCreditSettlementWorker(db, settlement).tick(signal, 10);
    expect(reconcile.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining([initial.usageId, t.usageId]),
    );
    expect(await facts(t)).toMatchObject({ a: 10, h: 0, balance: 40 });
    expect(sweeps).toHaveLength(1);
    const plan = (
      await f.pool.query(
        'explain (analyze, buffers, format json) ' + sweeps[0]!.sql,
        sweeps[0]!.params,
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    type Plan = {
      'Relation Name'?: string;
      'Actual Rows': number;
      'Actual Loops': number;
      'Rows Removed by Filter'?: number;
      Plans?: Plan[];
    };
    const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];
    const examined = nodes(plan)
      .filter((p) =>
        ['assistant_credit_turns', 'assistant_usage_ledger'].includes(p['Relation Name'] ?? ''),
      )
      .reduce(
        (n, p) => n + (p['Actual Rows'] + (p['Rows Removed by Filter'] ?? 0)) * p['Actual Loops'],
        0,
      );
    expect(examined).toBeLessThan(100); // A LIMIT alone still examines settled history.
  });
});
