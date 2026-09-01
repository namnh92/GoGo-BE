import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/**
 * #348 — Google content out of `place_imports.provider_snapshot`
 * (ADR-0006 §9.4 R5, SST §14.3).
 *
 * The audit found one writer and no reader anywhere: no endpoint returned the
 * column, no job read it, and it was never in the `/v1` contract. So, exactly
 * as with R1 and R3a, the answer is deletion rather than a 30-day expiry job
 * for the coordinates inside it — a clock whose only purpose would be to
 * eventually remove a value nobody wanted.
 *
 * Two properties live here: the purge empties every row, and it is idempotent,
 * because a compliance migration that only works once cannot be re-applied to
 * a restored snapshot.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const MIGRATION = path.resolve(__dirname, '../../../migrations/0036_import-provider-snapshot.sql');

/** Runs the real migration file, as drizzle would. */
async function runMigration() {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

/** The snapshot exactly as the pre-#348 writer stored it. */
const legacySnapshot = (name: string) => ({
  name,
  addressText: `${name}, Quận 1, TP.HCM`,
  lat: 10.7769,
  lng: 106.7009,
  rating: 4.6,
  ratingCount: 214,
  attribution: 'Data © Google',
});

async function seedImport(input: {
  url: string;
  providerPlaceId: string | null;
  snapshot: Record<string, unknown> | null;
}) {
  const [row] = await db
    .insert(schema.placeImports)
    .values({
      url: input.url,
      providerPlaceId: input.providerPlaceId,
      status: 'verified',
      providerSnapshot: input.snapshot as never,
    })
    .returning();
  return row!.id;
}

const importRow = async (id: string) => {
  const [row] = await db.select().from(schema.placeImports).where(eq(schema.placeImports.id, id));
  return row!;
};

/** The acceptance query from the issue, and the one the runbook records. */
async function remaining(): Promise<number> {
  const res = await db.execute(
    sql`select count(*)::int as n from place_imports where provider_snapshot is not null`,
  );
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_import_snapshot_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('#348 — provider_snapshot is purged, the Place ID is not', () => {
  it('empties every snapshot and leaves the row otherwise intact', async () => {
    const withSnapshot = await seedImport({
      url: 'https://maps.google.com/maps?place_id=ChIJsnapshot-a',
      providerPlaceId: 'ChIJsnapshot-a',
      snapshot: legacySnapshot('Quán Một'),
    });
    const alreadyNull = await seedImport({
      url: 'https://maps.google.com/maps?place_id=ChIJsnapshot-b',
      providerPlaceId: 'ChIJsnapshot-b',
      snapshot: null,
    });

    expect(await remaining()).toBe(1);
    await runMigration();
    expect(await remaining()).toBe(0);

    const purged = await importRow(withSnapshot);
    expect(purged.providerSnapshot).toBeNull();
    // SST §3 permits the Place ID indefinitely, and without it the row cannot
    // say which place it resolved to. Purging it would be a data loss the
    // terms do not ask for.
    expect(purged.providerPlaceId).toBe('ChIJsnapshot-a');
    expect(purged.status).toBe('verified');
    expect(purged.url).toContain('ChIJsnapshot-a');

    // A row that never had one is untouched, not rewritten.
    expect((await importRow(alreadyNull)).providerSnapshot).toBeNull();
  });

  it('is idempotent — a second apply changes nothing', async () => {
    await seedImport({
      url: 'https://maps.google.com/maps?place_id=ChIJsnapshot-c',
      providerPlaceId: 'ChIJsnapshot-c',
      snapshot: legacySnapshot('Quán Hai'),
    });

    await runMigration();
    const first = await remaining();
    await runMigration();
    const second = await remaining();

    expect(first).toBe(0);
    expect(second).toBe(0);
  });

  it('leaves no coordinate anywhere in the column (SST §14.3)', async () => {
    await seedImport({
      url: 'https://maps.google.com/maps?place_id=ChIJsnapshot-d',
      providerPlaceId: 'ChIJsnapshot-d',
      snapshot: legacySnapshot('Quán Ba'),
    });
    await runMigration();

    // Asserted over the whole table rather than one row: the compliance claim
    // is about the store, not about the row this test happened to write.
    const res = await db.execute(sql`
      select count(*)::int as n from place_imports
       where jsonb_path_exists(coalesce(provider_snapshot, '{}'::jsonb), '$.lat')
          or jsonb_path_exists(coalesce(provider_snapshot, '{}'::jsonb), '$.lng')
    `);
    expect(Number((res.rows[0] as { n?: number }).n)).toBe(0);
  });
});
