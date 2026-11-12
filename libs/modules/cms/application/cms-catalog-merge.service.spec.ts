import { createHash } from 'node:crypto';
import { schema } from '@gogo/database';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { CmsCatalogService } from './cms-catalog.service';

const canonicalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const duplicateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dialect = new PgDialect();

function setup(
  facts: Record<string, unknown> | null,
  aliases: { place_id: string; alias_normalized: string }[] = [],
) {
  const execute = vi.fn(async (query: SQL) => {
    const { sql } = dialect.sqlToQuery(query);
    if (sql.includes('select place_id, alias_normalized from place_aliases'))
      return { rows: aliases };
    // PostgreSQL owns canonical precedence; this boundary returns its merged facts.
    return sql.includes('update places canonical')
      ? { rows: [{ contribution_facts: facts }] }
      : { rows: [] };
  });
  const values = vi.fn(async (_row: unknown) => undefined);
  const tx = {
    execute,
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn((_table: unknown) => ({ values })),
  };
  const db = { transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)) };
  const dedup = { lockPlaces: vi.fn(), lockGoogleIdentities: vi.fn() };
  const service = new CmsCatalogService(db as never, dedup as never, {} as never);
  const queries = () => execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
  return { service, tx, queries, values };
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

describe('alias merge reconciliation (#887 Astra F-02)', () => {
  const historicalNames = [
    'ca phe ben song',
    'ben song coffee',
    'riverside coffee',
    'riverbank cafe',
    'cafe bo song',
    'ca phe ven song',
    'tiem ca phe ben cu',
    'old wharf coffee',
    'quan ben xua',
    'cafe ben xua',
    'ca phe ben vang',
    'quiet wharf cafe',
    'ca phe ben nho',
    'little wharf coffee',
    'bs coffee',
    'ben song cafe',
    'ca phe nha ben',
    'nha ben song',
    'the river house',
    'river house coffee',
  ];
  it('moves non-colliding rows intact, removes collisions, bumps version and audits only digests', async () => {
    const { service, tx, queries, values } = setup(null, [
      { place_id: canonicalId, alias_normalized: 'cafe bo ho' },
      { place_id: duplicateId, alias_normalized: 'cafe bo ho' },
      { place_id: duplicateId, alias_normalized: 'lakeside coffee' },
    ]);
    await service.mergePlaces('editor', canonicalId, duplicateId);
    const move = queries().find((q) => q.sql.includes('update place_aliases'));
    expect(move, 'SYMPTOM: merge must transfer curated aliases').toBeDefined();
    expect(move!.sql).toContain('not exists');
    expect(move!.sql).toContain('alias_normalized');
    expect(move!.sql).not.toMatch(/set.*(?:source_type|created_by|collected_at)/s);
    expect(queries().some((q) => q.sql.includes('delete from place_aliases'))).toBe(true);
    const version = queries().find((q) => q.sql.includes('greatest(clock_timestamp()'));
    expect(version?.params).toContain(canonicalId);
    const audit = tx.insert.mock.calls.find(([table]) => table === schema.auditLogs);
    expect(audit).toBeDefined();
    const entry = values.mock.calls
      .map(([row]) => row as { action: string; diff: unknown })
      .find((row) => row.action === 'place.merged');
    const digest = (keys: string[]) =>
      createHash('sha256').update(JSON.stringify(keys.sort())).digest('hex');
    expect(entry?.diff).toEqual({
      duplicateId,
      aliases: {
        before: { count: 1, digest: digest(['cafe bo ho']) },
        duplicate: { count: 2, digest: digest(['cafe bo ho', 'lakeside coffee']) },
        after: { count: 2, digest: digest(['cafe bo ho', 'lakeside coffee']) },
      },
    });
    // Bound parameters carry counts/digests; no alias values may enter audit writes.
    const writes = JSON.stringify(values.mock.calls);
    expect(writes).not.toContain('lakeside coffee');
  });

  it('rejects a 21-name union before any writes, archive, audit or outbox', async () => {
    const { service, tx } = setup(null, [
      ...historicalNames.map((alias_normalized) => ({ place_id: canonicalId, alias_normalized })),
      { place_id: duplicateId, alias_normalized: 'old lakeside coffee' },
    ]);
    await expect(service.mergePlaces('editor', canonicalId, duplicateId)).rejects.toMatchObject({
      code: 'PLACE_ALIAS_LIMIT_EXCEEDED',
      httpStatus: 409,
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(
      tx.execute.mock.calls
        .map(([q]) => dialect.sqlToQuery(q).sql)
        .some((q) => /update|delete|insert/i.test(q)),
    ).toBe(false);
  });

  it('allows 20 normalized aliases even when source rows overlap', async () => {
    const { service } = setup(null, [
      ...historicalNames.map((alias_normalized) => ({ place_id: canonicalId, alias_normalized })),
      { place_id: duplicateId, alias_normalized: 'riverside coffee' },
    ]);
    await expect(service.mergePlaces('editor', canonicalId, duplicateId)).resolves.toMatchObject({
      merged: true,
    });
  });
});
