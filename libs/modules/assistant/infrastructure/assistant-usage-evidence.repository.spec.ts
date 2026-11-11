import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AssistantUsageEvidenceRepository } from './assistant-usage-evidence.repository';
import {
  RECEIPT_RECOVERY_MAX_GETS,
  RECEIPT_RECOVERY_WINDOW_SECONDS,
} from '../domain/receipt-recovery';

const dialect = new PgDialect();
afterEach(() => vi.restoreAllMocks());
function harness(costState = 'unknown', expired = false) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const increment = vi.fn();
  const execute = vi.fn(async (q: SQL) => {
    const query = dialect.sqlToQuery(q);
    queries.push(query);
    const text = query.sql;
    if (text.includes('select user_id from')) return { rows: [{ user_id: 'subject' }] };
    if (text.includes('select id from assistant_usage_ledger')) return { rows: [{ id: 'usage' }] };
    if (text.includes('select * from assistant_usage_calls'))
      return {
        rows: [
          {
            cost_state: costState,
            receipt_revision: costState === 'final' ? '1' : null,
            provider_generation_id: 'gen',
          },
        ],
      };
    if (text.includes('select t.usage_ledger_id'))
      return { rows: expired ? [{ usage_ledger_id: 'usage' }] : [] };
    if (text.includes('returning cost_revision')) return { rows: [{ cost_revision: '3' }] };
    if (text.includes('as absorbed_upward'))
      return { rows: [{ absorbed_upward: costState === 'final' }] };
    return { rows: [] };
  });
  const insert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
  const db = {
    execute,
    transaction: async (fn: (tx: unknown) => unknown) => fn({ execute, insert }),
  };
  return {
    repo: new AssistantUsageEvidenceRepository(db as never, { increment } as never),
    queries,
    increment,
  };
}
describe('#853 policy A evidence', () => {
  it.each(['inline_receipt_v1', 'recovered_receipt_v1'] as const)(
    'records %s and finalizes even without provider finality',
    async (policy) => {
      const h = harness();
      await h.repo.ingest(
        'usage',
        0,
        { revision: 1n, direct: '0.00012', upstream: '0', fee: '0', final: false },
        policy,
      );
      const call = h.queries.find((q) => q.sql.includes('billable_cost_usd=case'))!;
      expect(call.params).toContain(policy);
      expect(call.params).toContain('final');
      const advance = h.queries.find((q) =>
        q.sql.includes('set cost_revision=cost_revision+1'),
      )!.sql;
      expect(advance).toContain('dispatch_closed_at is not null');
      expect(advance).toContain("cost_state<>'final'");
      expect(h.queries.some((q) => q.sql.includes('insert into outbox_events'))).toBe(true);
    },
  );
  it('journals full late cost, caps billable cost at final amount and emits the Cost Center signal', async () => {
    const h = harness('final');
    await h.repo.ingest('usage', 0, {
      revision: 2n,
      direct: '0.00014',
      upstream: '0',
      fee: '0',
      final: false,
    });
    expect(
      h.queries.find((q) => q.sql.includes('insert into assistant_usage_receipts'))!.params,
    ).toContain('0.00014');
    const update = h.queries.find((q) => q.sql.includes('billable_cost_usd=case'))!.sql;
    expect(update).toContain("when cost_state='final' then least(");
    expect(update).toContain("when cost_state='final' then 'final'");
    expect(h.increment).toHaveBeenCalledWith('assistant_credit_post_final_cost_absorbed_total', {});
  });
  it('claims only due unknown paid evidence with a usage budget and records the attempt before returning', async () => {
    const h = harness();
    await h.repo.claimRecovery('usage');
    const claim = h.queries.find((q) => q.sql.includes('select c.call_index'))!;
    expect(claim.sql).toContain("c.cost_state='unknown'");
    expect(claim.sql).toContain("t.funding_source='credit'");
    expect(claim.sql).toContain('for update of t');
    expect(claim.sql).toContain('t.recovery_attempts<');
    expect(claim.params).toEqual(
      expect.arrayContaining([RECEIPT_RECOVERY_MAX_GETS, RECEIPT_RECOVERY_WINDOW_SECONDS, 300]),
    );
  });
  it('expiry creates a durable incident and alert signal without releasing the hold or charging', async () => {
    const h = harness('unknown', true);
    await h.repo.expireRecovery('usage');
    const quarantine = h.queries.find((q) => q.sql.includes("set state='quarantined'"))!;
    expect(quarantine.sql).not.toContain('held_credits=');
    expect(
      h.queries.find((q) => q.sql.includes('insert into assistant_credit_billing_incidents'))!
        .params,
    ).toContain('receipt_missing');
    expect(h.increment).toHaveBeenCalledWith('assistant_credit_bound_violation_total', {
      reason: 'receipt_missing',
    });
    expect(
      h.queries.some(
        (q) =>
          q.sql.includes('update assistant_credit_accounts') ||
          q.sql.includes('insert into assistant_credit_ledger'),
      ),
    ).toBe(false);
  });
});

it('same-version upward observation after finality is Cost Center only, without a conflict quarantine', async () => {
  const h = harness('final');
  expect(
    await h.repo.ingest('usage', 0, {
      revision: 1n,
      direct: '0.00014',
      upstream: '0',
      fee: '0',
      final: false,
    }),
  ).toBe('absorbed');
  expect(h.increment).toHaveBeenCalledWith('assistant_credit_post_final_cost_absorbed_total', {});
  expect(
    h.queries.some(
      (q) =>
        q.sql.includes("set cost_state='quarantined'") ||
        q.sql.includes('set cost_revision=cost_revision+1'),
    ),
  ).toBe(false);
  expect(h.queries.some((q) => q.sql.includes('insert into assistant_usage_receipts'))).toBe(true);
});
