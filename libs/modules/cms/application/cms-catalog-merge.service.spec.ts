import { schema } from '@gogo/database';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { CmsCatalogService } from './cms-catalog.service';

const canonicalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const duplicateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dialect = new PgDialect();

function setup(facts: Record<string, unknown> | null) {
  const execute = vi.fn(async (query: SQL) => {
    const { sql } = dialect.sqlToQuery(query);
    // PostgreSQL owns canonical precedence; this boundary returns its merged facts.
    return sql.includes('update places canonical')
      ? { rows: [{ contribution_facts: facts }] }
      : { rows: [] };
  });
  const tx = {
    execute,
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn(() => ({ values: async () => undefined })),
  };
  const db = { transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)) };
  const dedup = { lockPlaces: vi.fn(), lockGoogleIdentities: vi.fn() };
  const service = new CmsCatalogService(db as never, dedup as never, {} as never);
  const queries = () => execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
  return { service, tx, queries };
}

describe('canonical merge amenity reconciliation (#806 Astra F-01)', () => {
  it.each([false, true])('applies retained %s after duplicate taxonomy transfer', async (value) => {
    const { service, queries } = setup({ 'amenities:car_parking': value });
    await service.mergePlaces('editor', canonicalId, duplicateId);
    const statements = queries();
    const transfer = statements.findIndex((q) => q.sql.includes('update place_taxonomies'));
    const reconcile = statements.findIndex((q) => q.params.includes('car_parking'));
    expect(reconcile).toBeGreaterThan(transfer);
    const query = statements[reconcile]!;
    expect(query.params).toContain(canonicalId);
    expect(query.params).not.toContain(duplicateId);
    expect(query.sql).toContain("kind = 'amenity'");
    if (value) {
      expect(query.sql).toContain('insert into place_taxonomies');
      expect(query.sql).toContain('is_active');
      expect(query.sql).toContain('on conflict do nothing');
    } else {
      expect(query.sql).toContain('delete from place_taxonomies');
      // Explicit absence also removes a link whose vocabulary was deactivated.
      expect(query.sql).not.toContain('is_active');
    }
  });

  it.each([null, {}, { visitTips: 'Keep this', 'purposeKeys:work_reading': 'work_reading' }])(
    'leaves transferred links alone when there is no retained amenity fact: %j',
    async (facts) => {
      const { service, queries } = setup(facts);
      await service.mergePlaces('editor', canonicalId, duplicateId);
      expect(queries().filter((q) => q.sql.includes("kind = 'amenity'"))).toEqual([]);
    },
  );

  it('propagates reconciliation failure before archive, audit, or outbox can commit', async () => {
    const { service, tx } = setup({ 'amenities:car_parking': false });
    const execute = tx.execute.getMockImplementation()!;
    tx.execute.mockImplementation(async (query) => {
      if (dialect.sqlToQuery(query).params.includes('car_parking')) {
        throw new Error('taxonomy write failed');
      }
      return execute(query);
    });
    await expect(service.mergePlaces('editor', canonicalId, duplicateId)).rejects.toThrow(
      'taxonomy write failed',
    );
    expect(tx.update).not.toHaveBeenCalledWith(schema.places);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
