import { eraseAssistantDataForUser } from '../assistant/application/assistant-privacy';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { eraseCreditSubjectKeys } from './credit-erasure';
const dialect = new PgDialect();
describe('#829 subject key erasure', () => {
  it('rewrites every entitlement and ledger copy through the same random map', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const execute = async (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const query = dialect.sqlToQuery(q);
      if (query.sql.includes('select distinct'))
        return { rows: [{ key: 'place:p:subject' }, { key: 'evt:e:subject' }] };
      writes.push(query);
      return { rows: [] };
    };
    await eraseCreditSubjectKeys({ execute } as never, 'user');
    expect(writes).toHaveLength(4);
    for (let i = 0; i < 4; i += 2) {
      expect(writes[i]!.sql).toContain('update credit_entitlements');
      expect(writes[i + 1]!.sql).toContain('update assistant_credit_ledger');
      expect(writes[i]!.params).toEqual(writes[i + 1]!.params);
      expect(writes[i]!.params[0]).toMatch(/^erased:[0-9a-f-]{36}$/);
    }
    expect(writes[0]!.params[0]).not.toBe(writes[2]!.params[0]);
  });
});

describe('#829 assistant erasure integration seam', () => {
  it('scrubs subject key copies before nulling ledger ownership', async () => {
    const trace: { sql: string; params: unknown[] }[] = [];
    const execute = async (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const query = dialect.sqlToQuery(q);
      trace.push(query);
      if (query.sql.includes('returning usage_ledger_id'))
        return { rows: [{ usage_ledger_id: 'usage-a' }, { usage_ledger_id: 'usage-b' }] };
      return { rows: query.sql.includes('select distinct') ? [{ key: 'place:p:old-hmac' }] : [] };
    };
    await eraseAssistantDataForUser({ execute } as never, 'user');
    const entitlement = trace.findIndex((t) => t.sql.includes('update credit_entitlements'));
    const ledger = trace.findIndex((t) => t.sql.includes('set entitlement_key='));
    const unlink = trace.findIndex((t) =>
      t.sql.includes('assistant_credit_ledger set user_id = null'),
    );
    expect(entitlement).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(entitlement);
    expect(unlink).toBeGreaterThan(ledger);
    expect(trace[entitlement]!.params).toEqual(trace[ledger]!.params);
    const turn = trace.findIndex((t) => t.sql.includes('returning usage_ledger_id'));
    const outbox = trace.findIndex((t) => t.sql.includes('update outbox_events'));
    expect(outbox).toBeGreaterThan(turn);
    expect(trace[outbox]!.params).toEqual(['usage-a', 'usage-b']);
    expect(trace[outbox]!.sql).toContain('resource_id in ($1,$2)');
  });
});
