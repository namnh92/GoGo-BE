import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
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
  await db.execute(sql`truncate table administrative_unit_change_overrides cascade`);
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
    await expect(
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

describe('overrides are GoGo-owned and never edit upstream', () => {
  it('allows one live override per edge and keeps a revoked one beside it', async () => {
    const edge = {
      oldCode: '00025',
      newCode: '00008',
      changeType: 'SPLIT' as const,
      effectiveDate: '2025-07-01',
      reason: 'Toạ độ trụ sở nằm trong Ngọc Hà',
      decidedAgainstVersion: 'test-1',
    };
    const [first] = await db
      .insert(schema.administrativeUnitChangeOverrides)
      .values(edge)
      .returning();
    await expectViolation(
      () => db.insert(schema.administrativeUnitChangeOverrides).values(edge),
      'administrative_unit_change_overrides_live_unique',
    );

    await db.execute(
      sql`update administrative_unit_change_overrides set revoked_at = now() where id = ${first!.id}`,
    );
    await expect(
      db.insert(schema.administrativeUnitChangeOverrides).values(edge),
    ).resolves.toBeDefined();
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
    await expect(
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
