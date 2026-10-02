import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/**
 * ADM-001 (#454) / ADR-0019 — the constraints, against a real database.
 *
 * These are not schema snapshots. Each test states an invariant the design
 * argues for and then tries to violate it: a code reused across effective
 * periods must be accepted, two published datasets must not be, a mapped place
 * must name the dataset that mapped it, and the columns ADR-0016 owns must
 * survive the migration untouched.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');

/** A dataset row is the parent of everything else, so every test needs one. */
async function seedDataset(over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [row] = await db
    .insert(schema.administrativeDatasetVersions)
    .values({
      combinedDatasetVersion: `test-${suffix}`,
      combinedChecksum: `sum-${suffix}`,
      currentSourceVersion: 'v5.0.0',
      source: 'test',
      effectiveDate: '2025-07-01',
      ...over,
    })
    .returning();
  return row!.id;
}

/**
 * Drizzle wraps a failed query in its own error whose message is only
 * `Failed query: insert into …`; the constraint that actually rejected the row
 * is on the `pg` error underneath. Asserting on the outer message would pass
 * for *any* failure, which is precisely the assertion these tests must not
 * make — so the cause chain is walked and the constraint named.
 */
async function expectViolation(run: () => Promise<unknown>, constraint: string) {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${constraint} to reject the write`).toBeDefined();

  const seen: string[] = [];
  for (let err: unknown = caught; err != null; err = (err as { cause?: unknown }).cause) {
    const e = err as { message?: string; constraint?: string };
    if (e.constraint) seen.push(e.constraint);
    if (e.message) seen.push(e.message);
  }
  expect(seen.join(' | ')).toContain(constraint);
}

const province = (datasetVersionId: string, over: Record<string, unknown> = {}) => ({
  datasetVersionId,
  code: '01',
  name: 'Hà Nội',
  fullName: 'Thành phố Hà Nội',
  nameNormalized: 'ha noi',
  fullNameNormalized: 'thanh pho ha noi',
  unitType: 'MUNICIPALITY' as const,
  level: 'PROVINCE' as const,
  effectiveFrom: '2025-07-01',
  source: 'thanglequoc/vietnamese-provinces-database',
  sourceVersion: 'v5.0.0',
  ...over,
});

const commune = (datasetVersionId: string, over: Record<string, unknown> = {}) => ({
  datasetVersionId,
  code: '00004',
  name: 'Ba Đình',
  fullName: 'Phường Ba Đình',
  nameNormalized: 'ba dinh',
  fullNameNormalized: 'phuong ba dinh',
  unitType: 'WARD' as const,
  level: 'COMMUNE' as const,
  parentCode: '01',
  effectiveFrom: '2025-07-01',
  source: 'thanglequoc/vietnamese-provinces-database',
  sourceVersion: 'v5.0.0',
  ...over,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // CASCADE from the dataset clears units, changes and quarantine with it.
  await db.execute(sql`truncate table administrative_dataset_versions cascade`);
});

describe('administrative_units identity', () => {
  it('accepts one code across two effective periods — the reuse is real', async () => {
    // 00004 was Phường Trúc Bạch before 2025-07-01 and is Phường Ba Đình after.
    // 2,212 of the 3,321 current commune codes do this. A UNIQUE(code) would
    // refuse the historical row and make the current one silently ambiguous.
    const dataset = await seedDataset();
    await db.insert(schema.administrativeUnits).values([
      commune(dataset, {
        name: 'Trúc Bạch',
        fullName: 'Phường Trúc Bạch',
        nameNormalized: 'truc bach',
        fullNameNormalized: 'phuong truc bach',
        effectiveFrom: '2004-01-01',
        effectiveTo: '2025-06-30',
        status: 'INACTIVE',
        sourceVersion: 'v2.4.1',
      }),
      commune(dataset),
    ]);

    const rows = await db.execute(
      sql`select code, name, effective_from from administrative_units where code = '00004' order by effective_from`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => (r as { name: string }).name)).toEqual(['Trúc Bạch', 'Ba Đình']);
  });

  it('refuses the same code twice in one effective period', async () => {
    const dataset = await seedDataset();
    await db.insert(schema.administrativeUnits).values(commune(dataset));
    await expectViolation(
      () => db.insert(schema.administrativeUnits).values(commune(dataset, { name: 'Khác' })),
      'administrative_units_code_effective_unique',
    );
  });

  it('lets a staged dataset hold a code the published one also holds', async () => {
    // Uniqueness is scoped to the dataset: staging is a parallel copy, not an
    // edit of the live set, and it must be able to carry the same codes.
    const published = await seedDataset({ status: 'PUBLISHED' });
    const staged = await seedDataset();
    await db.insert(schema.administrativeUnits).values(commune(published));
    await expect(
      db.insert(schema.administrativeUnits).values(commune(staged)),
    ).resolves.toBeDefined();
  });

  it('refuses a unit that is its own parent', async () => {
    const dataset = await seedDataset();
    await expectViolation(
      () => db.insert(schema.administrativeUnits).values(commune(dataset, { parentCode: '00004' })),
      'administrative_units_not_own_parent',
    );
  });

  it('refuses a province with a parent and a commune without one', async () => {
    const dataset = await seedDataset();
    await expectViolation(
      () => db.insert(schema.administrativeUnits).values(province(dataset, { parentCode: '99' })),
      'administrative_units_parent_by_level',
    );
    await expectViolation(
      () => db.insert(schema.administrativeUnits).values(commune(dataset, { parentCode: null })),
      'administrative_units_parent_by_level',
    );
  });

  it('refuses an effective period that ends before it starts', async () => {
    const dataset = await seedDataset();
    await expectViolation(
      () =>
        db
          .insert(schema.administrativeUnits)
          .values(commune(dataset, { effectiveFrom: '2025-07-01', effectiveTo: '2025-06-30' })),
      'administrative_units_effective_range',
    );
  });
});

describe('administrative_dataset_versions', () => {
  it('allows at most one PUBLISHED version', async () => {
    await seedDataset({ status: 'PUBLISHED' });
    await expectViolation(
      () => seedDataset({ status: 'PUBLISHED' }),
      'administrative_dataset_versions_one_published',
    );
  });

  it('allows many STAGED versions beside the published one', async () => {
    await seedDataset({ status: 'PUBLISHED' });
    await expect(seedDataset()).resolves.toBeDefined();
    await expect(seedDataset()).resolves.toBeDefined();
  });

  it('refuses a second version carrying a checksum already imported', async () => {
    await seedDataset({ combinedChecksum: 'identical' });
    await expectViolation(
      () => seedDataset({ combinedChecksum: 'identical' }),
      'administrative_dataset_versions_checksum_unique',
    );
  });
});

describe('administrative_unit_changes', () => {
  it('holds many legacy units against one current unit (MERGED)', async () => {
    const dataset = await seedDataset();
    await db.insert(schema.administrativeUnitChanges).values([
      {
        datasetVersionId: dataset,
        oldCode: '00001',
        newCode: '00097',
        changeType: 'MERGED',
        effectiveDate: '2025-07-01',
        sourceVersion: '7fac8c4',
      },
      {
        datasetVersionId: dataset,
        oldCode: '00004',
        newCode: '00097',
        changeType: 'MERGED',
        effectiveDate: '2025-07-01',
        sourceVersion: '7fac8c4',
      },
    ]);
    const rows = await db.execute(
      sql`select count(*)::int as n from administrative_unit_changes where new_code = '00097'`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(2);
  });

  it('holds one legacy unit against many current units (SPLIT), marked ambiguous', async () => {
    // 471 legacy communes split into 2–5 current ones. None of them may be
    // resolved by the importer; a person or a coordinate decides.
    const dataset = await seedDataset();
    await db.insert(schema.administrativeUnitChanges).values(
      ['00025', '00199', '00008'].map((newCode) => ({
        datasetVersionId: dataset,
        oldCode: '00025',
        newCode,
        changeType: 'SPLIT' as const,
        effectiveDate: '2025-07-01',
        sourceVersion: '7fac8c4',
        resolution: 'ambiguous' as const,
      })),
    );
    const rows = await db.execute(
      sql`select count(*)::int as n from administrative_unit_changes
          where old_code = '00025' and resolution = 'ambiguous'`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(3);
  });

  it('refuses an edge with neither endpoint', async () => {
    const dataset = await seedDataset();
    await expectViolation(
      () =>
        db.insert(schema.administrativeUnitChanges).values({
          datasetVersionId: dataset,
          oldCode: null,
          newCode: null,
          changeType: 'DISSOLVED',
          effectiveDate: '2025-07-01',
          sourceVersion: '7fac8c4',
        }),
      'administrative_unit_changes_endpoints',
    );
  });

  it('refuses the same edge twice', async () => {
    const dataset = await seedDataset();
    const edge = {
      datasetVersionId: dataset,
      oldCode: '00001',
      newCode: '00097',
      changeType: 'MERGED' as const,
      effectiveDate: '2025-07-01',
      sourceVersion: '7fac8c4',
    };
    await db.insert(schema.administrativeUnitChanges).values(edge);
    await expectViolation(
      () => db.insert(schema.administrativeUnitChanges).values(edge),
      'administrative_unit_changes_edge_unique',
    );
  });
});

describe('the global override table is gone (#486)', () => {
  // 0051 created `administrative_unit_change_overrides`: a global override that
  // won at resolve time. #484 rejected that semantics (only a PUBLISHED dataset
  // changes precedence) and ADM-011 replaced it with override sets; 0068 drops
  // the table. A fresh database must not carry it, or its indexes, again.
  it('drops the table and both of its indexes', async () => {
    const { rows } = await db.execute(
      sql`select to_regclass('public.administrative_unit_change_overrides') as t`,
    );
    expect(rows[0]!.t).toBeNull();

    const idx = await db.execute(
      sql`select indexname from pg_indexes where indexname like 'administrative_unit_change_overrides%'`,
    );
    expect(idx.rows).toEqual([]);
  });

  it('refuses to drop the table while it still holds a row', async () => {
    // The issue's precondition is `count(*) = 0` everywhere. If an environment
    // ever wrote one, the deploy must stop with the data intact, not drop it.
    const statements = readFileSync(
      path.join(MIGRATIONS, '0068_drop-administrative-unit-change-overrides.sql'),
      'utf8',
    ).split('--> statement-breakpoint');
    await db.execute(
      sql`create table administrative_unit_change_overrides (id uuid primary key default gen_random_uuid())`,
    );
    try {
      await db.execute(sql`insert into administrative_unit_change_overrides default values`);
      // Run it the way drizzle does: every statement inside one transaction.
      const runMigration = async () => {
        const c = await pool.connect();
        try {
          await c.query('begin');
          for (const stmt of statements) await c.query(stmt);
          await c.query('commit');
        } catch (err) {
          await c.query('rollback');
          throw err;
        } finally {
          c.release();
        }
      };
      // RAISE EXCEPTION is SQLSTATE P0001; asserting the code and message
      // rules out any other failure passing for the guard.
      await expect(runMigration()).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringMatching(/is not empty; refusing to drop/),
      });
      const { rows } = await db.execute(
        sql`select count(*)::int as n from administrative_unit_change_overrides`,
      );
      expect(rows[0]!.n).toBe(1);

      // Emptied, the same migration goes through.
      await db.execute(sql`delete from administrative_unit_change_overrides`);
      await runMigration();
      const after = await db.execute(
        sql`select to_regclass('public.administrative_unit_change_overrides') as t`,
      );
      expect(after.rows[0]!.t).toBeNull();
    } finally {
      await db.execute(sql`drop table if exists administrative_unit_change_overrides`);
    }
  });

  it('gives up within the lock budget instead of queueing admin_users (F-02)', async () => {
    // DROP removes the FK triggers on admin_users. A long transaction there
    // (a CMS write) must make the migration abort fast and retryably, not wait
    // indefinitely while every new admin_users query queues behind it.
    const statements = readFileSync(
      path.join(MIGRATIONS, '0068_drop-administrative-unit-change-overrides.sql'),
      'utf8',
    ).split('--> statement-breakpoint');
    await db.execute(
      sql`create table administrative_unit_change_overrides (id uuid primary key default gen_random_uuid(), created_by uuid references admin_users(id) on delete set null)`,
    );
    const holder = await pool.connect();
    const a = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('lock table admin_users in row exclusive mode');

      const started = Date.now();
      let caught: { code?: string } | undefined;
      try {
        await a.query('begin');
        for (const stmt of statements) await a.query(stmt);
        await a.query('commit');
      } catch (err) {
        caught = err as { code?: string };
        await a.query('rollback');
      }
      expect(caught?.code).toBe('55P03'); // lock_not_available
      expect(Date.now() - started).toBeLessThan(15_000);

      await holder.query('rollback');
      const { rows } = await db.execute(
        sql`select to_regclass('public.administrative_unit_change_overrides') as t`,
      );
      expect(rows[0]!.t).not.toBeNull(); // aborted: nothing dropped, retry later
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      a.release();
      await db.execute(sql`drop table if exists administrative_unit_change_overrides`);
    }
  });

  it('a row written while the migration runs is never dropped silently (F-01)', async () => {
    // Drizzle runs the migration inside one transaction. Between the emptiness
    // check and the DROP, a second connection must not be able to commit a row
    // that the DROP then deletes. Either its write waits/fails, or the
    // migration sees it and aborts — never both "write committed" and "table
    // dropped".
    const statements = readFileSync(
      path.join(MIGRATIONS, '0068_drop-administrative-unit-change-overrides.sql'),
      'utf8',
    ).split('--> statement-breakpoint');
    const guardAt = statements.findIndex((s) => s.includes('DO $$'));
    expect(guardAt).toBeGreaterThanOrEqual(0);

    await db.execute(
      sql`create table administrative_unit_change_overrides (id uuid primary key default gen_random_uuid())`,
    );
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('begin');
      for (const stmt of statements.slice(0, guardAt + 1)) await a.query(stmt);

      // B writes in autocommit while A sits between the check and the DROP.
      let bCommitted = false;
      const bWrite = b
        .query('insert into administrative_unit_change_overrides default values')
        .then(() => {
          bCommitted = true;
        });
      bWrite.catch(() => undefined);
      await Promise.race([bWrite, new Promise((r) => setTimeout(r, 1_000))]);

      let aDropped = false;
      try {
        for (const stmt of statements.slice(guardAt + 1)) await a.query(stmt);
        await a.query('commit');
        aDropped = true;
      } catch {
        await a.query('rollback');
      }
      await bWrite.catch(() => undefined);

      expect({ bCommitted, aDropped }).not.toEqual({ bCommitted: true, aDropped: true });
    } finally {
      a.release();
      b.release();
      await db.execute(sql`drop table if exists administrative_unit_change_overrides`);
    }
  });
});

describe('places compatibility', () => {
  /** A place, minimal, as any pre-ADM writer would have made it. */
  async function insertPlace(over: Record<string, unknown> = {}) {
    const [row] = await db
      .insert(schema.places)
      .values({
        name: 'Quán Cũ',
        nameNormalized: 'quan cu',
        geom: { x: 106.7009, y: 10.7769 },
        addressText: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM',
        city: 'TP.HCM',
        district: 'Quận 1',
        areaKey: 'hcm_q1',
        ...over,
      })
      .returning();
    return row!;
  }

  it('leaves an existing place UNMAPPED with its free-text address intact', async () => {
    const place = await insertPlace();
    expect(place.administrativeMappingStatus).toBe('UNMAPPED');
    expect(place.provinceCode).toBeNull();
    expect(place.communeCode).toBeNull();
    // The three fields ADR-0016 owns are untouched by this migration.
    expect(place.addressText).toBe('12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM');
    expect(place.city).toBe('TP.HCM');
    expect(place.district).toBe('Quận 1');
    expect(place.areaKey).toBe('hcm_q1');
  });

  it('refuses a mapped place that does not name the dataset that mapped it', async () => {
    // A code without its dataset version is ambiguous across 2025-07-01, so
    // the database refuses to hold one rather than trusting the writer.
    await expectViolation(
      () =>
        insertPlace({
          communeCode: '00004',
          administrativeMappingStatus: 'AUTO_MATCHED',
          administrativeDatasetVersion: null,
        }),
      'places_administrative_version_present',
    );
  });

  it('accepts a mapped place that names its dataset', async () => {
    const place = await insertPlace({
      provinceCode: '01',
      communeCode: '00004',
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: 'gogo-2026-09-07-a',
      administrativeMappedAt: new Date(),
    });
    expect(place.communeCode).toBe('00004');
    expect(place.administrativeDatasetVersion).toBe('gogo-2026-09-07-a');
  });

  it('refuses a boundary-derived claim that cannot name its boundary set', async () => {
    // GoGo-BE#464 classified these codes as GoGo's own facts *because* they are
    // reproducible from a stored point and a pinned boundary version. A claim
    // that cannot name the version is not reproducible, so it is not that kind
    // of fact and the database will not hold it.
    await expectViolation(
      () =>
        insertPlace({
          provinceCode: '01',
          communeCode: '00004',
          administrativeMappingStatus: 'AUTO_MATCHED',
          administrativeMappingSource: 'boundary_point_in_polygon',
          administrativeDatasetVersion: 'gogo-2026-09-07-a',
          administrativeBoundaryVersion: null,
        }),
      'places_administrative_boundary_version_present',
    );
  });

  it('accepts a boundary-derived claim that names both versions', async () => {
    const place = await insertPlace({
      provinceCode: '01',
      communeCode: '00004',
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'boundary_point_in_polygon',
      administrativeDatasetVersion: 'gogo-2026-09-07-a',
      administrativeBoundaryVersion: 'gis-v4.0.0',
      administrativeMappedAt: new Date(),
    });
    expect(place.administrativeBoundaryVersion).toBe('gis-v4.0.0');
    expect(place.administrativeMappingSource).toBe('boundary_point_in_polygon');
  });

  it('lets a non-boundary claim omit the boundary version', async () => {
    // The constraint is scoped to the evidence that needs it. An editor typing
    // a code owes no boundary provenance, because no polygon was consulted.
    const place = await insertPlace({
      provinceCode: '01',
      communeCode: '00004',
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: 'gogo-2026-09-07-a',
    });
    expect(place.administrativeBoundaryVersion).toBeNull();
  });

  it('refuses a confidence outside 0..1', async () => {
    await expectViolation(
      () =>
        insertPlace({
          administrativeMappingStatus: 'AUTO_MATCHED',
          administrativeDatasetVersion: 'gogo-2026-09-07-a',
          administrativeMappingConfidence: '1.50',
        }),
      'places_administrative_confidence_range',
    );
  });

  it('keeps legacy_district_code as evidence without it joining the hierarchy', async () => {
    const place = await insertPlace({
      provinceCode: '79',
      communeCode: '26737',
      legacyDistrictCode: '760',
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: 'gogo-2026-09-07-a',
    });
    expect(place.legacyDistrictCode).toBe('760');
    expect(place.district).toBe('Quận 1');
  });
});
