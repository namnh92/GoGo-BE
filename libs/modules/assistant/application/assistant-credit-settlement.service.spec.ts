import { describe, it, expect, vi, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AssistantCreditSettlementService } from './assistant-credit-settlement.service';
import { AssistantUsageEvidenceRepository } from '../infrastructure/assistant-usage-evidence.repository';
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

// Repeated delivery used to reread complete receipts forever, including free turns.
describe('#853 policy A regression', () => {
  it.each(['credit', 'free'])(
    'never GETs complete inline cost for %s funding across repeated ticks',
    async (funding) => {
      vi.spyOn(AssistantUsageEvidenceRepository.prototype, 'closeDispatch').mockResolvedValue();
      const execute = vi.fn(async (q: SQL) => {
        const text = dialect.sqlToQuery(q).sql;
        if (text.includes('select user_id from')) return { rows: [{ user_id: 'subject' }] };
        if (text.includes('select t.user_id,t.funding_source'))
          return {
            rows: [
              {
                user_id: 'subject',
                funding_source: funding,
                state: 'settled',
                cost_revision: '1',
                closed: true,
                final: true,
                complete: true,
                total: '0.00012',
              },
            ],
          };
        if (text.includes('select c.call_index'))
          return {
            rows: text.includes("('unknown','complete')")
              ? [{ call_index: 0, provider: 'jev', provider_generation_id: 'gen-inline' }]
              : [],
          };
        return { rows: [] };
      });
      const read = vi.fn(async () => null);
      const db = { execute, transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) };
      vi.spyOn(AssistantCreditSpendRepository.prototype, 'applyRevision').mockResolvedValue(
        'applied',
      );
      const service = new AssistantCreditSettlementService(db as never, 'dev', undefined, { read });
      for (let tick = 0; tick < 12; tick++) await service.reconcile('usage', signal);
      expect(read).not.toHaveBeenCalled();
    },
  );
});

it.each([1, 7, 31, 123])(
  'unknown usage issues at most five GETs across %s extra eligible ticks',
  async (extraTicks) => {
    let attempts = 0;
    const execute = vi.fn(async (q: SQL) => {
      const query = dialect.sqlToQuery(q),
        text = query.sql;
      if (text.includes('select user_id from')) return { rows: [{ user_id: 'subject' }] };
      if (text.includes('select c.call_index'))
        return {
          rows: [
            {
              call_index: attempts % 3,
              provider: 'jev',
              provider_generation_id: 'gen-unknown',
              recovery_attempts: attempts,
              accepted_at: '2026-11-11T00:00:00Z',
              recovery_next_at: '2026-11-11T00:05:00Z',
              observed_at: '2026-11-11T00:06:00Z',
            },
          ],
        };
      if (text.includes('set recovery_attempts=recovery_attempts+1')) attempts++;
      if (text.includes('select t.user_id,t.funding_source'))
        return {
          rows: [
            {
              user_id: 'subject',
              funding_source: 'credit',
              state: 'pending',
              closed: true,
              complete: false,
            },
          ],
        };
      return { rows: [] };
    });
    const db = { execute, transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) };
    const read = vi.fn(async () => null);
    const service = new AssistantCreditSettlementService(db as never, 'dev', undefined, { read });
    for (let tick = 0; tick < 5 + extraTicks; tick++) await service.reconcile('usage', signal);
    expect(read).toHaveBeenCalledTimes(5);
    expect(attempts).toBe(5);
  },
);
