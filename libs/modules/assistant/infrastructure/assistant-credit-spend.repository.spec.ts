import { describe, expect, it, vi } from 'vitest';
import { NoopMetrics, type MetricsPort } from '@gogo/observability';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AssistantCreditSpendRepository } from './assistant-credit-spend.repository';
const dialect = new PgDialect();
function harness(overrides: Record<string, unknown> = {}, flags = true) {
  const turn = {
    accepted_at: '2026-11-11T00:00:00Z',
    funding_source: 'credit',
    reserved_ceiling: 20,
    held_credits: 20,
    applied_credits: 0,
    cost_revision: '1',
    applied_cost_revision: '0',
    finalized_at: null,
    state: 'pending',
    ...overrides,
  };
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: vi.fn(async (q) => {
      const s = dialect.sqlToQuery(q);
      queries.push(s);
      if (s.sql.includes('from feature_flags'))
        return {
          rows: flags
            ? []
            : [{ environment: 'all', platform: 'all', enabled: false, payload: null }],
        };
      if (s.sql.includes('select t.*')) return { rows: [turn] };
      if (s.sql.includes('select cost_revision::text'))
        return {
          rows: [
            {
              cost_revision: turn.cost_revision,
              dispatch_closed_at: 'closed',
              cost_finalized_at: 'final',
            },
          ],
        };
      if (s.sql.includes('select id from assistant_credit_ledger'))
        return { rows: turn.applied_cost_revision === '0' ? [] : [{ id: 'base' }] };
      if (s.sql.includes('update assistant_credit_accounts')) return { rows: [{ balance: 50 }] };
      if (s.sql.includes('select id from assistant_usage_ledger'))
        return { rows: [{ id: 'usage' }] };
      return { rows: [] };
    }),
    insert: () => ({ values: vi.fn(async () => undefined) }),
  };
  const db = { transaction: async (fn: (tx: unknown) => unknown) => fn(tx) };
  const metrics: MetricsPort = new NoopMetrics();
  vi.spyOn(metrics, 'increment');
  vi.spyOn(metrics, 'observe');
  return { repo: new AssistantCreditSpendRepository(db as never, metrics), queries, turn, metrics };
}
describe('#851 settlement repository primitives (no worker)', () => {
  it('account lock precedes turn and usage locks; initial application writes a base debit', async () => {
    const h = harness();
    expect(await h.repo.applyRevision('user', 'usage', 1n, 12, 'dev')).toBe('applied');
    const s = h.queries.map((q) => q.sql);
    expect(s.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
      s.findIndex((s) => s.includes('select t.*')),
    );
    expect(s.findIndex((s) => s.includes('select t.*'))).toBeLessThan(
      s.findIndex((s) => s.includes('select cost_revision::text')),
    );
    expect(
      h.queries.find((q) => q.sql.includes('insert into assistant_credit_ledger'))?.params,
    ).toEqual(['user', -12, 'message_spent', 'usage', '1']);
    expect(h.queries.find((q) => q.sql.includes('update assistant_credit_turns'))?.params).toEqual(
      expect.arrayContaining([12, 8, '1', 'reconciling']),
    );
  });
  it('refund-to-zero followed by a positive revision never manufactures a second base debit', async () => {
    const h = harness({
      cost_revision: '3',
      applied_cost_revision: '2',
      applied_credits: 0,
      held_credits: 20,
    });
    await h.repo.applyRevision('user', 'usage', 3n, 7, 'dev');
    expect(
      h.queries.find((q) => q.sql.includes('insert into assistant_credit_ledger'))?.params,
    ).toContain('assistant_usage_adjustment');
  });
  it('same-revision finality releases residual hold without a ledger refund', async () => {
    const h = harness({
      applied_cost_revision: '1',
      applied_credits: 12,
      held_credits: 8,
      state: 'reconciling',
    });
    expect(await h.repo.applyRevision('user', 'usage', 1n, 12, 'dev', true)).toBe('applied');
    expect(h.queries.some((q) => q.sql.includes('insert into assistant_credit_ledger'))).toBe(
      false,
    );
    expect(
      h.queries.find((q) => q.sql.includes('update assistant_credit_turns'))?.params,
    ).toContain('settled');
  });
  it('duplicate/stale revisions do not write; over-bound revisions quarantine', async () => {
    const duplicate = harness({ applied_cost_revision: '1' });
    expect(await duplicate.repo.applyRevision('user', 'usage', 1n, 0, 'dev')).toBe('duplicate');
    expect(duplicate.queries.some((q) => q.sql.trimStart().startsWith('update '))).toBe(false);
    for (const overrides of [{}]) {
      const h = harness(overrides);
      expect(await h.repo.applyRevision('user', 'usage', 1n, 21, 'dev')).toBe('quarantined');
      expect(h.queries.some((q) => q.sql.includes('assistant_credit_accounts'))).toBe(false);
    }
  });
  it('refund applies a lower target and refuses an upward target before financial writes', async () => {
    const lower = harness({
      applied_credits: 12,
      held_credits: 8,
      applied_cost_revision: '1',
      cost_revision: '2',
    });
    expect(await lower.repo.refund('user', 'usage', 2n, 10, 'dev')).toBe('applied');
    expect(
      lower.queries.find((q) => q.sql.includes('insert into assistant_credit_ledger'))?.params,
    ).toContain(2);
    const upward = harness({
      applied_credits: 12,
      held_credits: 8,
      applied_cost_revision: '1',
      cost_revision: '2',
    });
    await expect(upward.repo.refund('user', 'usage', 2n, 14, 'dev')).rejects.toThrow(
      'Refund target',
    );
    expect(upward.queries.some((q) => q.sql.includes('insert into assistant_credit_ledger'))).toBe(
      false,
    );
  });
  it('paused settlement retains holds and makes no financial writes', async () => {
    const h = harness({}, false);
    expect(await h.repo.applyRevision('user', 'usage', 1n, 12, 'dev')).toBe('paused');
    expect(h.queries).toHaveLength(2);
  });
  it('proven no dispatch releases once without a credit ledger row', async () => {
    const h = harness();
    expect(await h.repo.releaseUndispatched('user', 'usage', 'dev', { messageId: 'message' })).toBe(
      true,
    );
    expect(h.queries.some((q) => q.sql.includes('insert into assistant_credit_ledger'))).toBe(
      false,
    );
    expect(h.queries.some((q) => q.sql.includes('dispatch_closed_at=clock_timestamp()'))).toBe(
      true,
    );
  });
});

it('policy A acknowledges a post-final upward revision without debiting or quarantining', async () => {
  const h = harness({
    finalized_at: 'final',
    held_credits: 0,
    applied_credits: 10,
    applied_cost_revision: '1',
    cost_revision: '2',
    state: 'settled',
  });
  expect(await h.repo.applyRevision('user', 'usage', 2n, 21, 'dev', true)).toBe('applied');
  expect(
    h.queries.some(
      (q) =>
        q.sql.includes('update assistant_credit_accounts') ||
        q.sql.includes('insert into assistant_credit_ledger'),
    ),
  ).toBe(false);
  const advance = h.queries.find((q) => q.sql.includes('set applied_credits='))!;
  expect(advance.params).toEqual(expect.arrayContaining([10, 0, '2', 'settled']));
});

it('F-05 counts a post-final 12→10 correction only as a refund, without another release or latency', async () => {
  const h = harness({
    finalized_at: 'final',
    held_credits: 0,
    applied_credits: 12,
    applied_cost_revision: '1',
    cost_revision: '2',
    state: 'settled',
  });
  expect(await h.repo.applyRevision('user', 'usage', 2n, 10, 'dev', true)).toBe('applied');
  expect(h.metrics.increment).toHaveBeenCalledWith('assistant_credit_refunded_total', {}, 2);
  expect
    .soft(
      vi
        .mocked(h.metrics.increment)
        .mock.calls.filter(([name]) => name === 'assistant_credit_released_total'),
    )
    .toEqual([]);
  expect(h.metrics.observe).not.toHaveBeenCalled();
});

it('F-05 records released hold and latency once on the transition to finality', async () => {
  const h = harness({
    held_credits: 8,
    applied_credits: 12,
    applied_cost_revision: '1',
    state: 'reconciling',
  });
  expect(await h.repo.applyRevision('user', 'usage', 1n, 12, 'dev', true)).toBe('applied');
  expect(h.metrics.increment).toHaveBeenCalledWith('assistant_credit_released_total', {}, 8);
  expect(h.metrics.observe).toHaveBeenCalledExactlyOnceWith(
    'assistant_credit_settlement_latency_seconds',
    expect.any(Number),
    {},
  );
});
