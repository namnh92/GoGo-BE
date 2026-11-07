import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { grantSubmissionCredits } from './assistant-credits';

const dialect = new PgDialect();
describe('moderator accepted evidence credit grants', () => {
  it.each([
    [true, 0, 50],
    [true, 1, 70],
    [true, 5, 70],
    [false, 1, 20],
    [false, 5, 20],
  ])('base=%s accepted photos=%s grants %s once across retries', async (base, count, delta) => {
    let granted = false;
    const balances: unknown[][] = [];
    const execute = vi.fn(async (query) => {
      const { sql, params } = dialect.sqlToQuery(query);
      if (sql.includes('select id from users')) return { rows: [{ id: 'user' }] };
      if (sql.includes('insert into assistant_credit_ledger')) {
        expect(params).toContain(delta);
        const rows = granted ? [] : [{ id: 'ledger' }];
        granted = true;
        return { rows };
      }
      if (sql.includes('insert into assistant_credit_accounts')) balances.push(params);
      return { rows: [] };
    });
    const tx = { execute } as unknown as Parameters<typeof grantSubmissionCredits>[0];
    await grantSubmissionCredits(tx, 'user', 'submission', 'venue', count, base);
    await grantSubmissionCredits(tx, 'user', 'submission', 'venue', count, base);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toContain(delta);
  });
  it('merge without accepted evidence creates no ledger or account write', async () => {
    const execute = vi.fn();
    await grantSubmissionCredits({ execute }, 'user', 'submission', 'venue', 0, false);
    expect(execute).not.toHaveBeenCalled();
  });
});
