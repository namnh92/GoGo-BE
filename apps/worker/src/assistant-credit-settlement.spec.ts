import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AssistantCreditSettlementWorker } from './assistant-credit-settlement';
const dialect = new PgDialect(),
  signal = new AbortController().signal;
function harness(outcome = 'applied', lease = true, retries = 0) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (q: SQL) => {
    const query = dialect.sqlToQuery(q);
    queries.push(query);
    if (query.sql.includes('select id,resource_id'))
      return { rows: [{ id: 'event', resource_id: 'usage', lag: 12 }] };
    if (query.sql.includes('select usage_ledger_id from')) return { rows: [] };
    if (query.sql.includes('select user_id from assistant_credit_turns'))
      return { rows: [{ user_id: 'user' }] };
    if (query.sql.includes('returning cost_revision'))
      return { rows: lease ? [{ cost_revision: '4', retry_count: retries }] : [] };
    if (query.sql.includes('returning usage_ledger_id'))
      return { rows: [{ usage_ledger_id: 'usage', next_reconcile_at: '2026-11-11T00:05:00Z' }] };
    return { rows: [] };
  });
  const db = {
    execute,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
  };
  const reconcile = vi.fn(async () => outcome);
  return {
    queries,
    reconcile,
    worker: new AssistantCreditSettlementWorker(db as never, { reconcile } as never),
  };
}
describe('#853 bounded settlement consumer', () => {
  it('a durable wakeup bypasses sweep delay and ACKs only its delivered IDs', async () => {
    const h = harness();
    await h.worker.tick(signal, 5);
    expect(h.reconcile).toHaveBeenCalledOnce();
    const claim = h.queries.find((q) => q.sql.includes('returning cost_revision'))!;
    expect(claim.params).toContain(true);
    const ack = h.queries.find((q) => q.sql.includes('update outbox_events'))!;
    expect(ack.params).toContain('event');
    expect(ack.params).not.toContain('usage');
    expect(ack.params).toContain(false);
    const account = h.queries.findIndex((q) => q.sql.includes('pg_advisory_xact_lock'));
    const turn = h.queries.findIndex((q) => q.sql.includes('returning usage_ledger_id'));
    expect(account).toBeGreaterThan(-1);
    expect(account).toBeLessThan(turn);
    expect(turn).toBeLessThan(h.queries.indexOf(ack));
  });
  it.each([
    ['paused', 0, 5],
    ['pending', 10, 3600],
    ['retry', 100, 3600],
  ])('backs off %s and retains wakeups', async (outcome, retries, seconds) => {
    const h = harness(String(outcome), true, Number(retries));
    await h.worker.tick(signal);
    const ack = h.queries.find((q) => q.sql.includes('update outbox_events'))!;
    const finish = h.queries.find((q) => q.sql.includes('next_reconcile_at=case'))!;
    expect(finish.params).toContain(seconds);
    expect(ack.params).toContain('2026-11-11T00:05:00Z');
    expect(ack.params).toContain(true);
  });
  it('a held turn lease skips reconciliation; no row remains locked waiting for account', async () => {
    const h = harness('applied', false);
    await h.worker.tick(signal);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(
      h.queries.some((q) => q.sql.includes('for update') || q.sql.includes('pg_advisory')),
    ).toBe(false);
  });
  it('paid sweep uses due markers and excludes settled NULL history from its index range', async () => {
    const h = harness();
    await h.worker.tick(signal);
    const sweep = h.queries.find((q) => q.sql.includes('select usage_ledger_id from'))!.sql;
    expect(sweep).toContain("state in ('pending','reconciling')");
    expect(sweep).toContain("state='settled' and next_reconcile_at<=now()");
    expect(sweep).not.toContain('assistant_usage_ledger');
    expect(sweep).toContain('union all');
    expect(sweep).toContain('limit');
    await expect(h.worker.tick(signal, 101)).rejects.toThrow(RangeError);
  });
});

it('policy A leaves free/finished turns unscheduled instead of hourly polling', async () => {
  const h = harness('ignored');
  await h.worker.tick(signal);
  const finish = h.queries.find((q) => q.sql.includes('next_reconcile_at=case'))!.sql;
  expect(finish).not.toContain("interval '1 hour'");
  const sweep = h.queries.find((q) => q.sql.includes('select usage_ledger_id from'))!.sql;
  expect(sweep).toContain("funding_source='credit'");
});

it('a revision finalized and applied during reconcile does not create another scheduled tick', async () => {
  const h = harness('applied');
  await h.worker.tick(signal);
  const finish = h.queries.find((q) => q.sql.includes('next_reconcile_at=case'))!.sql;
  expect(finish).toContain('and cost_revision>applied_cost_revision then now()');
  expect(finish).toContain('else null end');
});
