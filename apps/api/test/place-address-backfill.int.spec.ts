import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { backfillPlaceAddresses, DbAddressBackfillStore } from '@gogo/modules';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let store: DbAddressBackfillStore;
const execute = { dryRun: false, maxGoogleCalls: 100 };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_address_backfill_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  store = new DbAddressBackfillStore(db);
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});
beforeEach(async () => {
  await db.execute(sql`truncate places cascade`);
  await db.execute(sql`delete from audit_logs where action = 'place.address_backfill'`);
});

async function place(
  addressText: string | null,
  identity: 'legacy' | 'canonical' | 'none' = 'legacy',
) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: 'Synthetic fixture',
      nameNormalized: 'synthetic fixture',
      geom: { x: 106.7, y: 10.77 },
      addressText,
    })
    .returning();
  const externalId = `fixture-${row!.id}`;
  if (identity === 'legacy') {
    await db
      .insert(schema.placeSources)
      .values({ placeId: row!.id, provider: 'google', externalId });
  } else if (identity === 'canonical') {
    await db.insert(schema.placeProviderSources).values({
      placeId: row!.id,
      provider: 'google_places',
      externalId,
    });
  }
  return { id: row!.id, externalId };
}
async function stored(id: string) {
  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  return row!;
}
async function provenance(id: string) {
  return db
    .select()
    .from(schema.placeFieldProvenance)
    .where(eq(schema.placeFieldProvenance.placeId, id));
}
const provider = () => ({ address: vi.fn(async (_id: string) => 'Synthetic Google address') });

describe('#776 address backfill SQL', () => {
  it('fills null/empty/space-only cells from both identity tables, preserves admin values, and reruns idempotently', async () => {
    const candidates = [await place(null), await place('', 'canonical'), await place('   ')];
    const admin = await place('Admin address');
    await db.insert(schema.placeFieldProvenance).values({
      placeId: admin.id,
      field: 'address_text',
      sourceType: 'editorial',
      sourceReference: 'site visit',
    });
    const noIdentity = await place(null, 'none');
    const p = provider();
    expect(await backfillPlaceAddresses(store, p, execute)).toMatchObject({
      scanned: 3,
      written: 3,
      errors: 0,
    });
    for (const candidate of candidates) {
      expect((await stored(candidate.id)).addressText).toBe('Synthetic Google address');
      expect(await provenance(candidate.id)).toMatchObject([
        {
          field: 'address_text',
          sourceType: 'google_derived',
          sourceReference: candidate.externalId,
          actorId: null,
          collectedAt: null,
        },
      ]);
    }
    expect((await stored(admin.id)).addressText).toBe('Admin address');
    expect(await provenance(admin.id)).toMatchObject([
      { sourceType: 'editorial', sourceReference: 'site visit' },
    ]);
    expect((await stored(noIdentity.id)).addressText).toBeNull();
    expect(await backfillPlaceAddresses(store, p, execute)).toMatchObject({
      scanned: 0,
      written: 0,
    });
    expect(p.address).toHaveBeenCalledTimes(3);
    const audits = await db.execute(
      sql`select diff from audit_logs where action = 'place.address_backfill'`,
    );
    expect(audits.rows).toHaveLength(3);
    expect(JSON.stringify(audits.rows)).not.toContain('Synthetic Google address');
  });

  it('deduplicates a place in both identity tables', async () => {
    const candidate = await place(null);
    await db.insert(schema.placeProviderSources).values({
      placeId: candidate.id,
      provider: 'google_places',
      externalId: candidate.externalId,
    });
    const p = provider();
    expect(await backfillPlaceAddresses(store, p, execute)).toMatchObject({
      scanned: 1,
      written: 1,
    });
    expect(p.address).toHaveBeenCalledTimes(1);
  });

  it('respects the cap and continues after a provider failure without writing that place', async () => {
    const candidates = [await place(null), await place(null), await place(null)];
    const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
    const p = provider();
    p.address.mockRejectedValueOnce(new Error('provider failure'));
    expect(await backfillPlaceAddresses(store, p, { ...execute, maxGoogleCalls: 2 })).toMatchObject(
      { scanned: 2, written: 1, errors: 1, callSlots: 2 },
    );
    expect(p.address).toHaveBeenCalledTimes(2);
    expect((await stored(ordered[0]!.id)).addressText).toBeNull();
    expect(await provenance(ordered[0]!.id)).toEqual([]);
    expect((await stored(ordered[2]!.id)).addressText).toBeNull();
  });

  it('dry-run calls neither Google nor the writer', async () => {
    const candidate = await place(null);
    const p = provider();
    expect(await backfillPlaceAddresses(store, p, { ...execute, dryRun: true })).toMatchObject({
      scanned: 1,
      written: 0,
      skipped: 1,
      callSlots: 0,
    });
    expect(p.address).not.toHaveBeenCalled();
    expect((await stored(candidate.id)).addressText).toBeNull();
    expect(await provenance(candidate.id)).toEqual([]);
    const audits = await db.execute(
      sql`select id from audit_logs where action = 'place.address_backfill'`,
    );
    expect(audits.rows).toEqual([]);
  });

  it('preserves an admin address/provenance written during Google I/O', async () => {
    const candidate = await place(null);
    const p = {
      address: async () => {
        await db.transaction(async (tx) => {
          await tx
            .update(schema.places)
            .set({ addressText: 'Racing admin' })
            .where(eq(schema.places.id, candidate.id));
          await tx.insert(schema.placeFieldProvenance).values({
            placeId: candidate.id,
            field: 'address_text',
            sourceType: 'editorial',
            sourceReference: 'site visit',
          });
        });
        return 'Google address';
      },
    };
    expect(await backfillPlaceAddresses(store, p, execute)).toMatchObject({
      written: 0,
      skipped: 1,
    });
    expect((await stored(candidate.id)).addressText).toBe('Racing admin');
    expect(await provenance(candidate.id)).toMatchObject([{ sourceType: 'editorial' }]);
  });

  it('allows only one concurrent writer to claim the same empty cell', async () => {
    const candidate = await place(null);
    const result = await Promise.all([
      store.writeIfEmpty(candidate, 'First'),
      store.writeIfEmpty(candidate, 'Second'),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await provenance(candidate.id)).toHaveLength(1);
    const audits = await db.execute(
      sql`select id from audit_logs where action = 'place.address_backfill'`,
    );
    expect(audits.rows).toHaveLength(1);
  });

  it('does not write if the Google identity was removed during the fetch', async () => {
    const candidate = await place(null);
    await db.delete(schema.placeSources).where(eq(schema.placeSources.placeId, candidate.id));
    expect(await store.writeIfEmpty(candidate, 'Google address')).toBe(false);
    expect((await stored(candidate.id)).addressText).toBeNull();
    expect(await provenance(candidate.id)).toEqual([]);
  });

  it('pages beyond one batch without skipping rows that it just filled', async () => {
    const rows = await db
      .insert(schema.places)
      .values(
        Array.from({ length: 101 }, () => ({
          name: 'Synthetic',
          nameNormalized: 'synthetic',
          geom: { x: 106.7, y: 10.77 },
        })),
      )
      .returning();
    await db.insert(schema.placeSources).values(
      rows.map((r) => ({
        placeId: r.id,
        provider: 'google' as const,
        externalId: `fixture-${r.id}`,
      })),
    );
    expect(
      await backfillPlaceAddresses(store, provider(), { ...execute, maxGoogleCalls: 101 }),
    ).toMatchObject({ scanned: 101, written: 101, errors: 0 });
  });
});
