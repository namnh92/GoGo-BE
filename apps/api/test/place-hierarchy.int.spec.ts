import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import { AdministrativeBoundaryImportService, AdministrativeImportService } from '@gogo/modules';

/**
 * ADM-018 (#502) — the canonical Province → Commune hierarchy for places.
 *
 * The console had two competing address systems: `area_key`, a curated
 * discovery bucket, and the pair of canonical codes ADR-0019 introduced. Only
 * the first could be filtered on, and nothing could count places by the second
 * — so there was no way to present the hierarchy the country actually has.
 *
 * Every assertion here is about a number an editor will click on. A count that
 * does not return the rows it promises is worse than no count at all, so each
 * one is checked against the list query it claims to describe.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let datasetId: string;
let datasetVersion: string;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.63.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
let token: string;

const get = (url: string) =>
  api().inject({
    method: 'GET',
    url,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${token}` },
  });

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

/** Two provinces from the pinned dataset, with two real communes in the first. */
let provinceA: string;
let provinceB: string;
let communeA1: string;
let communeA2: string;
let communeB1: string;

type Summary = {
  datasetVersion: string | null;
  level: 'province' | 'commune';
  province: { code: string; name: string } | null;
  units: { code: string; name: string | null; placeCount: number; reviewCount: number | null }[];
  totals: { grouped: number; review: number };
  review: { byStatus: Record<string, number> };
};

const summary = async (query = ''): Promise<Summary> => {
  const res = await get(`/v1/cms/places/administrative-summary${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Summary;
};

const list = async (query = '') => {
  const res = await get(`/v1/cms/places${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: { id: string; name: string }[]; nextCursor: string | null };
};

let seq = 0;
async function place(over: Partial<typeof schema.places.$inferInsert> = {}) {
  const name = `Địa Điểm ${++seq}`;
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: name.toLowerCase(),
      status: 'draft',
      geom: { x: 106.7, y: 10.77 },
      administrativeDatasetVersion: datasetVersion,
      ...over,
    })
    .returning();
  return row!;
}

/** The ordinary case: groupable, in the commune it says it is in. */
const grouped = (provinceCode: string, communeCode: string, over = {}) =>
  place({
    provinceCode,
    communeCode,
    administrativeMappingStatus: 'AUTO_MATCHED',
    administrativeMappingSource: 'boundary_point_in_polygon',
    administrativeBoundaryVersion: 'fixture-v1',
    ...over,
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_place_hierarchy_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  // #489 — a dataset import binds the boundary release loaded at the time, so
  // the geometry goes in first even though nothing here resolves a point.
  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    archivePath: path.resolve(
      __dirname,
      '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
    ),
  });
  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetId = report.datasetVersionId;
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date() })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));

  // Real codes from the pinned snapshot — never invented, because the whole
  // point is that a code resolves to a unit the dataset can name.
  const provinces = await rows<{ code: string }>(sql`
    select code from administrative_units
    where dataset_version_id = ${datasetId} and level = 'PROVINCE'
      and status = 'ACTIVE' and effective_to is null
    order by code limit 2`);
  provinceA = provinces[0]!.code;
  provinceB = provinces[1]!.code;

  const communesA = await rows<{ code: string }>(sql`
    select code from administrative_units
    where dataset_version_id = ${datasetId} and level = 'COMMUNE'
      and status = 'ACTIVE' and effective_to is null and parent_code = ${provinceA}
    order by code limit 2`);
  communeA1 = communesA[0]!.code;
  communeA2 = communesA[1]!.code;

  const [communeB] = await rows<{ code: string }>(sql`
    select code from administrative_units
    where dataset_version_id = ${datasetId} and level = 'COMMUNE'
      and status = 'ACTIVE' and effective_to is null and parent_code = ${provinceB}
    order by code limit 1`);
  communeB1 = communeB!.code;

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db
    .insert(schema.adminUsers)
    .values({
      email: 'adm018-editor@gogo.local',
      passwordHash,
      displayName: 'editor',
      role: 'editor',
    })
    .returning();
  const login = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email: 'adm018-editor@gogo.local', password: 'admin-password-123' },
  });
  token = login.json().accessToken as string;
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table places cascade`);
});

describe('counting places by province and commune', () => {
  it('counts a province as the sum of its communes, and names both', async () => {
    await grouped(provinceA, communeA1);
    await grouped(provinceA, communeA1);
    await grouped(provinceA, communeA2);
    await grouped(provinceB, communeB1);

    const provinces = await summary();
    expect(provinces.level).toBe('province');
    expect(provinces.datasetVersion).toBe(datasetVersion);
    const a = provinces.units.find((u) => u.code === provinceA)!;
    const b = provinces.units.find((u) => u.code === provinceB)!;
    expect(a.placeCount).toBe(3);
    expect(b.placeCount).toBe(1);
    // A code with no name would be a row an editor cannot read.
    expect(a.name).toBeTruthy();

    const communes = await summary(`?provinceCode=${provinceA}`);
    expect(communes.level).toBe('commune');
    expect(communes.province).toMatchObject({ code: provinceA });
    expect(communes.units.find((u) => u.code === communeA1)!.placeCount).toBe(2);
    expect(communes.units.find((u) => u.code === communeA2)!.placeCount).toBe(1);
    // The whole invariant in one line: a province is its communes, no more.
    expect(communes.units.reduce((n, u) => n + u.placeCount, 0)).toBe(a.placeCount);
    // A commune from the other province cannot appear under this one.
    expect(communes.units.map((u) => u.code)).not.toContain(communeB1);
  });

  it('returns exactly the places it counted', async () => {
    const one = await grouped(provinceA, communeA1);
    const two = await grouped(provinceA, communeA1);
    await grouped(provinceA, communeA2);

    const filtered = await list(
      `?provinceCode=${provinceA}&communeCode=${communeA1}&administrativeState=grouped`,
    );
    expect(filtered.items.map((p) => p.id).sort()).toEqual([one.id, two.id].sort());

    const province = await list(`?provinceCode=${provinceA}&administrativeState=grouped`);
    expect(province.items).toHaveLength(3);
  });

  it('carries the codes and their names on every row, not just on the detail', async () => {
    const row = await grouped(provinceA, communeA1);

    const items = (await list(`?provinceCode=${provinceA}`)).items as unknown as {
      id: string;
      provinceCode: string;
      provinceName: string;
      communeCode: string;
      communeName: string;
      administrativeMappingStatus: string;
    }[];
    const found = items.find((p) => p.id === row.id)!;
    expect(found).toMatchObject({
      provinceCode: provinceA,
      communeCode: communeA1,
      administrativeMappingStatus: 'AUTO_MATCHED',
    });
    expect(found.provinceName).toBeTruthy();
    expect(found.communeName).toBeTruthy();
  });
});

describe('what may enter the hierarchy, and what may not', () => {
  it('groups AUTO_MATCHED and VERIFIED, and separates every other status', async () => {
    await grouped(provinceA, communeA1);
    await grouped(provinceA, communeA1, { administrativeMappingStatus: 'VERIFIED' });
    for (const status of ['NEEDS_REVIEW', 'REJECTED', 'STALE'] as const) {
      await place({
        provinceCode: provinceA,
        communeCode: communeA1,
        administrativeMappingStatus: status,
      });
    }
    // UNMAPPED carries no dataset version — the schema check refuses one.
    await place({ administrativeMappingStatus: 'UNMAPPED', administrativeDatasetVersion: null });

    const provinces = await summary();
    expect(provinces.totals).toMatchObject({ grouped: 2, review: 4 });
    expect(provinces.units.find((u) => u.code === provinceA)).toMatchObject({
      placeCount: 2,
      // The three attributable ones. UNMAPPED has no province to file under.
      reviewCount: 3,
    });
    expect(provinces.review.byStatus).toMatchObject({
      NEEDS_REVIEW: 1,
      REJECTED: 1,
      STALE: 1,
      UNMAPPED: 1,
      INVALID_HIERARCHY: 0,
    });

    // Both halves are real list queries, which is what makes them checkable.
    expect((await list('?administrativeState=grouped')).items).toHaveLength(2);
    expect((await list('?administrativeState=review')).items).toHaveLength(4);
  });

  it('refuses to group a mapping whose commune does not sit under its province', async () => {
    // AUTO_MATCHED, both codes real, and they do not belong together. The
    // status alone says the mapping is fine; the hierarchy says it is not.
    await place({
      provinceCode: provinceA,
      communeCode: communeB1,
      administrativeMappingStatus: 'AUTO_MATCHED',
    });

    const provinces = await summary();
    expect(provinces.totals).toMatchObject({ grouped: 0, review: 1 });
    expect(provinces.review.byStatus.INVALID_HIERARCHY).toBe(1);
    // Reported under the province it does store, which is a real current unit —
    // but never as a place anyone can find under a commune.
    expect(provinces.units.find((u) => u.code === provinceA)).toMatchObject({
      placeCount: 0,
      reviewCount: 1,
    });
  });

  it('refuses to group half an address', async () => {
    await place({ provinceCode: provinceA, administrativeMappingStatus: 'AUTO_MATCHED' });
    await place({ communeCode: communeA1, administrativeMappingStatus: 'AUTO_MATCHED' });

    const provinces = await summary();
    expect(provinces.totals.grouped).toBe(0);
    expect(provinces.review.byStatus.INVALID_HIERARCHY).toBe(2);
  });

  it('never presents a district as a level', async () => {
    await grouped(provinceA, communeA1, { district: 'Quận 1', city: 'Hồ Chí Minh' });

    const provinces = await summary();
    const communes = await summary(`?provinceCode=${provinceA}`);
    // Two levels exist and no third is reachable: there is no query that
    // returns districts, and no row carries one.
    expect([provinces.level, communes.level]).toEqual(['province', 'commune']);
    expect(JSON.stringify(provinces)).not.toContain('district');
    expect(JSON.stringify(communes)).not.toContain('district');
  });

  it('follows a code or a status change without anything being rebuilt', async () => {
    const row = await grouped(provinceA, communeA1);
    expect((await summary(`?provinceCode=${provinceA}`)).units[0]!.placeCount).toBe(1);

    await db
      .update(schema.places)
      .set({ communeCode: communeA2 })
      .where(eq(schema.places.id, row.id));
    const moved = await summary(`?provinceCode=${provinceA}`);
    expect(moved.units.find((u) => u.code === communeA1)).toBeUndefined();
    expect(moved.units.find((u) => u.code === communeA2)!.placeCount).toBe(1);

    await db
      .update(schema.places)
      .set({ administrativeMappingStatus: 'REJECTED' })
      .where(eq(schema.places.id, row.id));
    expect((await summary()).totals).toMatchObject({ grouped: 0, review: 1 });
  });
});

describe('free text and legacy Area cannot move a place', () => {
  it('ignores city, district and areaKey when deciding where a place belongs', async () => {
    // Everything free-text points at province B; the codes say province A.
    await grouped(provinceA, communeA1, {
      city: 'Hà Nội',
      district: 'Ba Đình',
      areaKey: 'hanoi_center',
      addressText: '1 Phố Nhà Thờ, Hoàn Kiếm, Hà Nội',
    });

    const provinces = await summary();
    expect(provinces.units.find((u) => u.code === provinceA)!.placeCount).toBe(1);
    expect(provinces.units.find((u) => u.code === provinceB)).toBeUndefined();
  });

  it('keeps areaKey stored and usable as its own filter, not as an address level', async () => {
    const row = await grouped(provinceA, communeA1, { areaKey: 'hcm_q1' });

    // Still there, still filterable — this task deletes and migrates nothing.
    const [stored] = await db.select().from(schema.places).where(eq(schema.places.id, row.id));
    expect(stored!.areaKey).toBe('hcm_q1');
    expect((await list('?areaKey=hcm_q1')).items).toHaveLength(1);

    // And it narrows the hierarchy the same way it narrows the list, because
    // both read the same predicates.
    expect((await summary('?areaKey=hcm_q1')).totals.grouped).toBe(1);
    expect((await summary('?areaKey=nowhere')).totals.grouped).toBe(0);
  });
});

describe('archived places', () => {
  it('leaves archived out of the list and the counts by default', async () => {
    await grouped(provinceA, communeA1);
    await grouped(provinceA, communeA1, { status: 'archived' });

    expect((await list()).items).toHaveLength(1);
    const provinces = await summary();
    expect(provinces.units.find((u) => u.code === provinceA)!.placeCount).toBe(1);
    expect(provinces.totals).toMatchObject({ grouped: 1, review: 0 });
  });

  it('counts them, and lists them, when they are asked for by name', async () => {
    await grouped(provinceA, communeA1);
    await grouped(provinceA, communeA1, { status: 'archived' });
    await grouped(provinceA, communeA2, { status: 'archived' });

    expect((await list('?status=archived')).items).toHaveLength(2);
    const archived = await summary('?status=archived');
    expect(archived.units.find((u) => u.code === provinceA)!.placeCount).toBe(2);
    // The same filter on both sides, and the same answer.
    expect(archived.totals.grouped).toBe(
      (await list('?status=archived&administrativeState=grouped')).items.length,
    );
  });
});

describe('filters apply to the counts exactly as they do to the list', () => {
  it('narrows both by status and by name', async () => {
    await grouped(provinceA, communeA1, { name: 'Cà Phê Sáng', nameNormalized: 'ca phe sang' });
    await grouped(provinceA, communeA1, {
      name: 'Cà Phê Tối',
      nameNormalized: 'ca phe toi',
      status: 'published',
    });
    await grouped(provinceA, communeA2, { name: 'Bún Bò', nameNormalized: 'bun bo' });

    expect((await summary('?status=published')).totals.grouped).toBe(1);
    expect((await list('?status=published')).items).toHaveLength(1);

    // Accent-insensitive, the same normalization the list search uses.
    const q = '?q=ca%20phe';
    expect((await summary(q)).totals.grouped).toBe(2);
    expect((await list(q)).items).toHaveLength(2);
  });
});

describe('a filter that cannot be answered honestly', () => {
  it('refuses a commune that does not belong to the province sent with it', async () => {
    const res = await get(`/v1/cms/places?provinceCode=${provinceA}&communeCode=${communeB1}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors.map((e: { field: string }) => e.field)).toContain('communeCode');
  });

  it('refuses a commune with no province to check it against', async () => {
    const res = await get(`/v1/cms/places?communeCode=${communeA1}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors.map((e: { field: string }) => e.field)).toContain(
      'provinceCode',
    );
  });

  it('says a province does not exist rather than saying it is empty', async () => {
    const res = await get('/v1/cms/places/administrative-summary?provinceCode=99999');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ADMINISTRATIVE_UNIT_NOT_CURRENT');
  });
});

describe('nothing is truncated', () => {
  it('returns every unit that holds a place, past any page size', async () => {
    const communes = await rows<{ code: string }>(sql`
      select code from administrative_units
      where dataset_version_id = ${datasetId} and level = 'COMMUNE'
        and status = 'ACTIVE' and effective_to is null and parent_code = ${provinceA}
      order by code limit 60`);
    expect(communes.length).toBeGreaterThan(50);
    for (const commune of communes) await grouped(provinceA, commune.code);

    const level = await summary(`?provinceCode=${provinceA}`);
    // The list endpoint pages at 50; the hierarchy is not the list, and a
    // commune dropped off the end would be a unit an editor could never reach.
    expect(level.units).toHaveLength(communes.length);
    expect(level.units.reduce((n, u) => n + u.placeCount, 0)).toBe(communes.length);
    expect((await summary()).units.find((u) => u.code === provinceA)!.placeCount).toBe(
      communes.length,
    );
  });
});
