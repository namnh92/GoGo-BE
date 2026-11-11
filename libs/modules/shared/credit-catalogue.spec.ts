import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  assertCreditWriterReady,
  lockSyncCreditRules,
  validateCreditEventKey,
} from './credit-catalogue';
const dialect = new PgDialect();
describe('#829 compatible writer readiness', () => {
  it('requires complete seed definitions and every valid required index', async () => {
    const execute = vi.fn(async (_q: Parameters<PgDialect['sqlToQuery']>[0]) => ({
      rows: [{ id: 'present' }],
    }));
    await assertCreditWriterReady({ execute } as never);
    const statements = execute.mock.calls.map(([q]) => dialect.sqlToQuery(q).sql);
    expect(statements.filter((s) => s.includes('select id from credit_events'))).toHaveLength(3);
    expect(statements.every((s) => !s.includes('validate constraint'))).toBe(true);
    expect(statements.filter((s) => s.includes('pg_index')).length).toBeGreaterThanOrEqual(6);
    expect(
      statements
        .filter((s) => s.includes('pg_index'))
        .every((s) => s.includes('indisvalid') && s.includes('indisready')),
    ).toBe(true);
  });
  it('rejects a missing/mismatched seed before index/schema traffic', async () => {
    const execute = vi.fn(async (_q: Parameters<PgDialect['sqlToQuery']>[0]) => ({ rows: [] }));
    await expect(assertCreditWriterReady({ execute } as never)).rejects.toMatchObject({
      code: 'CREDIT_SEED_MISMATCH',
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it('rejects missing/invalid/misdefined indexes', async () => {
    const execute = vi.fn(async (q) => ({
      rows: dialect.sqlToQuery(q).sql.includes('pg_index') ? [] : [{ id: 'present' }],
    }));
    await expect(assertCreditWriterReady({ execute } as never)).rejects.toMatchObject({
      code: 'CREDIT_INDEX_NOT_READY',
    });
  });
  it('locks both full seed definitions in id order before accounts/domain, rejecting partial seeds', async () => {
    const execute = vi.fn(async (q: Parameters<PgDialect['sqlToQuery']>[0]) => ({
      rows: dialect.sqlToQuery(q).sql.includes('select * from credit_events')
        ? [{ id: 'one' }]
        : [{ id: 'present' }],
    }));
    await expect(lockSyncCreditRules({ execute } as never)).rejects.toMatchObject({
      code: 'CREDIT_SEED_MISMATCH',
    });
    expect(dialect.sqlToQuery(execute.mock.calls.at(-1)![0]).sql).toContain(
      'order by id for update',
    );
  });
});

describe('#851 reserved catalogue keys', () => {
  it.each(['message_spent', 'assistant_usage', 'assistant_usage_adjustment'])(
    'rejects reserved %s',
    async (key) => {
      expect(() => validateCreditEventKey(key)).toThrow();
      expect(() => validateCreditEventKey('future_reward')).not.toThrow();
    },
  );
});
