import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  AdministrativeResolverService,
  BoundaryArchiveReader,
  BoundaryValidationError,
  BoundaryVersionConflictError,
  SnapshotChecksumError,
  readZipEntries,
} from '@gogo/modules';

/**
 * ADM-007 (#460) — loading a pinned boundary release.
 *
 * Everything here runs offline against `boundaries-fixture.v5.0.0.zip`: five
 * real, unmodified entries taken from the pinned archive, so the geometry is
 * genuine even though the coverage is deliberately partial. The 47.6 MB release
 * is not committed and not downloaded in CI; the describe at the bottom runs
 * against it when `ADMINISTRATIVE_BOUNDARY_ARCHIVE` names a local copy, which
 * is how the coverage and performance numbers in the PR were measured.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let loader: AdministrativeBoundaryImportService;
let resolver: AdministrativeResolverService;
let datasetId: string;
let datasetVersion: string;

const FIXTURE_VERSION = 'fixture-v5.0.0';
const RESOURCES = path.resolve(__dirname, '../../../resources/administrative');
const FIXTURE = path.join(RESOURCES, 'boundaries-fixture.v5.0.0.zip');
const FULL_ARCHIVE = process.env.ADMINISTRATIVE_BOUNDARY_ARCHIVE;

const api = () => app.getHttpAdapter().getInstance();

async function boundaryRows(version: string) {
  return db
    .select({
      code: schema.administrativeUnitBoundaries.code,
      level: schema.administrativeUnitBoundaries.level,
      parentCode: schema.administrativeUnitBoundaries.parentCode,
    })
    .from(schema.administrativeUnitBoundaries)
    .where(eq(schema.administrativeUnitBoundaries.boundaryVersion, version))
    .orderBy(schema.administrativeUnitBoundaries.code);
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

/** A point guaranteed to be strictly inside a unit's polygon. */
async function insidePoint(code: string): Promise<{ lng: number; lat: number }> {
  const [row] = await rows<{ lng: number; lat: number }>(sql`
    select st_x(p) as lng, st_y(p) as lat from (
      select st_pointonsurface(geom) as p from administrative_unit_boundaries
      where boundary_version = ${FIXTURE_VERSION} and code = ${code}) s`);
  return row!;
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_boundaries_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetId = report.datasetVersionId;
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: FIXTURE_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  resolver = app.get(AdministrativeResolverService);
  loader = new AdministrativeBoundaryImportService(db);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('the pinned fixture is real, unmodified source data', () => {
  it('is checksum-verified before a single entry is read', async () => {
    const reader = new BoundaryArchiveReader();
    const source = reader.source('boundaries-fixture');
    const resolved = await reader.resolve(source, FIXTURE);
    expect(resolved.sha256).toBe(source.sha256);
    expect(resolved.origin).toBe('explicit');
    expect(resolved.bytes).toBe(source.bytes);
  });

  it('holds five entries, every one a single MultiPolygon feature', async () => {
    const entries = readZipEntries(
      await import('node:fs').then((fs) => fs.readFileSync(FIXTURE)),
    ).filter((e) => e.name.endsWith('.geojson'));
    expect(entries).toHaveLength(5);

    const reader = new BoundaryArchiveReader();
    const features = [...reader.features(FIXTURE)];
    expect(features).toHaveLength(5);
    expect(features.every((f) => f.geometryType === 'MultiPolygon')).toBe(true);
    expect(
      features
        .filter((f) => f.level === 'PROVINCE')
        .map((f) => f.code)
        .sort(),
    ).toEqual(['01', '48']);
    // The province directory is where a ward's parent comes from; the gates
    // cross-check it against the pinned units rather than trusting it.
    const hoangSa = features.find((f) => f.code === '20333')!;
    expect(hoangSa).toMatchObject({ level: 'COMMUNE', parentCode: '48' });
  });

  it('refuses an archive whose bytes do not match the pin', async () => {
    const tampered = path.join(container.getId().slice(0, 8) + '-tampered.zip');
    const target = path.resolve('/tmp', tampered);
    const bytes = await import('node:fs').then((fs) => fs.readFileSync(FIXTURE));
    // One flipped byte inside the compressed payload: still a zip, no longer
    // the zip the coverage counts and the licence review were done against.
    const flip = Math.floor(bytes.length / 2);
    bytes[flip] = (bytes[flip] ?? 0) ^ 0xff;
    writeFileSync(target, bytes);

    const reader = new BoundaryArchiveReader();
    await expect(
      reader.resolve(reader.source('boundaries-fixture'), target),
    ).rejects.toBeInstanceOf(SnapshotChecksumError);
  });

  it('refuses a truncated archive before touching the database', async () => {
    const target = '/tmp/adm007-truncated.zip';
    const bytes = await import('node:fs').then((fs) => fs.readFileSync(FIXTURE));
    writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)));

    await expect(
      loader.load({
        role: 'boundaries-fixture',
        boundaryVersion: 'truncated',
        archivePath: target,
      }),
    ).rejects.toThrow();
    expect(await boundaryRows('truncated')).toEqual([]);
  });
});

describe('loading', () => {
  it('loads every feature, validates it, and records the release', async () => {
    const result = await loader.load({
      role: 'boundaries-fixture',
      boundaryVersion: FIXTURE_VERSION,
      archivePath: FIXTURE,
    });
    expect(result.outcome).toBe('loaded');
    expect(result.counts).toEqual({ provinces: 2, communes: 3 });
    expect(result.validation.errors).toBe(0);
    expect(result.validation.loadable).toBe(true);
    // Every entry is already a MultiPolygon, so ST_Multi promoted nothing. The
    // number is reported rather than assumed, because a future release that
    // shipped Polygons would change what the loader silently did.
    expect(result.promotedToMultiPolygon).toBe(0);

    const [ledger] = await db.select().from(schema.administrativeBoundaryLoads);
    expect(ledger).toMatchObject({
      boundaryVersion: FIXTURE_VERSION,
      license: 'MIT',
      provinceCount: 2,
      communeCount: 3,
      sourceCommit: 'b092d6b45ea76c39990afd34375eabe1f6c3a492',
    });
  });

  it('stores MultiPolygon in SRID 4326, and nothing else', async () => {
    const stored = await rows<{ type: string; srid: number; n: number }>(sql`
      select geometrytype(geom) as type, st_srid(geom) as srid, count(*)::int as n
      from administrative_unit_boundaries where boundary_version = ${FIXTURE_VERSION}
      group by 1, 2`);
    expect(stored).toEqual([{ type: 'MULTIPOLYGON', srid: 4326, n: 5 }]);
  });

  it('every code resolves to a current unit, with the hierarchy the units declare', async () => {
    const unresolved = await rows<{ code: string }>(sql`
      select b.code from administrative_unit_boundaries b
      where b.boundary_version = ${FIXTURE_VERSION} and not exists (
        select 1 from administrative_units u
        where u.dataset_version_id = ${datasetId} and u.code = b.code and u.level = b.level
          and u.status = 'ACTIVE' and u.effective_to is null)`);
    expect(unresolved).toEqual([]);

    const mismatched = await rows<{ code: string }>(sql`
      select b.code from administrative_unit_boundaries b
      join administrative_units u on u.dataset_version_id = ${datasetId}
       and u.code = b.code and u.level = b.level and u.effective_to is null
      where b.boundary_version = ${FIXTURE_VERSION} and b.level = 'COMMUNE'
        and b.parent_code is distinct from u.parent_code`);
    expect(mismatched).toEqual([]);
  });

  it('holds no legacy district geometry at any version', async () => {
    const legacy = await rows<{ n: number }>(
      sql`select count(*)::int as n from administrative_unit_boundaries where level = 'LEGACY_DISTRICT'`,
    );
    expect(legacy[0]!.n).toBe(0);
  });

  it('is idempotent: the same archive again writes nothing', async () => {
    const before = await db.select().from(schema.administrativeBoundaryLoads);
    const result = await loader.load({
      role: 'boundaries-fixture',
      boundaryVersion: FIXTURE_VERSION,
      archivePath: FIXTURE,
    });
    expect(result.outcome).toBe('unchanged');
    expect(result.counts).toEqual({ provinces: 2, communes: 3 });
    const after = await db.select().from(schema.administrativeBoundaryLoads);
    expect(after).toEqual(before);
  });

  it('refuses a different archive under a version name that is already loaded', async () => {
    // A version name identifies its contents. Redefining one would leave every
    // place that recorded it pointing at polygons it was never resolved against.
    await expect(
      loader.load({
        role: 'current-boundaries',
        boundaryVersion: FIXTURE_VERSION,
        archivePath: FULL_ARCHIVE ?? FIXTURE,
      }),
    ).rejects.toBeInstanceOf(FULL_ARCHIVE ? BoundaryVersionConflictError : Error);
  });

  it('refuses an archive that is not the one the version pins', async () => {
    // The fixture's bytes are not the release's bytes, so loading it as the
    // release fails on the checksum — before the database is touched at all.
    await expect(
      loader.load({
        role: 'current-boundaries',
        boundaryVersion: 'coverage-failure',
        archivePath: FIXTURE,
      }),
    ).rejects.toBeInstanceOf(SnapshotChecksumError);
    expect(await boundaryRows('coverage-failure')).toEqual([]);
  });

  it('rolls back a load whose codes do not resolve, leaving the version absent', async () => {
    // Point the validation at a dataset that holds none of these codes.
    const [empty] = await db
      .insert(schema.administrativeDatasetVersions)
      .values({
        combinedDatasetVersion: 'empty-dataset',
        combinedChecksum: 'empty-checksum',
        currentSourceVersion: 'none',
        source: 'test',
        effectiveDate: '2025-07-01',
        status: 'STAGED',
      })
      .returning();

    await expect(
      loader.load({
        role: 'boundaries-fixture',
        boundaryVersion: 'unresolved-codes',
        archivePath: FIXTURE,
        datasetVersionId: empty!.id,
      }),
    ).rejects.toBeInstanceOf(BoundaryValidationError);

    expect(await boundaryRows('unresolved-codes')).toEqual([]);
    const ledger = await db
      .select()
      .from(schema.administrativeBoundaryLoads)
      .where(eq(schema.administrativeBoundaryLoads.boundaryVersion, 'unresolved-codes'));
    expect(ledger).toEqual([]);
  });
});

describe('containment against the loaded polygons', () => {
  it('resolves a mainland point to its commune, with confidence 1.00', async () => {
    const point = await insidePoint('00004');
    const place = await insertPlace({ geom: { x: point.lng, y: point.lat } });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      communeCode: '00004',
      provinceCode: '01',
      method: 'boundary_point_in_polygon',
      boundaryVersion: FIXTURE_VERSION,
      confidence: 1,
    });
  });

  it('resolves an offshore special zone exactly as the source ships it', async () => {
    // Hoàng Sa is in the release as Đặc khu Hoàng Sa under Đà Nẵng. GoGo loads
    // and resolves what the pinned source says, without editing its geography.
    const point = await insidePoint('20333');
    const place = await insertPlace({ geom: { x: point.lng, y: point.lat } });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      communeCode: '20333',
      provinceCode: '48',
      confidence: 1,
    });
    expect(point.lng).toBeGreaterThan(110);
  });

  it('gives a unique match on a polygon edge no confidence', async () => {
    const [edge] = await rows<{ lng: number; lat: number }>(sql`
      select st_x(p) as lng, st_y(p) as lat from (
        select st_pointonsurface(st_boundary(geom)) as p
        from administrative_unit_boundaries
        where boundary_version = ${FIXTURE_VERSION} and code = '20333') s`);
    const place = await insertPlace({ geom: { x: edge!.lng, y: edge!.lat } });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.communeCode).toBe('20333');
    // Strictly inside is definitional; on the line is not.
    expect(result.confidence).toBeNull();
  });

  it('sends a point on a shared administrative border to review', async () => {
    const [shared] = await rows<{ lng: number; lat: number }>(sql`
      select st_x(p) as lng, st_y(p) as lat from (
        select st_pointonsurface(st_intersection(a.geom, b.geom)) as p
        from administrative_unit_boundaries a
        join administrative_unit_boundaries b
          on b.boundary_version = a.boundary_version and b.code = '00008'
        where a.boundary_version = ${FIXTURE_VERSION} and a.code = '00004'
          and st_touches(a.geom, b.geom)) s`);
    // The fixture's two Hà Nội communes were chosen because they share a border.
    expect(shared).toBeDefined();
    const place = await insertPlace({ geom: { x: shared!.lng, y: shared!.lat } });
    const result = await resolver.resolvePlace(place.id);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('BOUNDARY_EDGE');
    expect(result.confidence).toBeNull();
    expect(result.candidates.map((c) => c.communeCode).sort()).toEqual(['00004', '00008']);
  });

  it('leaves a point outside every loaded polygon unmapped', async () => {
    const place = await insertPlace({ geom: { x: 106.7, y: 10.77 } });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({ status: 'UNMAPPED', reason: 'NO_BOUNDARY_MATCH' });
  });

  it('keeps the GiST index available to the planner', async () => {
    const indexes = await rows<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'administrative_unit_boundaries'`,
    );
    expect(indexes.map((i) => i.indexname)).toContain('administrative_boundaries_geom_gist');
  });

  it('does not fabricate a result when the release is missing', async () => {
    const place = await insertPlace({ geom: { x: 105.82, y: 21.04 } });
    const result = await resolver.resolvePlace(place.id, { boundaryVersion: 'never-loaded' });
    expect(result).toMatchObject({ status: 'UNMAPPED', reason: 'NO_BOUNDARY_MATCH' });
    expect(result.communeCode).toBeNull();
  });

  it('issues no Google request and no Redis command while loading or resolving', async () => {
    const google = await metricCount('places_provider_requests_total');
    const redis = await metricCount('provider_requests_total', 'upstash');
    const point = await insidePoint('00004');
    const place = await insertPlace({ geom: { x: point.lng, y: point.lat } });
    await resolver.persist(await resolver.resolvePlace(place.id));
    await loader.load({
      role: 'boundaries-fixture',
      boundaryVersion: FIXTURE_VERSION,
      archivePath: FIXTURE,
    });
    expect(await metricCount('places_provider_requests_total')).toBe(google);
    expect(await metricCount('provider_requests_total', 'upstash')).toBe(redis);
  });
});

/**
 * The real 47.6 MB release. Not committed and not fetched in CI; run locally
 * with ADMINISTRATIVE_BOUNDARY_ARCHIVE pointing at a verified copy, which is
 * how the coverage and performance figures in the PR were produced.
 */
describe.skipIf(!FULL_ARCHIVE || !existsSync(FULL_ARCHIVE))('the full pinned release', () => {
  it('loads 34 provinces and 3,321 communes with no errors', async () => {
    const result = await loader.load({
      role: 'current-boundaries',
      boundaryVersion: 'v5.0.0',
      archivePath: FULL_ARCHIVE!,
    });
    expect(result.counts).toEqual({ provinces: 34, communes: 3321 });
    expect(result.validation.errors).toBe(0);
    expect(result.promotedToMultiPolygon).toBe(0);

    process.stdout.write(
      `\n[ADM-007] loaded ${result.counts.provinces}/${result.counts.communes} in ` +
        `${(result.durationMs / 1000).toFixed(1)}s; warnings ` +
        `${result.validation.warnings}; findings ` +
        `${result.validation.findings.map((f) => `${f.severity}:${f.gate}=${f.count}`).join(' ')}\n` +
        `[ADM-007] topology shared=${result.topology.sharedBoundaryPairs} ` +
        `overlaps=${result.topology.sameLevelOverlaps.count} ` +
        `outsideProvince=${result.topology.communesOutsideProvince.count} ` +
        `areaOutliers=${result.topology.areaOutliers.count} ` +
        `dupShapes=${result.topology.duplicateGeometryHashes.count} ` +
        `outsideBbox=${result.topology.outsideVietnamBbox.count} ` +
        `area=${JSON.stringify(result.topology.measuredAreaKm2)}\n`,
    );
  }, 900_000);

  it('reports its stored size, index size and query plan', async () => {
    const [size] = await rows<{ table: string; indexes: string; total: string }>(sql`
      select pg_size_pretty(pg_table_size('administrative_unit_boundaries')) as table,
             pg_size_pretty(pg_indexes_size('administrative_unit_boundaries')) as indexes,
             pg_size_pretty(pg_total_relation_size('administrative_unit_boundaries')) as total`);

    // A point strictly inside a commune, which is what resolution actually
    // asks. A coordinate lifted off a ring sits on a border and matches two
    // polygons, so it would measure the ambiguous case rather than the normal one.
    const [interior] = await rows<{ lng: number; lat: number }>(sql`
      select st_x(p) as lng, st_y(p) as lat from (
        select st_pointonsurface(geom) as p from administrative_unit_boundaries
        where boundary_version = 'v5.0.0' and code = '00004' and level = 'COMMUNE') s`);

    const plan = await rows<{ 'QUERY PLAN': unknown }>(sql`
      explain (analyze, buffers, format json)
      select code from administrative_unit_boundaries
      where boundary_version = 'v5.0.0' and level = 'COMMUNE'
        and st_intersects(geom, st_setsrid(st_makepoint(${interior!.lng}, ${interior!.lat}), 4326))`);
    const text = JSON.stringify(plan);
    expect(text).toContain('administrative_boundaries_geom_gist');
    expect(text).toContain('Index Scan');

    // Twenty real resolutions across the country, timed end to end.
    const points = await rows<{ lng: number; lat: number; code: string }>(sql`
      select st_x(st_pointonsurface(geom)) as lng, st_y(st_pointonsurface(geom)) as lat, code
      from administrative_unit_boundaries
      where boundary_version = 'v5.0.0' and level = 'COMMUNE'
      order by code limit 20`);
    const started = Date.now();
    for (const point of points) {
      const found = await rows<{ code: string }>(sql`
        select code from administrative_unit_boundaries
        where boundary_version = 'v5.0.0' and level = 'COMMUNE'
          and st_intersects(geom, st_setsrid(st_makepoint(${point.lng}, ${point.lat}), 4326))`);
      expect(found.map((f) => f.code)).toContain(point.code);
    }
    const perQuery = (Date.now() - started) / points.length;

    process.stdout.write(
      `\n[ADM-007] size ${JSON.stringify(size)}\n` +
        `[ADM-007] mean point-in-polygon ${perQuery.toFixed(1)}ms over ${points.length} points\n` +
        `[ADM-007] plan ${text}\n`,
    );
  }, 300_000);

  it('resolves a real place through the loaded release', async () => {
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: 'v5.0.0' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    const [interior] = await rows<{ lng: number; lat: number }>(sql`
      select st_x(p) as lng, st_y(p) as lat from (
        select st_pointonsurface(geom) as p from administrative_unit_boundaries
        where boundary_version = 'v5.0.0' and code = '26732' and level = 'COMMUNE') s`);

    // Côn Đảo: an island special zone that was a district before 2025-07-01 and
    // changed province. Resolving it from geometry alone is the whole point.
    const place = await insertPlace({ geom: { x: interior!.lng, y: interior!.lat } });
    const result = await resolver.resolvePlace(place.id);
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      communeCode: '26732',
      provinceCode: '79',
      method: 'boundary_point_in_polygon',
      boundaryVersion: 'v5.0.0',
      confidence: 1,
      datasetVersion,
    });
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: FIXTURE_VERSION })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
  }, 300_000);
});

async function metricCount(metric: string, contains?: string): Promise<number> {
  const metrics = await api().inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN ?? ''}` },
  });
  if (metrics.statusCode !== 200) return 0;
  return metrics.body
    .split('\n')
    .filter((line) => line.startsWith(metric) && (!contains || line.includes(contains)))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}
