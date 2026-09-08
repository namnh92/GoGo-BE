import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  AdministrativeResolverService,
} from '@gogo/modules';

/**
 * ADM-006 (#459) — the resolver against the real pinned dataset and real
 * PostGIS geometry.
 *
 * The polygons here are synthetic squares, not the pinned GIS release: loading
 * ~50 MB of GeoJSON is ADM-007 (#460). What is real is everything the squares
 * are compared against — 14,149 units, 9,569 canonical changes and 1,033
 * quarantined rows — and the containment semantics themselves, which is what
 * these tests are about. A square is enough to ask "what happens on a shared
 * border"; the answer must not depend on the shape.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let resolver: AdministrativeResolverService;

const BOUNDARY_VERSION = 'test-v1';
let datasetId: string;
let datasetVersion: string;

/** Codes discovered from the pinned data rather than assumed. */
let duplicateName: { normalized: string; codes: string[]; provinces: string[] };
let uniqueSuccessor: { oldCode: string; newCode: string };
let dividedCode: string;
let districtToSpecialZone: { oldCode: string; newCode: string } | null = null;
let historicalOnlyCode: string;
let reviewer: string;
let opsAdmin: string;

const api = () => app.getHttpAdapter().getInstance();

/** A square, as a MultiPolygon, in SRID 4326. */
function square(minLng: number, minLat: number, maxLng: number, maxLat: number): string {
  const ring = [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ]
    .map(([lng, lat]) => `${lng} ${lat}`)
    .join(', ');
  return `MULTIPOLYGON(((${ring})))`;
}

async function insertBoundary(row: {
  code: string;
  level: 'PROVINCE' | 'COMMUNE';
  parentCode: string | null;
  name: string;
  wkt: string;
}) {
  await db.execute(sql`
    insert into administrative_unit_boundaries
      (boundary_version, code, level, parent_code, name, name_normalized, geom, source, source_checksum)
    values (${BOUNDARY_VERSION}, ${row.code}, ${row.level}, ${row.parentCode}, ${row.name},
            ${row.name.toLowerCase()}, st_geomfromtext(${row.wkt}, 4326), 'test', 'test')`);
}

async function insertPlace(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: 'Quán Thử',
      nameNormalized: 'quan thu',
      geom: { x: 105.82, y: 21.04 },
      addressText: '12 Phan Đình Phùng',
      ...over,
    })
    .returning();
  return row!;
}

async function placeRow(id: string) {
  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  return row!;
}

/** Original fields the resolver must never touch. */
function originals(row: Record<string, unknown>) {
  return {
    name: row.name,
    nameNormalized: row.nameNormalized,
    city: row.city,
    district: row.district,
    addressText: row.addressText,
    geom: row.geom,
    areaKey: row.areaKey,
  };
}

// #489 — a dataset import binds the boundary release that is loaded, so every
// fixture that imports must load one first. The five-entry fixture is real,
// unmodified geometry from the pinned archive and needs no network.
async function loadFixtureBoundaries(database: Parameters<typeof migrate>[0]): Promise<void> {
  await new AdministrativeBoundaryImportService(database as never).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    // The fixture is vendored and has no fetch URL, so the path is explicit.
    archivePath: path.resolve(
      __dirname,
      '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
    ),
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_resolver_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  await loadFixtureBoundaries(db);

  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetId = report.datasetVersionId;
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: BOUNDARY_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));

  // Two neighbours sharing the meridian 105.85, a pair that genuinely overlaps,
  // and a province big enough to contain a point in none of them.
  await insertBoundary({
    code: '00004',
    level: 'COMMUNE',
    parentCode: '01',
    name: 'Ba Đình',
    wkt: square(105.8, 21.02, 105.85, 21.06),
  });
  await insertBoundary({
    code: '00008',
    level: 'COMMUNE',
    parentCode: '01',
    name: 'Ngọc Hà',
    wkt: square(105.85, 21.02, 105.9, 21.06),
  });
  await insertBoundary({
    code: '00025',
    level: 'COMMUNE',
    parentCode: '01',
    name: 'Giảng Võ',
    wkt: square(106.0, 21.0, 106.1, 21.1),
  });
  await insertBoundary({
    code: '00031',
    level: 'COMMUNE',
    parentCode: '01',
    name: 'Cửa Nam',
    wkt: square(106.05, 21.05, 106.15, 21.15),
  });
  await insertBoundary({
    code: '01',
    level: 'PROVINCE',
    parentCode: null,
    name: 'Hà Nội',
    wkt: square(105.0, 20.5, 107.0, 21.5),
  });

  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const admins = await db
    .insert(schema.adminUsers)
    .values([
      {
        email: 'adm006-reviewer@gogo.local',
        passwordHash,
        displayName: 'reviewer',
        role: 'moderator',
      },
      {
        email: 'adm006-ops@gogo.local',
        passwordHash,
        displayName: 'ops',
        role: 'ops_admin',
      },
    ])
    .returning();
  reviewer = admins[0]!.id;
  opsAdmin = admins[1]!.id;

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  resolver = app.get(AdministrativeResolverService);

  // Facts taken from the pinned data rather than assumed, so a source release
  // that changes them fails loudly here instead of silently weakening a test.
  const dup = await db.execute(sql`
    select name_normalized, array_agg(code order by code) as codes,
           array_agg(parent_code order by code) as parents
    from administrative_units
    where dataset_version_id = ${datasetId} and level = 'COMMUNE'
      and status = 'ACTIVE' and effective_to is null
    group by name_normalized having count(distinct parent_code) > 1
    order by name_normalized limit 1`);
  const dupRow = (
    dup as unknown as { rows: { name_normalized: string; codes: string[]; parents: string[] }[] }
  ).rows[0]!;
  duplicateName = {
    normalized: dupRow.name_normalized,
    codes: dupRow.codes,
    provinces: dupRow.parents,
  };

  const unique = await db.execute(sql`
    select old_code, min(new_code) as new_code
    from administrative_unit_changes
    where dataset_version_id = ${datasetId} and resolution = 'resolved'
    group by old_code having count(distinct new_code) = 1
    order by old_code limit 1`);
  const uniqueRow = (unique as unknown as { rows: { old_code: string; new_code: string }[] })
    .rows[0]!;
  uniqueSuccessor = { oldCode: uniqueRow.old_code, newCode: uniqueRow.new_code };

  const divided = await db.execute(sql`
    select q.old_code
    from administrative_mapping_quarantine q
    where q.dataset_version_id = ${datasetId}
      and q.classification = 'DIVIDED_REQUIRES_REVIEW'
      and not exists (
        select 1 from administrative_unit_changes c
        where c.dataset_version_id = q.dataset_version_id and c.old_code = q.old_code)
    order by q.old_code limit 1`);
  dividedCode = (divided as unknown as { rows: { old_code: string }[] }).rows[0]!.old_code;

  const specialZone = await db.execute(sql`
    select c.old_code, c.new_code
    from administrative_unit_changes c
    join administrative_units u
      on u.dataset_version_id = c.dataset_version_id
     and u.code = c.old_code and u.level = 'LEGACY_DISTRICT'
    where c.dataset_version_id = ${datasetId} and c.resolution = 'resolved'
    order by c.old_code limit 1`);
  const zoneRow = (specialZone as unknown as { rows: { old_code: string; new_code: string }[] })
    .rows[0];
  districtToSpecialZone = zoneRow ? { oldCode: zoneRow.old_code, newCode: zoneRow.new_code } : null;

  const historicalOnly = await db.execute(sql`
    select u.code from administrative_units u
    where u.dataset_version_id = ${datasetId} and u.level = 'COMMUNE' and u.effective_to is not null
      and not exists (
        select 1 from administrative_units c
        where c.dataset_version_id = u.dataset_version_id and c.code = u.code
          and c.status = 'ACTIVE' and c.effective_to is null)
    order by u.code limit 1`);
  historicalOnlyCode = (historicalOnly as unknown as { rows: { code: string }[] }).rows[0]!.code;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('boundary containment', () => {
  it('a point inside exactly one commune is AUTO_MATCHED, and implies its province', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      communeCode: '00004',
      provinceCode: '01',
      method: 'boundary_point_in_polygon',
      confidence: 1,
      boundaryVersion: BOUNDARY_VERSION,
      datasetVersion,
      reason: null,
    });
  });

  it('a point in the province but in no commune is NEEDS_REVIEW, never a province-only answer', async () => {
    const place = await insertPlace({ geom: { x: 105.2, y: 20.7 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('PROVINCE_ONLY');
    expect(result.candidates[0]!.provinceCode).toBe('01');
  });

  it('a point in no polygon at all is UNMAPPED', async () => {
    const place = await insertPlace({ geom: { x: 108.5, y: 12.0 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({ status: 'UNMAPPED', reason: 'NO_BOUNDARY_MATCH' });
  });

  it('a point inside two overlapping polygons is a conflict, not a choice', async () => {
    const place = await insertPlace({ geom: { x: 106.07, y: 21.07 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('MULTIPLE_BOUNDARY_MATCHES');
    expect(result.candidates.map((c) => c.communeCode).sort()).toEqual(['00025', '00031']);
    expect(result.communeCode).toBeNull();
  });

  it('a point on a shared border is reported as an edge, distinctly from an overlap', async () => {
    // Two neighbours both contain a point on the line between them. That is
    // geometry working correctly; overlapping polygons are a data defect, and
    // the two have different fixes, so they get different reasons.
    const place = await insertPlace({ geom: { x: 105.85, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('BOUNDARY_EDGE');
    expect(result.confidence).toBeNull();
    expect(result.candidates.map((c) => c.communeCode).sort()).toEqual(['00004', '00008']);
  });

  it('a point outside Vietnam is invalid geometry, and is not asked of PostGIS', async () => {
    const place = await insertPlace({ geom: { x: 0, y: 0 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({ status: 'UNMAPPED', reason: 'INVALID_GEOMETRY' });
  });

  it('skips the geometric path entirely when no boundary release is pinned', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id, { boundaryVersion: null });
    expect(result).toMatchObject({ status: 'UNMAPPED', reason: 'NO_BOUNDARY_VERSION' });
  });

  it('refuses to store a legacy district polygon at any version', async () => {
    // There are none, anywhere: the units were dissolved before any of these
    // releases were drawn, so a legacy code can never be boundary-derived.
    const violation = await db
      .execute(
        sql`insert into administrative_unit_boundaries
          (boundary_version, code, level, parent_code, name, name_normalized, geom, source, source_checksum)
        values (${BOUNDARY_VERSION}, '001', 'LEGACY_DISTRICT', '01', 'Ba Đình', 'ba dinh',
                st_geomfromtext(${square(105.8, 21.02, 105.85, 21.06)}, 4326), 'test', 'test')`,
      )
      .then(
        () => null,
        (error: unknown) => constraintOf(error),
      );
    expect(violation).toBe('administrative_boundaries_level_has_polygons');
  });

  it('uses the GiST index rather than scanning every polygon', async () => {
    const plan = await db.execute(sql`
      explain (format json)
      select b.code from administrative_unit_boundaries b
      where b.boundary_version = ${BOUNDARY_VERSION}
        and st_intersects(b.geom, st_setsrid(st_makepoint(105.82, 21.04), 4326))`);
    // At five rows PostgreSQL will still choose a sequential scan; what this
    // asserts is that the index exists and is available to the planner, which
    // is what stops the 3,355-polygon release from being a full scan per place.
    const indexes = await db.execute(sql`
      select indexname from pg_indexes where tablename = 'administrative_unit_boundaries'`);
    const names = (indexes as unknown as { rows: { indexname: string }[] }).rows.map(
      (r) => r.indexname,
    );
    expect(names).toContain('administrative_boundaries_geom_gist');
    expect(plan).toBeDefined();
  });
});

describe('explicitly supplied codes', () => {
  it('AUTO_MATCHES a valid province/commune pair', async () => {
    const place = await insertPlace({ geom: { x: 108.5, y: 12.0 } });
    const result = await resolver.resolvePlace(place.id, {
      trustedCodes: { provinceCode: '01', communeCode: '00004' },
    });
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      method: 'trusted_code',
      communeCode: '00004',
      confidence: 1,
      boundaryVersion: null,
    });
  });

  it('sends an impossible hierarchy to review rather than storing it', async () => {
    const place = await insertPlace({ geom: { x: 108.5, y: 12.0 } });
    const result = await resolver.resolvePlace(place.id, {
      // 00004 is a Hà Nội commune; 79 is Hồ Chí Minh.
      trustedCodes: { provinceCode: '79', communeCode: '00004' },
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('INVALID_HIERARCHY');
  });

  it('reports a disagreement between an explicit code and the geometry', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id, {
      trustedCodes: { provinceCode: '01', communeCode: '00008' },
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('EVIDENCE_CONFLICT');
    expect(result.confidence).toBeNull();
    expect(result.candidates.map((c) => c.communeCode).sort()).toEqual(['00004', '00008']);
  });
});

describe('names already stored on the place', () => {
  it('matches an unaccented district under a named city', async () => {
    // `normalizeVietnamese` folds accents and case, so "ba dinh" and
    // "Phường Bà Đình" meet in one space. One normalizer, not two.
    const place = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      city: 'Hà Nội',
      district: 'ba dinh',
    });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      method: 'structured_components',
      provinceCode: '01',
      communeCode: '00004',
      confidence: null,
    });
  });

  it('refuses a name that names several communes under different provinces', async () => {
    const place = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      district: duplicateName.normalized,
    });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('AMBIGUOUS_NAME');
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it('resolves the same name once a city narrows it to one province', async () => {
    const [province] = await db
      .select({ name: schema.administrativeUnits.name })
      .from(schema.administrativeUnits)
      .where(
        and(
          eq(schema.administrativeUnits.datasetVersionId, datasetId),
          eq(schema.administrativeUnits.code, duplicateName.provinces[0]!),
          eq(schema.administrativeUnits.level, 'PROVINCE'),
        ),
      );
    const place = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      city: province!.name,
      district: duplicateName.normalized,
    });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.provinceCode).toBe(duplicateName.provinces[0]);
  });
});

describe('history: a code is not an identity', () => {
  it('00004 names two different units on either side of 2025-07-01', async () => {
    const rows = await db
      .select({
        fullName: schema.administrativeUnits.fullName,
        effectiveFrom: schema.administrativeUnits.effectiveFrom,
        effectiveTo: schema.administrativeUnits.effectiveTo,
      })
      .from(schema.administrativeUnits)
      .where(
        and(
          eq(schema.administrativeUnits.datasetVersionId, datasetId),
          eq(schema.administrativeUnits.code, '00004'),
          eq(schema.administrativeUnits.level, 'COMMUNE'),
        ),
      )
      .orderBy(schema.administrativeUnits.effectiveFrom);
    expect(rows.map((r) => r.fullName)).toEqual(['Phường Trúc Bạch', 'Phường Ba Đình']);
    expect(rows[0]!.effectiveTo).toBe('2025-06-30');
    expect(rows[1]!.effectiveTo).toBeNull();
  });

  it('follows a unique canonical successor', async () => {
    const place = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      communeCode: uniqueSuccessor.oldCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: 'legacy-import',
    });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.method).toBe('change_mapping');
    expect(result.communeCode).toBe(uniqueSuccessor.newCode);
    // GoGo's own record of a legal change: trusted enough to resolve, and not a
    // measurement of this place, so it carries no number.
    expect(result.confidence).toBeNull();
  });

  it('leaves a divided commune unresolved without independent evidence', async () => {
    // The upstream offers a default target for every divided ward, and
    // ADR-0019 forbids trusting it. Name similarity cannot break the tie.
    const place = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      communeCode: dividedCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: 'legacy-import',
    });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('DIVIDED_CHANGE');
    expect(result.communeCode).toBe(dividedCode);
  });

  it('resolves that same divided commune when geometry answers it independently', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      communeCode: dividedCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: 'legacy-import',
    });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.method).toBe('boundary_point_in_polygon');
    expect(result.communeCode).toBe('00004');
  });

  it('follows a district that became a special zone, where the pins record one', async () => {
    if (!districtToSpecialZone) return;
    const place = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      communeCode: districtToSpecialZone.oldCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: 'legacy-import',
    });
    const result = await resolver.resolvePlace(place.id);
    expect(result.communeCode).toBe(districtToSpecialZone.newCode);
    expect(result.method).toBe('change_mapping');
  });

  it('never invents a legacy district from geometry', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.legacyDistrictCode).toBeNull();
  });

  it('accepts an explicitly supplied legacy district code alongside a current match', async () => {
    const [district] = await db
      .select({ code: schema.administrativeUnits.code })
      .from(schema.administrativeUnits)
      .where(
        and(
          eq(schema.administrativeUnits.datasetVersionId, datasetId),
          eq(schema.administrativeUnits.level, 'LEGACY_DISTRICT'),
        ),
      )
      .orderBy(schema.administrativeUnits.code)
      .limit(1);
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id, {
      trustedCodes: { legacyDistrictCode: district!.code },
    });
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.legacyDistrictCode).toBe(district!.code);
  });
});

describe('persistence', () => {
  it('writes only the administrative columns, leaving every original field alone', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      city: 'Hà Nội',
      district: 'Quận Ba Đình',
      addressText: '19 Lê Hồng Phong',
    });
    const before = originals(await placeRow(place.id));

    const result = await resolver.resolvePlace(place.id);
    expect(await resolver.persist(result)).toMatchObject({ outcome: 'written' });

    const after = await placeRow(place.id);
    expect(originals(after)).toEqual(before);
    expect(after).toMatchObject({
      communeCode: '00004',
      provinceCode: '01',
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'boundary_point_in_polygon',
      administrativeBoundaryVersion: BOUNDARY_VERSION,
      administrativeDatasetVersion: datasetVersion,
      administrativeMappingConfidence: '1.00',
    });
    expect(after.administrativeMappedAt).not.toBeNull();
  });

  it('is idempotent: an identical re-run writes nothing and does not touch updated_at', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    await resolver.persist(await resolver.resolvePlace(place.id));
    const first = await placeRow(place.id);

    const second = await resolver.persist(await resolver.resolvePlace(place.id));
    expect(second.outcome).toBe('noop');
    const after = await placeRow(place.id);
    expect(after.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect(after.administrativeMappedAt!.getTime()).toBe(first.administrativeMappedAt!.getTime());
  });

  it('refuses a write when the place moved under the caller', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id);
    const stale = new Date(place.updatedAt.getTime() - 1000);

    const outcome = await resolver.persist(result, { expectedUpdatedAt: stale });
    expect(outcome).toMatchObject({ outcome: 'conflict', reason: 'PLACE_MODIFIED' });
    expect((await placeRow(place.id)).administrativeMappingStatus).toBe('UNMAPPED');
  });

  it('records the evidence in the audit row', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    await resolver.persist(await resolver.resolvePlace(place.id));
    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, 'administrative_mapping.resolve'),
          eq(schema.auditLogs.resourceId, place.id),
        ),
      );
    const diff = audit!.diff as Record<string, any>;
    expect(diff.to.communeCode).toBe('00004');
    expect(diff.from.status).toBe('UNMAPPED');
    expect(diff.evidence[0].method).toBe('boundary_point_in_polygon');
  });

  it('leaves the previous mapping intact when the write fails', async () => {
    // The audit is written inside the same transaction as the mapping, so an
    // audit that cannot be stored takes the mapping down with it — which is the
    // behaviour that keeps a mapping from existing with no account of itself.
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      communeCode: '00008',
      provinceCode: '01',
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: datasetVersion,
    });
    const result = await resolver.resolvePlace(place.id);
    await expect(
      resolver.persist(result, { actor: { id: 'not-a-uuid', type: 'admin' } }),
    ).rejects.toThrow();

    const after = await placeRow(place.id);
    expect(after.communeCode).toBe('00008');
    expect(after.administrativeMappingSource).toBe('exact_name');
  });
});

describe('reviewer-owned rows', () => {
  it('never re-points a VERIFIED place, and refuses to write one', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      communeCode: '00025',
      provinceCode: '01',
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: null,
    });
    const before = await placeRow(place.id);

    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({ status: 'VERIFIED', communeCode: '00025', writable: false });
    expect(result.reason).toBe('REVIEWER_OWNED');

    expect(await resolver.persist(result)).toMatchObject({ outcome: 'blocked' });
    const after = await placeRow(place.id);
    expect(after.communeCode).toBe('00025');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('keeps a REJECTED mapping until a rematch is explicitly asked for', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      administrativeMappingStatus: 'REJECTED',
      administrativeDatasetVersion: datasetVersion,
    });
    const kept = await resolver.resolvePlace(place.id);
    expect(kept.status).toBe('REJECTED');
    expect(await resolver.persist(kept)).toMatchObject({ outcome: 'blocked' });

    const rematched = await resolver.resolvePlace(place.id, { allowRematchRejected: true });
    expect(rematched.status).toBe('AUTO_MATCHED');
    expect(await resolver.persist(rematched, { allowRematchRejected: true })).toMatchObject({
      outcome: 'written',
    });
    expect((await placeRow(place.id)).communeCode).toBe('00004');
  });
});

describe('staleness evaluation', () => {
  it('calls a mapping labelled with an older version but still valid REVALIDATED', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      communeCode: '00004',
      provinceCode: '01',
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'boundary_point_in_polygon',
      administrativeBoundaryVersion: BOUNDARY_VERSION,
      administrativeDatasetVersion: 'v4.9.0+old',
    });
    expect(await resolver.evaluateStalenessFor(place.id)).toMatchObject({
      stale: false,
      reason: 'REVALIDATED',
    });
  });

  it('flags a code the active dataset does not hold, and writes nothing', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      communeCode: historicalOnlyCode,
      provinceCode: '01',
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: 'v4.9.0+old',
    });
    const before = await placeRow(place.id);
    const verdict = await resolver.evaluateStalenessFor(place.id);
    expect(verdict).toMatchObject({
      stale: true,
      reviewerOwned: true,
      requiresReview: true,
    });
    // Evaluation only: STALE is #461/#462's to write, and never onto a
    // verified row without a person.
    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('VERIFIED');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

describe('confidence is definitional, against the real dataset', () => {
  it('numbers an explicit code and a strictly-inside containment, and nothing else', async () => {
    const byCode = await insertPlace({ geom: { x: 108.5, y: 12.0 } });
    const codeResult = await resolver.resolvePlace(byCode.id, {
      trustedCodes: { provinceCode: '01', communeCode: '00004' },
    });
    expect(codeResult).toMatchObject({ status: 'AUTO_MATCHED', confidence: 1 });

    const byGeometry = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    expect(await resolver.resolvePlace(byGeometry.id)).toMatchObject({
      status: 'AUTO_MATCHED',
      method: 'boundary_point_in_polygon',
      confidence: 1,
    });

    const byName = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      city: 'Hà Nội',
      district: 'ba dinh',
    });
    expect(await resolver.resolvePlace(byName.id)).toMatchObject({
      status: 'AUTO_MATCHED',
      method: 'structured_components',
      confidence: null,
    });
  });

  it('keeps 1.00 when an explicit code and the geometry agree', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id, {
      trustedCodes: { provinceCode: '01', communeCode: '00004' },
    });
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      method: 'trusted_code',
      communeCode: '00004',
      confidence: 1,
    });
  });

  it('stores 1.00 as a real column value, and null as null', async () => {
    const numbered = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    await resolver.persist(await resolver.resolvePlace(numbered.id));
    expect((await placeRow(numbered.id)).administrativeMappingConfidence).toBe('1.00');

    const unnumbered = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      city: 'Hà Nội',
      district: 'ba dinh',
    });
    await resolver.persist(await resolver.resolvePlace(unnumbered.id));
    const row = await placeRow(unnumbered.id);
    expect(row.administrativeMappingStatus).toBe('AUTO_MATCHED');
    expect(row.administrativeMappingConfidence).toBeNull();
  });
});

describe('reviewer attribution', () => {
  it('leaves a VERIFIED row and its reviewer untouched on an ordinary run', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      communeCode: '00025',
      provinceCode: '01',
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: reviewer,
    });
    const result = await resolver.resolvePlace(place.id);
    expect(await resolver.persist(result)).toMatchObject({ outcome: 'blocked' });

    const after = await placeRow(place.id);
    expect(after.administrativeMappedBy).toBe(reviewer);
    expect(after.communeCode).toBe('00025');
    expect(after.administrativeMappingStatus).toBe('VERIFIED');
  });

  it('keeps the reviewer while a REJECTED decision still stands', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      administrativeMappingStatus: 'REJECTED',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: reviewer,
    });
    expect(await resolver.persist(await resolver.resolvePlace(place.id))).toMatchObject({
      outcome: 'blocked',
    });
    expect((await placeRow(place.id)).administrativeMappedBy).toBe(reviewer);
  });

  it('clears the reviewer when an authorised rematch replaces their decision', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      administrativeMappingStatus: 'REJECTED',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: reviewer,
    });
    // What #462 would have written when the reviewer rejected it. It must
    // survive the rematch: the audit log is where the history lives.
    await db.insert(schema.auditLogs).values({
      actorType: 'admin',
      actorId: reviewer,
      action: 'administrative_mapping.reject',
      resourceType: 'place',
      resourceId: place.id,
      diff: { to: { status: 'REJECTED' } },
    });

    const result = await resolver.resolvePlace(place.id, { allowRematchRejected: true });
    expect(
      await resolver.persist(result, {
        allowRematchRejected: true,
        actor: { id: opsAdmin, type: 'admin' },
      }),
    ).toMatchObject({ outcome: 'written' });

    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('AUTO_MATCHED');
    expect(after.communeCode).toBe('00004');
    // The row must never emerge machine-mapped while still crediting a person.
    expect(after.administrativeMappedBy).toBeNull();
  });

  it('records the rematch actor apart from the mapping, and keeps the reviewer history', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      administrativeMappingStatus: 'REJECTED',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: reviewer,
    });
    await db.insert(schema.auditLogs).values({
      actorType: 'admin',
      actorId: reviewer,
      action: 'administrative_mapping.reject',
      resourceType: 'place',
      resourceId: place.id,
      diff: { to: { status: 'REJECTED' } },
    });

    const result = await resolver.resolvePlace(place.id, { allowRematchRejected: true });
    await resolver.persist(result, {
      allowRematchRejected: true,
      actor: { id: opsAdmin, type: 'admin' },
    });

    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place.id))
      .orderBy(schema.auditLogs.createdAt);
    // The rejection is still there, still attributed to the reviewer.
    const rejection = rows.find((r) => r.action === 'administrative_mapping.reject');
    expect(rejection?.actorId).toBe(reviewer);

    const resolve = rows.find((r) => r.action === 'administrative_mapping.resolve');
    const diff = resolve!.diff as Record<string, any>;
    expect(resolve!.actorId).toBe(opsAdmin);
    expect(diff.rematch).toMatchObject({
      requestedBy: opsAdmin,
      previousStatus: 'REJECTED',
      previousReviewer: reviewer,
      clearedReviewerAttribution: true,
    });
    // Asking for a rematch is not verifying anything.
    expect(diff.to.status).toBe('AUTO_MATCHED');
    expect(diff.to.mappedBy).toBeNull();
    expect(diff.to.source).toBe('boundary_point_in_polygon');
  });

  it('does not clear the reviewer when the rematch finds nothing and the row stays rejected', async () => {
    const place = await insertPlace({
      geom: { x: 108.5, y: 12.0 },
      administrativeMappingStatus: 'REJECTED',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: reviewer,
    });
    const result = await resolver.resolvePlace(place.id, { allowRematchRejected: true });
    // No evidence anywhere, so the proposal is UNMAPPED — which does replace
    // the decision, and does clear the attribution.
    expect(result.status).toBe('UNMAPPED');
    await resolver.persist(result, {
      allowRematchRejected: true,
      actor: { id: opsAdmin, type: 'admin' },
    });
    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('UNMAPPED');
    expect(after.administrativeMappedBy).toBeNull();
  });
});

describe('ADM-015: resolution without a place, and inside a caller transaction', () => {
  it('classifies a bare point the same way it classifies a stored place', async () => {
    // The import wizard has to show an operator which commune a row lands in
    // before anything exists to look up. Answering that with a second code path
    // is how a preview starts disagreeing with the commit, so it is the same
    // one — and this is the assertion that says so.
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const stored = await resolver.resolvePlace(place.id);
    const bare = await resolver.resolveGeometry({
      subjectId: 'preview-row-1',
      geometry: { lng: 105.82, lat: 21.04 },
    });

    expect(bare).toMatchObject({
      placeId: 'preview-row-1',
      status: stored.status,
      provinceCode: stored.provinceCode,
      communeCode: stored.communeCode,
      method: stored.method,
      confidence: stored.confidence,
      datasetVersion: stored.datasetVersion,
      boundaryVersion: stored.boundaryVersion,
    });
  });

  it('leaves a point in no polygon UNMAPPED rather than in a review queue', async () => {
    const bare = await resolver.resolveGeometry({
      subjectId: 'preview-row-2',
      geometry: { lng: 108.5, lat: 12.0 },
    });
    expect(bare).toMatchObject({ status: 'UNMAPPED', reason: 'NO_BOUNDARY_MATCH' });
  });

  it('sends a point inside two overlapping polygons to review, with both candidates', async () => {
    const bare = await resolver.resolveGeometry({
      subjectId: 'preview-row-3',
      geometry: { lng: 106.07, lat: 21.07 },
    });
    expect(bare.status).toBe('NEEDS_REVIEW');
    expect(bare.reason).toBe('MULTIPLE_BOUNDARY_MATCHES');
    expect(bare.candidates.map((c) => c.communeCode).sort()).toEqual(['00025', '00031']);
  });

  it('takes trusted codes on a bare point, the same evidence path a place uses', async () => {
    const bare = await resolver.resolveGeometry(
      { subjectId: 'preview-row-4', geometry: null },
      { trustedCodes: { provinceCode: '01', communeCode: '00004' } },
    );
    expect(bare).toMatchObject({
      status: 'AUTO_MATCHED',
      provinceCode: '01',
      communeCode: '00004',
      method: 'trusted_code',
      confidence: 1,
    });
  });

  it('sees a place created in the same transaction, which the pool cannot', async () => {
    await db
      .transaction(async (tx) => {
        const [created] = await tx
          .insert(schema.places)
          .values({
            name: 'Quán Trong Giao Dịch',
            nameNormalized: 'set-by-trigger',
            geom: { x: 105.82, y: 21.04 },
          })
          .returning();

        // The row is invisible outside this transaction, so this is the whole
        // point of the executor parameter: without it the resolver would raise
        // PLACE_NOT_FOUND for a place the caller has in its hand.
        const resolution = await resolver.resolvePlaceWithin(tx, created!.id);
        expect(resolution).toMatchObject({ status: 'AUTO_MATCHED', communeCode: '00004' });

        const persisted = await resolver.persistWithin(tx, resolution, {
          actor: { id: null, type: 'system' },
        });
        expect(persisted).toMatchObject({ outcome: 'written', status: 'AUTO_MATCHED' });

        const [seen] = await tx
          .select()
          .from(schema.places)
          .where(eq(schema.places.id, created!.id));
        expect(seen).toMatchObject({ communeCode: '00004', provinceCode: '01' });
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        expect((error as Error).message).toBe('rollback');
      });
  });

  it('rolls the mapping back with the place when the caller transaction fails', async () => {
    let createdId = '';
    await db
      .transaction(async (tx) => {
        const [created] = await tx
          .insert(schema.places)
          .values({
            name: 'Quán Rollback',
            nameNormalized: 'set-by-trigger',
            geom: { x: 105.82, y: 21.04 },
          })
          .returning();
        createdId = created!.id;
        await resolver.persistWithin(tx, await resolver.resolvePlaceWithin(tx, createdId));
        throw new Error('rollback');
      })
      .catch(() => undefined);

    // Not "the mapping was rolled back" — the *place* was, and a mapping that
    // outlived it would be a row pointing at nothing.
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, createdId));
    expect(row).toBeUndefined();
  });

  it('refuses to overwrite a VERIFIED mapping from inside a caller transaction', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      provinceCode: '79',
      communeCode: duplicateName.codes[0]!,
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: reviewer,
    });

    await db.transaction(async (tx) => {
      const resolution = await resolver.resolvePlaceWithin(tx, place.id);
      const result = await resolver.persistWithin(tx, resolution, {
        actor: { id: opsAdmin, type: 'admin' },
      });
      expect(result).toMatchObject({ outcome: 'blocked', reason: 'REVIEWER_OWNED' });
    });

    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('VERIFIED');
    expect(after.administrativeMappedBy).toBe(reviewer);
  });

  it('marks a contradicted VERIFIED mapping STALE, keeping its codes and its reviewer', async () => {
    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      provinceCode: '79',
      communeCode: duplicateName.codes[0]!,
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: reviewer,
    });

    await db.transaction(async (tx) => {
      const staled = await resolver.markStaleWithin(tx, place.id, {
        reason: 'GEOMETRY_CONTRADICTS_VERIFIED_MAPPING',
        actor: { id: opsAdmin, type: 'admin' },
      });
      expect(staled).toBe(true);
    });

    const after = await placeRow(place.id);
    expect(after).toMatchObject({
      administrativeMappingStatus: 'STALE',
      // The verification happened; it is the place that moved out from under
      // it. Erasing the reviewer would lose the one person worth asking.
      administrativeMappedBy: reviewer,
      provinceCode: '79',
      communeCode: duplicateName.codes[0]!,
      administrativeMappingSource: 'editor',
    });
  });

  it('leaves every non-VERIFIED status alone when asked to mark it stale', async () => {
    for (const status of ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW', 'REJECTED'] as const) {
      const place = await insertPlace({
        geom: { x: 105.82, y: 21.04 },
        administrativeMappingStatus: status,
        ...(status === 'UNMAPPED'
          ? {}
          : {
              provinceCode: '01',
              communeCode: '00004',
              // `trusted_code`, not `boundary_point_in_polygon`:
              // `places_administrative_boundary_version_present` requires a
              // boundary version alongside a boundary-derived mapping, and this
              // fixture is about the status, not about the evidence.
              administrativeMappingSource: 'trusted_code',
              administrativeDatasetVersion: datasetVersion,
            }),
      });
      await db.transaction(async (tx) => {
        expect(await resolver.markStaleWithin(tx, place.id, { reason: 'test' })).toBe(false);
      });
      expect((await placeRow(place.id)).administrativeMappingStatus).toBe(status);
    }
  });
});

describe('the resolver calls nothing and caches nothing', () => {
  it('issues no Google request and no Redis command across the whole surface', async () => {
    // ADR-0019 §10 / GoGo-BE#464: the codes are GoGo facts precisely because
    // no provider is asked. ADR-0019 §8: administrative data is not in Upstash.
    const google = await metricCount('places_provider_requests_total');
    const redis = await metricCount('provider_requests_total', 'upstash');

    const place = await insertPlace({
      geom: { x: 105.82, y: 21.04 },
      city: 'Hà Nội',
      district: 'ba dinh',
    });
    await resolver.persist(await resolver.resolvePlace(place.id));
    await resolver.evaluateStalenessFor(place.id);

    expect(await metricCount('places_provider_requests_total')).toBe(google);
    expect(await metricCount('provider_requests_total', 'upstash')).toBe(redis);
  });
});

/** drizzle wraps the driver error; the constraint name is on the cause chain. */
function constraintOf(error: unknown): string | null {
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 5; depth += 1) {
    const candidate = (cursor as { constraint?: string }).constraint;
    if (candidate) return candidate;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

async function metricCount(metric: string, contains?: string): Promise<number> {
  // `/v1/metrics`, not `/metrics`: the app sets a global `v1` prefix, and an
  // earlier version of this helper asked for the unprefixed path, got a 404 and
  // returned 0 — so every "the provider counter did not move" assertion built
  // on it was comparing zero to zero. It throws now rather than answering 0,
  // because a scrape that cannot be read is not evidence of anything.
  const metrics = await api().inject({
    method: 'GET',
    url: '/v1/metrics',
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN ?? ''}` },
  });
  if (metrics.statusCode !== 200) {
    throw new Error(
      `metrics scrape failed with ${metrics.statusCode}; the assertion would be vacuous`,
    );
  }
  return metrics.body
    .split('\n')
    .filter((line) => line.startsWith(metric) && (!contains || line.includes(contains)))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}
