import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { assertAssistantCreditSpendReady } from './assistant-credit-readiness';
const dialect = new PgDialect();
describe('#851 assistant credit storage readiness', () => {
  it('requires valid ready indexes with exact table, ordered keys, uniqueness and predicate', async () => {
    const execute = vi.fn(async () => ({ rows: [{ singleton: true }] }));
    await assertAssistantCreditSpendReady({ execute } as never);
    for (const [q] of execute.mock.calls as unknown as [Parameters<PgDialect['sqlToQuery']>[0]][]) {
      const s = dialect.sqlToQuery(q).sql;
      if (s.includes('pg_index'))
        for (const guard of [
          'indisvalid',
          'indisready',
          'indisunique',
          'indrelid',
          'indnkeyatts',
          'indnatts',
          'indexprs',
          'pg_get_expr',
          'order by k.n',
        ])
          expect(s).toContain(guard);
    }
  });
  it('fails closed before storage writers if the ops index is missing or incompatible', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    await expect(assertAssistantCreditSpendReady({ execute } as never)).rejects.toMatchObject({
      code: 'CREDIT_INDEX_NOT_READY',
    });
  });
});
