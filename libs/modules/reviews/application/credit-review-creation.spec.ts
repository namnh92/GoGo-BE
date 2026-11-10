import { describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { UserContentService } from './user-content.service';

const dialect = new PgDialect();
describe('review creation eligibility (#829 CE-F-11)', () => {
  it.each([
    ['sync', null, null],
    ['evaluator', '2026-11-10', 3],
    ['sync', '2026-11-10', 3],
  ])('mode=%s first activation=%s stamps creation epoch=%s', async (mode, activation, expected) => {
    const trace: string[] = [];
    let inserted: Record<string, unknown> = {};
    const db = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
      execute: async (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const text = dialect.sqlToQuery(q).sql;
        trace.push(text);
        if (text.includes('credit_cutover'))
          return { rows: [{ mode, epoch: 3, first_activated_at: activation }] };
        if (text.includes('from users')) return { rows: [{ id: 'u' }] };
        return { rows: [] };
      },
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          trace.push(table === schema.reviews ? 'insert review' : 'outbox');
          if (table === schema.reviews) {
            inserted = value;
            return { returning: async () => [{ ...value, id: 'r', status: 'pending' }] };
          }
          return Promise.resolve();
        },
      }),
    };
    const service = new UserContentService(db as never, {} as never, {} as never, null);
    await service.createReview(
      { type: 'user', id: 'u', sessionId: 's' },
      { placeId: 'p', rating: 5 },
    );
    expect(inserted.creditEpoch).toBe(expected);
    expect(trace[0]).toContain('credit_cutover');
    expect(trace[0]).toContain('for share');
    expect(trace.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
      trace.indexOf('insert review'),
    );
  });
});
