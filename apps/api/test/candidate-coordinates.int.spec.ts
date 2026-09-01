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
 * #347 — Google coordinates out of `place_ingest_rows.candidates` (SST §14.3).
 *
 * The audit found nothing reads them, so the answer is deletion rather than a
 * 30-day expiry job. These tests hold both halves of that: the coordinates go,
 * and every other candidate field survives — the second half is the boundary
 * with #346, which owns `name`/`address` and is blocked on ADR-0006 §9.6.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const MIGRATION = path.resolve(__dirname, '../../../migrations/0034_candidate-coordinates.sql');

/** Runs the real migration file, as drizzle would. */
async function runMigration() {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

/** A candidate as the pre-#347 writer stored it, coordinates included. */
const legacyCandidate = (id: string, over: Record<string, unknown> = {}) => ({
  googlePlaceId: id,
  name: `Quán ${id}`,
  address: `${id} Lê Lợi, Quận 1`,
  confidence: 0.82,
  lat: 10.7769,
  lng: 106.7009,
  ...over,
});

async function seedRow(input: {
  sourceRowId: string;
  ageDays: number;
  status: 'needs_confirmation' | 'unresolved' | 'imported';
  candidates: Record<string, unknown>[];
}) {
  const [job] = await db.insert(schema.placeIngestJobs).values({ sourceType: 'csv' }).returning();
  const [row] = await db
    .insert(schema.placeIngestRows)
    .values({
      jobId: job!.id,
      sourceRowId: input.sourceRowId,
      rowNumber: 1,
      rawInput: {},
      normalizedInput: {},
      status: input.status,
      candidates: input.candidates as never,
    })
    .returning();
  const at = sql`now() - (${input.ageDays} || ' days')::interval`;
  await db.execute(sql`
    update place_ingest_rows set created_at = ${at}, updated_at = ${at}
    where id = ${row!.id}::uuid
  `);
  return row!.id;
}

const candidatesOf = async (rowId: string) => {
  const [row] = await db
    .select()
    .from(schema.placeIngestRows)
    .where(eq(schema.placeIngestRows.id, rowId));
  return row!.candidates as unknown as Record<string, unknown>[];
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_candidate_coords_test')
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

describe('#347 — candidate coordinates are removed, everything else is not', () => {
  it('strips coordinates from a row older than the 30-day window', async () => {
    const rowId = await seedRow({
      sourceRowId: 'OLD-1',
      ageDays: 45,
      status: 'imported',
      candidates: [legacyCandidate('ChIJold-a'), legacyCandidate('ChIJold-b')],
    });

    await runMigration();

    const candidates = await candidatesOf(rowId);
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty('lat');
      expect(candidate).not.toHaveProperty('lng');
    }
    // Order is part of the meaning: candidates are ranked, best first.
    expect(candidates.map((c) => c['googlePlaceId'])).toEqual(['ChIJold-a', 'ChIJold-b']);
  });

  it('strips them from a current row too, and keeps every other field', async () => {
    // Deliberately fresh and still awaiting a moderator. Nothing reads the
    // coordinates even here, so there is no window in which holding them is
    // useful — and the fields the drawer actually renders must survive, which
    // is the line between this issue and #346.
    const rowId = await seedRow({
      sourceRowId: 'NEW-1',
      ageDays: 0,
      status: 'needs_confirmation',
      candidates: [legacyCandidate('ChIJnew-a', { confidence: 0.91 })],
    });

    await runMigration();

    const [candidate] = await candidatesOf(rowId);
    expect(candidate).toEqual({
      googlePlaceId: 'ChIJnew-a',
      name: 'Quán ChIJnew-a',
      address: 'ChIJnew-a Lê Lợi, Quận 1',
      confidence: 0.91,
    });
  });

  it('leaves updated_at alone — a purge is not editorial activity', async () => {
    const rowId = await seedRow({
      sourceRowId: 'STAMP-1',
      ageDays: 10,
      status: 'needs_confirmation',
      candidates: [legacyCandidate('ChIJstamp')],
    });
    const [before] = await db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.id, rowId));

    await runMigration();

    const [after] = await db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.id, rowId));
    expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString());
  });

  it('is idempotent, and copes with a row that has no candidates', async () => {
    const emptyId = await seedRow({
      sourceRowId: 'EMPTY-1',
      ageDays: 5,
      status: 'unresolved',
      candidates: [],
    });
    const rowId = await seedRow({
      sourceRowId: 'IDEM-1',
      ageDays: 5,
      status: 'needs_confirmation',
      candidates: [legacyCandidate('ChIJidem')],
    });

    await runMigration();
    const first = await candidatesOf(rowId);
    await runMigration();
    const second = await candidatesOf(rowId);

    expect(second).toEqual(first);
    // `jsonb_agg` over an empty array is NULL, and the column is NOT NULL — the
    // coalesce in the migration is what keeps this row from failing it.
    expect(await candidatesOf(emptyId)).toEqual([]);
  });

  it('leaves no coordinate anywhere in the table', async () => {
    await runMigration();
    const left = await db.execute(sql`
      select count(*)::int as n from place_ingest_rows
      where jsonb_path_exists(candidates, '$[*].lat')
         or jsonb_path_exists(candidates, '$[*].lng')
    `);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });
});
