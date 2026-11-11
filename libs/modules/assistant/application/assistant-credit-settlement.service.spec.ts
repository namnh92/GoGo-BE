import { describe, it, expect, vi, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AssistantCreditSettlementService } from './assistant-credit-settlement.service';
import { AssistantCreditSpendRepository } from '../infrastructure/assistant-credit-spend.repository';
const dialect = new PgDialect(),
  signal = new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
function harness(overrides: Record<string, unknown> = {}) {
  const row = {
    user_id: 'subject',
    funding_source: 'credit',
    state: 'pending',
    cost_revision: '7',
    closed: true,
    final: false,
    complete: true,
    total: '0.000009999999999999999999',
    ...overrides,
  };
  const execute = vi.fn(async (q: SQL) => {
    const text = dialect.sqlToQuery(q).sql;
    if (
      text.includes('select user_id from assistant_usage_ledger') ||
      text.includes('select c.call_index')
    )
      return { rows: [] };
    return { rows: [row] };
  });
  const apply = vi
    .spyOn(AssistantCreditSpendRepository.prototype, 'applyRevision')
    .mockResolvedValue('applied');
  return { apply, service: new AssistantCreditSettlementService({ execute } as never, 'dev') };
}
describe('#853 settlement complete evidence gate', () => {
  it('uses the exact aggregate target/revision and keeps correctable evidence reconciling', async () => {
    const h = harness();
    expect(await h.service.reconcile('usage', signal)).toBe('applied');
    expect(h.apply).toHaveBeenCalledWith('subject', 'usage', 7n, 1, 'dev', false);
  });
  it.each([{ complete: false }, { closed: false }])(
    'never posts a partial or still-dispatchable aggregate: %j',
    async (state) => {
      const h = harness(state);
      expect(await h.service.reconcile('usage', signal)).toBe('pending');
      expect(h.apply).not.toHaveBeenCalled();
    },
  );
  it.each([{ funding_source: 'free' }, { state: 'erased' }, { user_id: null }])(
    'never charges free or erased funding: %j',
    async (state) => {
      const h = harness({ ...state, total: '99999999' });
      expect(await h.service.reconcile('usage', signal)).toBe('ignored');
      expect(h.apply).not.toHaveBeenCalled();
    },
  );
  it('only passes finality when the persisted complete aggregate proves it', async () => {
    const h = harness({ final: true, total: '0.000010000000000001' });
    await h.service.reconcile('usage', signal);
    expect(h.apply).toHaveBeenCalledWith('subject', 'usage', 7n, 2, 'dev', true);
  });
  it('quarantined evidence retains funding instead of retrying financial application', async () => {
    const h = harness({ state: 'quarantined' });
    expect(await h.service.reconcile('usage', signal)).toBe('quarantined');
    expect(h.apply).not.toHaveBeenCalled();
  });
});
