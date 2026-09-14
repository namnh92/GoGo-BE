import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull, ne } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { AdministrativeBoundaryImportService, AdministrativeImportService } from '@gogo/modules';

/**
 * ADM-021 (#568) — discovery scoped by a position or by a canonical area: a
 * position wins and the two are never intersected, an area matches VERIFIED
 * mappings from the same dataset only, meta.location says which scope applied,
 * and the scope holds across cursor pages.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

let datasetVersion: string;
let provinceCode: string;
let communeCode: string;
let siblingCommuneCode: string;
let otherProvinceCode: string;

const NEAR = { lat: 10.776, lng: 106.7 };
const FAR = { lat: 21.03, lng: 105.85 };

function api() {
  return app.getHttpAdapter().getInstance();
}

type Page = {
  results: { id: string; name: string }[];
  nextCursor: string | null;
  meta: {
    location: {
      source: string;
      area?: {
        datasetVersion: string;
        provinceCode: string;
        provinceName: string;
        communeCode: string | null;
        communeName: string | null;
      };
    };
  };
};

async function search(params: Record<string, string | number>, status = 200) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await api().inject({ method: 'GET', url: `/v1/places/search?${qs.toString()}` });
  expect(res.statusCode).toBe(status);
  return res.json() as Page & { code?: string };
}

const names = (page: Page) => page.results.map((r) => r.name).sort();

async function insertPlace(
  name: string,
  at: { lat: number; lng: number },
  mapping: {
    provinceCode?: string;
    communeCode?: string;
    datasetVersion?: string;
    status: 'VERIFIED' | 'AUTO_MATCHED' | 'STALE' | 'UNMAPPED';
  },
) {
  await db.insert(schema.places).values({
    name,
    nameNormalized: 'set-by-trigger',
    status: 'published',
    geom: { x: at.lng, y: at.lat },
    rating: '4.20',
    ratingCount: 100,
    confidence: '0.9',
    freshnessCheckedAt: new Date(),
    provinceCode: mapping.provinceCode ?? null,
    communeCode: mapping.communeCode ?? null,
    administrativeDatasetVersion: mapping.datasetVersion ?? null,
    administrativeMappingStatus: mapping.status,
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_search_administrative_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    archivePath: path.resolve(
      __dirname,
      '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
    ),
  });
  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date() })
    .where(eq(schema.administrativeDatasetVersions.id, report.datasetVersionId));
  const current = and(
    eq(schema.administrativeUnits.datasetVersionId, report.datasetVersionId),
    eq(schema.administrativeUnits.status, 'ACTIVE'),
    isNull(schema.administrativeUnits.effectiveTo),
  );
  const [commune] = await db
    .select()
    .from(schema.administrativeUnits)
    .where(and(current, eq(schema.administrativeUnits.level, 'COMMUNE')))
    .limit(1);
  communeCode = commune!.code;
  provinceCode = commune!.parentCode!;
  const [sibling] = await db
    .select()
    .from(schema.administrativeUnits)
    .where(
      and(
        current,
        eq(schema.administrativeUnits.level, 'COMMUNE'),
        eq(schema.administrativeUnits.parentCode, provinceCode),
        ne(schema.administrativeUnits.code, communeCode),
      ),
    )
    .limit(1);
  siblingCommuneCode = sibling!.code;
  const [other] = await db
    .select()
    .from(schema.administrativeUnits)
    .where(
      and(
        current,
        eq(schema.administrativeUnits.level, 'PROVINCE'),
        ne(schema.administrativeUnits.code, provinceCode),
      ),
    )
    .limit(1);
  otherProvinceCode = other!.code;

  const inCommune = { provinceCode, communeCode, datasetVersion, status: 'VERIFIED' as const };
  await insertPlace('Gần trong xã', NEAR, inCommune);
  await insertPlace('Xa trong xã', FAR, inCommune);
  await insertPlace('Gần xã bên cạnh', NEAR, {
    provinceCode,
    communeCode: siblingCommuneCode,
    datasetVersion,
    status: 'VERIFIED',
  });
  await insertPlace('Gần tỉnh khác', NEAR, {
    provinceCode: otherProvinceCode,
    datasetVersion,
    status: 'VERIFIED',
  });
  await insertPlace('Gần chỉ tự khớp', NEAR, { ...inCommune, status: 'AUTO_MATCHED' });
  await insertPlace('Gần mã cũ', NEAR, {
    ...inCommune,
    datasetVersion: 'previous-dataset',
    status: 'STALE',
  });
  await insertPlace('Gần chưa ánh xạ', NEAR, { status: 'UNMAPPED' });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('ADM-021 discovery scope', () => {
  it('scopes to a commune or a whole province through verified mappings in the same dataset', async () => {
    const commune = await search({ datasetVersion, provinceCode, communeCode });
    expect(names(commune)).toEqual(['Gần trong xã', 'Xa trong xã'].sort());
    expect(commune.meta.location.source).toBe('administrative_area');
    expect(commune.meta.location.area).toMatchObject({ datasetVersion, provinceCode, communeCode });
    expect(commune.meta.location.area!.provinceName.length).toBeGreaterThan(0);
    expect(commune.meta.location.area!.communeName!.length).toBeGreaterThan(0);

    const province = await search({ datasetVersion, provinceCode });
    expect(names(province)).toEqual(['Gần trong xã', 'Xa trong xã', 'Gần xã bên cạnh'].sort());
    expect(province.meta.location.area).toMatchObject({ communeCode: null, communeName: null });
  });

  it('lets a position win over an area without intersecting the two', async () => {
    const near = { lat: NEAR.lat, lng: NEAR.lng, radiusM: 2000 };
    const gps = await search(near);
    expect(gps.meta.location).toEqual({ source: 'gps' });
    expect(names(gps)).toEqual(
      [
        'Gần trong xã',
        'Gần xã bên cạnh',
        'Gần tỉnh khác',
        'Gần chỉ tự khớp',
        'Gần mã cũ',
        'Gần chưa ánh xạ',
      ].sort(),
    );

    const both = await search({ ...near, datasetVersion, provinceCode, communeCode });
    expect(both.meta.location).toEqual({ source: 'gps' });
    expect(names(both)).toEqual(names(gps));
  });

  it('says when results are not location-scoped', async () => {
    const unscoped = await search({});
    expect(unscoped.meta.location).toEqual({ source: 'none' });
    expect(unscoped.results).toHaveLength(7);
  });

  it('rejects a commune outside its province, unknown codes, a partial area and an unpublished dataset', async () => {
    await search({ datasetVersion, provinceCode: otherProvinceCode, communeCode }, 400);
    await search({ datasetVersion, provinceCode: '99999' }, 400);
    await search({ provinceCode }, 400);
    await search({ datasetVersion }, 400);
    await search({ datasetVersion, communeCode }, 400);
    const stale = await search({ datasetVersion: 'not-published', provinceCode }, 409);
    expect(stale.code).toBe('ADMINISTRATIVE_VERSION_CHANGED');
  });

  it('keeps the area scope across cursor pages without duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await search({
        datasetVersion,
        provinceCode,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.meta.location.source).toBe('administrative_area');
      seen.push(...page.results.map((r) => r.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(['Gần trong xã', 'Xa trong xã', 'Gần xã bên cạnh'].sort());
  });
});
