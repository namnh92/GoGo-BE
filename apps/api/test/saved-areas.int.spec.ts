import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { AdministrativeBoundaryImportService, AdministrativeImportService } from '@gogo/modules';

/**
 * ADM-022 (#569) — area facts on saved places and plans (verified mapping in
 * the published dataset; a plan by all of its stops), and locating a position
 * against the published boundaries without guessing.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

let datasetId: string;
let datasetVersion: string;
let provinceA: string;
let communeA: string;
let siblingCommune: string;
let provinceB: string;
let communeB: string;
let inside: { lat: number; lng: number };
const place: Record<string, string> = {};
const plan: Record<string, string> = {};

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.62.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

type Area = {
  scope: string;
  datasetVersion: string | null;
  provinceCode: string | null;
  provinceName: string | null;
  communeCode: string | null;
  communeName: string | null;
};

async function insertPlace(
  name: string,
  mapping: { provinceCode?: string; communeCode?: string; version?: string; status: string },
) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: 'set-by-trigger',
      status: 'published',
      geom: { x: 106.7, y: 10.776 },
      confidence: '0.9',
      provinceCode: mapping.provinceCode ?? null,
      communeCode: mapping.communeCode ?? null,
      administrativeDatasetVersion: mapping.version ?? null,
      administrativeMappingStatus: mapping.status as 'VERIFIED',
    })
    .returning();
  return row!.id;
}

let roomCounter = 0;
let hostId: string;

/** One room per plan: a room holds a single current plan (plans_room_current_unique). */
async function insertPlan(stops: string[]) {
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: `SAVEDAREAS${++roomCounter}`,
      type: 'group',
      decisionMode: 'vote',
      hostUserId: hostId,
    })
    .returning();
  const [row] = await db
    .insert(schema.plans)
    .values({
      roomId: room!.id,
      version: 1,
      status: 'current',
      totals: {} as typeof schema.plans.$inferInsert.totals,
      constraintVersion: 1,
    })
    .returning();
  await db.insert(schema.planStops).values(
    stops.map((placeId, position) => ({
      planId: row!.id,
      placeId,
      position,
      durationMinutes: 60,
    })),
  );
  return row!.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_saved_areas_test')
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
  datasetId = report.datasetVersionId;
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: 'fixture-v1' })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));

  // A commune polygon claimed by no other commune at an interior point, whose
  // unit is current and agrees with the polygon's province.
  const found = await db.execute(sql`
    select b.code, b.parent_code,
      st_y(st_pointonsurface(b.geom)) as lat, st_x(st_pointonsurface(b.geom)) as lng
    from administrative_unit_boundaries b
    join administrative_units u on u.code = b.code and u.level = 'COMMUNE'
      and u.dataset_version_id = ${datasetId} and u.status = 'ACTIVE'
      and u.effective_to is null and u.parent_code = b.parent_code
    where b.boundary_version = 'fixture-v1' and b.level = 'COMMUNE'
      and (select count(*) from administrative_unit_boundaries o
           where o.boundary_version = b.boundary_version and o.level = 'COMMUNE'
             and st_intersects(o.geom, st_pointonsurface(b.geom))) = 1
    order by b.code
    limit 1
  `);
  const row = (found.rows as { code: string; parent_code: string; lat: number; lng: number }[])[0]!;
  communeA = row.code;
  provinceA = row.parent_code;
  inside = { lat: Number(row.lat), lng: Number(row.lng) };

  const current = and(
    eq(schema.administrativeUnits.datasetVersionId, datasetId),
    eq(schema.administrativeUnits.level, 'COMMUNE'),
    eq(schema.administrativeUnits.status, 'ACTIVE'),
    isNull(schema.administrativeUnits.effectiveTo),
  );
  const [sibling] = await db
    .select()
    .from(schema.administrativeUnits)
    .where(
      and(
        current,
        eq(schema.administrativeUnits.parentCode, provinceA),
        ne(schema.administrativeUnits.code, communeA),
      ),
    )
    .limit(1);
  siblingCommune = sibling!.code;
  const [elsewhere] = await db
    .select()
    .from(schema.administrativeUnits)
    .where(and(current, ne(schema.administrativeUnits.parentCode, provinceA)))
    .limit(1);
  communeB = elsewhere!.code;
  provinceB = elsewhere!.parentCode!;

  const verified = (provinceCode: string, communeCode: string) => ({
    provinceCode,
    communeCode,
    version: datasetVersion,
    status: 'VERIFIED',
  });
  place.a = await insertPlace('Xã A một', verified(provinceA, communeA));
  place.a2 = await insertPlace('Xã A hai', verified(provinceA, communeA));
  place.sibling = await insertPlace('Xã bên cạnh', verified(provinceA, siblingCommune));
  place.other = await insertPlace('Tỉnh khác', verified(provinceB, communeB));
  place.auto = await insertPlace('Chỉ tự khớp', {
    ...verified(provinceA, communeA),
    status: 'AUTO_MATCHED',
  });
  place.stale = await insertPlace('Bộ dữ liệu cũ', {
    ...verified(provinceA, communeA),
    version: 'old',
  });
  place.unmapped = await insertPlace('Chưa ánh xạ', { status: 'UNMAPPED' });

  const [host] = await db
    .insert(schema.users)
    .values({ displayName: 'Host', email: 'saved-areas-host@gogo.id.vn' })
    .returning();
  hostId = host!.id;
  plan.commune = await insertPlan([place.a!, place.a2!]);
  plan.province = await insertPlan([place.a!, place.sibling!]);
  plan.multi = await insertPlan([place.a!, place.other!]);
  plan.partlyUnmapped = await insertPlan([place.a!, place.unmapped!]);
  plan.autoStop = await insertPlan([place.a!, place.auto!]);

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

async function signIn(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'Saver' },
  });
  return res.json().accessToken as string;
}

async function save(token: string, type: 'place' | 'plan', id: string) {
  const res = await api().inject({
    method: 'PUT',
    url: `/v1/me/saved/${type}/${id}`,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  expect(res.statusCode).toBe(200);
}

async function savedAreas(token: string) {
  const res = await api().inject({
    method: 'GET',
    url: '/v1/me/saved',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const items = res.json() as {
    targetType: string;
    targetId: string;
    savedAt: string;
    area: Area;
  }[];
  return { items, byId: new Map(items.map((i) => [i.targetId, i.area])) };
}

describe('ADM-022 saved areas', () => {
  it('reports a saved place only by a verified mapping in the published dataset', async () => {
    const token = await signIn('saved-places@gogo.test');
    for (const key of ['a', 'other', 'auto', 'stale', 'unmapped'])
      await save(token, 'place', place[key]!);
    const { byId } = await savedAreas(token);
    expect(byId.get(place.a!)).toMatchObject({
      scope: 'commune',
      datasetVersion,
      provinceCode: provinceA,
      communeCode: communeA,
    });
    expect(byId.get(place.a!)!.provinceName!.length).toBeGreaterThan(0);
    expect(byId.get(place.a!)!.communeName!.length).toBeGreaterThan(0);
    expect(byId.get(place.other!)).toMatchObject({
      scope: 'commune',
      provinceCode: provinceB,
      communeCode: communeB,
    });
    for (const key of ['auto', 'stale', 'unmapped']) {
      expect(byId.get(place[key]!)).toEqual({
        scope: 'unknown',
        datasetVersion: null,
        provinceCode: null,
        provinceName: null,
        communeCode: null,
        communeName: null,
      });
    }
  });

  it('places a saved plan by all of its stops, never by the first', async () => {
    const token = await signIn('saved-plans@gogo.test');
    for (const key of Object.keys(plan)) await save(token, 'plan', plan[key]!);
    const gone = randomUUID();
    await save(token, 'plan', gone);
    const { items, byId } = await savedAreas(token);
    expect(items).toHaveLength(Object.keys(plan).length + 1);
    expect(byId.get(plan.commune!)).toMatchObject({
      scope: 'commune',
      provinceCode: provinceA,
      communeCode: communeA,
    });
    expect(byId.get(plan.province!)).toMatchObject({
      scope: 'province',
      provinceCode: provinceA,
      communeCode: null,
      communeName: null,
    });
    expect(byId.get(plan.multi!)).toMatchObject({
      scope: 'multiple_provinces',
      datasetVersion,
      provinceCode: null,
      communeCode: null,
    });
    for (const id of [plan.partlyUnmapped!, plan.autoStop!, gone])
      expect(byId.get(id)!.scope).toBe('unknown');
    const times = items.map((i) => Date.parse(i.savedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('locates a position inside a commune and refuses to guess outside every polygon', async () => {
    const hit = await api().inject({
      method: 'GET',
      url: `/v1/administrative/locate?lat=${inside.lat}&lng=${inside.lng}`,
      remoteAddress: ip(),
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['cache-control']).toBe('private, no-store');
    expect(hit.json().datasetVersion).toBe(datasetVersion);
    expect(hit.json().area).toMatchObject({
      scope: 'commune',
      provinceCode: provinceA,
      communeCode: communeA,
    });
    expect(hit.json().area.communeName.length).toBeGreaterThan(0);

    const sea = await api().inject({
      method: 'GET',
      url: '/v1/administrative/locate?lat=22.0&lng=117.5',
      remoteAddress: ip(),
    });
    expect(sea.statusCode).toBe(200);
    expect(sea.json().area).toEqual({
      scope: 'unknown',
      provinceCode: null,
      provinceName: null,
      communeCode: null,
      communeName: null,
    });

    for (const qs of ['lat=200&lng=106', 'lat=10.7']) {
      const bad = await api().inject({
        method: 'GET',
        url: `/v1/administrative/locate?${qs}`,
        remoteAddress: ip(),
      });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('says unknown for every saved item while no dataset is published', async () => {
    const token = await signIn('saved-unpublished@gogo.test');
    await save(token, 'place', place.a!);
    await save(token, 'plan', plan.commune!);
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'STAGED' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    try {
      const { items } = await savedAreas(token);
      expect(items.map((i) => i.area.scope)).toEqual(['unknown', 'unknown']);
    } finally {
      await db
        .update(schema.administrativeDatasetVersions)
        .set({ status: 'PUBLISHED' })
        .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    }
  });
});
