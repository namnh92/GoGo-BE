import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import { AdministrativeBoundaryImportService, AdministrativeImportService } from '@gogo/modules';

/**
 * ADM-016 (#496) — the place create and edit forms, carrying canonical codes.
 *
 * Everything here goes through the real HTTP endpoints. The point of the task
 * is that an editor can now express a Vietnamese address in the only form that
 * survives the 2025-07-01 reorganisation — a province and a commune, as codes —
 * and that doing so cannot become a way around moderation. A test that called
 * the service directly would prove neither.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let datasetId: string;
let datasetVersion: string;

const BOUNDARY_VERSION = 'fixture-v5.0.0';
const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.61.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const tokens: Record<string, string> = {};
const adminIds: Record<string, string> = {};

type Role = 'editor' | 'moderator';

/** Codes discovered from the fixture and the pinned dataset, never assumed. */
let mapped: { communeCode: string; provinceCode: string };
/** A second commune the fixture actually draws, for a real contradiction. */
let neighbour: { communeCode: string; provinceCode: string };
let otherProvince: string;
let historicalCommune: string;
let inside: { lng: number; lat: number };
let neighbourInside: { lng: number; lat: number };
let outside: { lng: number; lat: number };

const get = (url: string, role: Role) =>
  api().inject({
    method: 'GET',
    url,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${tokens[role]}` },
  });

function send(
  method: 'POST' | 'PATCH',
  url: string,
  role: Role,
  payload: Record<string, unknown> = {},
) {
  return api().inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${tokens[role]}` },
    payload,
  });
}

async function createAdmin(role: Role) {
  const email = `adm016-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: role, role })
    .returning();
  adminIds[role] = row!.id;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

async function placeRow(id: string) {
  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  return row!;
}

/** A create body that always validates, with whatever the test wants on top. */
function createBody(over: Record<string, unknown> = {}) {
  return {
    name: `Quán ${Math.random().toString(36).slice(2, 8)}`,
    lat: inside.lat,
    lng: inside.lng,
    ...over,
  };
}

async function createPlace(over: Record<string, unknown> = {}) {
  const res = await send('POST', '/v1/cms/places', 'editor', createBody(over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; administrative: Record<string, unknown> };
}

/** A moderator's verification, which is the only thing that permits publishing. */
async function verifyMapping(
  placeId: string,
  codes: { provinceCode: string; communeCode: string },
) {
  const place = await placeRow(placeId);
  const res = await send(
    'POST',
    `/v1/cms/places/${placeId}/administrative-mapping/verify`,
    'moderator',
    { ...codes, expectedUpdatedAt: place.updatedAt.toISOString() },
  );
  expect(res.statusCode, res.body).toBe(201);
  return placeRow(placeId);
}

async function auditRows(action: string, placeId: string) {
  return db
    .select()
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.resourceId, placeId)));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_place_administrative_test')
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
  // the boundaries go in first.
  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    archivePath: FIXTURE,
  });
  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetId = report.datasetVersionId;
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: BOUNDARY_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));
  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: BOUNDARY_VERSION,
    archivePath: FIXTURE,
  });

  // Two communes the fixture actually draws, and a point safely inside each.
  const drawn = await rows<{ code: string; parent_code: string; lng: number; lat: number }>(sql`
    select b.code, b.parent_code,
           st_x(st_pointonsurface(b.geom)) as lng, st_y(st_pointonsurface(b.geom)) as lat
    from administrative_unit_boundaries b
    where b.boundary_version = ${BOUNDARY_VERSION} and b.level = 'COMMUNE'
    order by b.code limit 2`);
  mapped = { communeCode: drawn[0]!.code, provinceCode: drawn[0]!.parent_code };
  inside = { lng: Number(drawn[0]!.lng), lat: Number(drawn[0]!.lat) };
  // The contradiction has to be a *different commune the geometry actually
  // says*. Sending different codes is not one: they disagree with the pin in
  // the same request, and disagreement is `NEEDS_REVIEW` — which is the
  // resolver saying it cannot tell, not evidence that the reviewer was wrong.
  neighbour = { communeCode: drawn[1]!.code, provinceCode: drawn[1]!.parent_code };
  neighbourInside = { lng: Number(drawn[1]!.lng), lat: Number(drawn[1]!.lat) };

  // Inside Vietnam's bounding box, inside no polygon this fixture carries. The
  // resolver must call that UNMAPPED, not invalid.
  outside = { lng: 108.5, lat: 12.0 };

  const [other] = await rows<{ code: string }>(sql`
    select code from administrative_units
    where dataset_version_id = ${datasetId} and level = 'PROVINCE'
      and status = 'ACTIVE' and effective_to is null and code <> ${mapped.provinceCode}
    order by code limit 1`);
  otherProvince = other!.code;

  const [historical] = await rows<{ code: string }>(sql`
    select u.code from administrative_units u
    where u.dataset_version_id = ${datasetId} and u.level = 'COMMUNE'
      and u.effective_to is not null
      and not exists (
        select 1 from administrative_units c
        where c.dataset_version_id = u.dataset_version_id and c.code = u.code
          and c.status = 'ACTIVE' and c.effective_to is null)
    order by u.code limit 1`);
  historicalCommune = historical!.code;

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  for (const role of ['editor', 'moderator'] as const) await createAdmin(role);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table places cascade`);
  await db.execute(sql`delete from audit_logs`);
});

describe('creating a place with canonical codes', () => {
  it('stores both levels and says which dataset they were checked against', async () => {
    const created = await createPlace({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
    });

    const row = await placeRow(created.id);
    expect(row).toMatchObject({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeDatasetVersion: datasetVersion,
    });
    // The codes are evidence, not an instruction: they agree with the geometry
    // the same request supplied, which is why this is a definitional answer.
    expect(row.administrativeMappingSource).toBe('trusted_code');
    expect(row.administrativeMappingConfidence).toBe('1.00');
  });

  it('resolves from geometry alone when the editor chose no unit', async () => {
    // A place typed in by hand used to be invisible to the mapping queue.
    const created = await createPlace();
    expect(await placeRow(created.id)).toMatchObject({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'boundary_point_in_polygon',
    });
  });

  it('leaves a place UNMAPPED when nothing can place it, rather than guessing', async () => {
    const res = await send(
      'POST',
      '/v1/cms/places',
      'editor',
      createBody({ lat: outside.lat, lng: outside.lng }),
    );
    expect(res.statusCode).toBe(201);
    expect(await placeRow(res.json().id as string)).toMatchObject({
      administrativeMappingStatus: 'UNMAPPED',
      provinceCode: null,
      communeCode: null,
      administrativeDatasetVersion: null,
    });
  });

  it('never publishes what it just matched — AUTO_MATCHED is not a verification', async () => {
    const created = await createPlace({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
    });
    expect((await placeRow(created.id)).status).toBe('draft');
    expect(created.administrative).toMatchObject({
      status: 'AUTO_MATCHED',
      approvalBlock: { code: 'MAPPING_NOT_VERIFIED' },
    });
  });

  it.each([
    [
      'a province with no commune',
      () => ({ provinceCode: mapped.provinceCode }),
      'ADMINISTRATIVE_CODES_INCOMPLETE',
    ],
    [
      'a commune with no province',
      () => ({ communeCode: mapped.communeCode }),
      'ADMINISTRATIVE_CODES_INCOMPLETE',
    ],
    [
      'a province the dataset does not carry',
      () => ({ provinceCode: '99', communeCode: mapped.communeCode }),
      'PROVINCE_NOT_CURRENT',
    ],
    [
      'a commune that is no longer current',
      () => ({ provinceCode: mapped.provinceCode, communeCode: historicalCommune }),
      'COMMUNE_NOT_CURRENT',
    ],
    [
      'a commune from another province',
      () => ({ provinceCode: otherProvince, communeCode: mapped.communeCode }),
      'HIERARCHY_INVALID',
    ],
  ])('refuses %s', async (_label, body, code) => {
    const res = await send('POST', '/v1/cms/places', 'editor', createBody(body()));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(code);
    // The error points at the box the editor has to fix, not at a toast.
    expect(res.json().field_errors?.[0]?.field).toMatch(/provinceCode|communeCode/);
  });

  it('creates no place at all when the codes are refused', async () => {
    const before = await rows<{ n: number }>(sql`select count(*)::int as n from places`);
    await send(
      'POST',
      '/v1/cms/places',
      'editor',
      createBody({ provinceCode: otherProvince, communeCode: mapped.communeCode }),
    );
    const after = await rows<{ n: number }>(sql`select count(*)::int as n from places`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('keeps legacy free text without ever letting it choose a code', async () => {
    const created = await createPlace({
      city: 'Thành phố Hồ Chí Minh',
      district: 'Quận 1',
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
    });
    const row = await placeRow(created.id);
    // Stored exactly as written — and beaten, as evidence, by the code and the
    // geometry that agree with each other.
    expect(row.city).toBe('Thành phố Hồ Chí Minh');
    expect(row.district).toBe('Quận 1');
    expect(row.provinceCode).toBe(mapped.provinceCode);
    expect(row.communeCode).toBe(mapped.communeCode);
  });
});

describe('the place detail an editor loads', () => {
  it('carries both levels with their names, the versions and the blocker', async () => {
    const created = await createPlace({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
    });
    const detail = (await get(`/v1/cms/places/${created.id}`, 'editor')).json();

    expect(detail.administrative).toMatchObject({
      status: 'AUTO_MATCHED',
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      datasetVersion,
      activeDatasetVersion: datasetVersion,
      approvalBlock: { code: 'MAPPING_NOT_VERIFIED' },
    });
    // Names, not just codes: a bare code is not something an editor can check.
    expect(detail.administrative.provinceName).toBeTruthy();
    expect(detail.administrative.communeName).toBeTruthy();
  });

  it('says nothing is blocking once a moderator has verified the mapping', async () => {
    const created = await createPlace();
    await verifyMapping(created.id, mapped);
    const detail = (await get(`/v1/cms/places/${created.id}`, 'editor')).json();
    expect(detail.administrative).toMatchObject({
      status: 'VERIFIED',
      method: 'editor',
      approvalBlock: null,
    });
  });

  it('explains an unmapped place rather than showing an empty pair', async () => {
    const res = await send(
      'POST',
      '/v1/cms/places',
      'editor',
      createBody({ lat: outside.lat, lng: outside.lng }),
    );
    const detail = (await get(`/v1/cms/places/${res.json().id}`, 'editor')).json();
    expect(detail.administrative).toMatchObject({
      status: 'UNMAPPED',
      provinceCode: null,
      provinceName: null,
      approvalBlock: { code: 'MAPPING_UNMAPPED' },
    });
  });
});

describe('editing a place that already has a mapping', () => {
  it('does not re-resolve an edit that touched nothing the resolver reads', async () => {
    const created = await createPlace();
    const before = await placeRow(created.id);

    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      phone: '0283 822 9999',
    });
    expect(res.statusCode).toBe(200);

    const after = await placeRow(created.id);
    expect(after.administrativeMappedAt).toEqual(before.administrativeMappedAt);
    // One audit row, from the create. A phone number must not buy a
    // point-in-polygon query, and must not look like a mapping decision.
    expect(await auditRows('administrative_mapping.resolve', created.id)).toHaveLength(1);
  });

  it('re-resolves when the pin moves', async () => {
    const created = await createPlace();
    expect((await placeRow(created.id)).communeCode).toBe(mapped.communeCode);

    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      lat: outside.lat,
      lng: outside.lng,
    });
    expect(res.statusCode).toBe(200);

    // The evidence disappeared with the geometry, so the machine takes its own
    // answer back rather than leaving a code that is no longer supported.
    expect(await placeRow(created.id)).toMatchObject({
      administrativeMappingStatus: 'UNMAPPED',
      provinceCode: null,
      communeCode: null,
    });
  });

  it('re-resolves when the editor changes the pair', async () => {
    const created = await createPlace({ lat: outside.lat, lng: outside.lng });
    expect((await placeRow(created.id)).administrativeMappingStatus).toBe('UNMAPPED');

    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
    });
    expect(res.statusCode).toBe(200);
    expect(await placeRow(created.id)).toMatchObject({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'trusted_code',
    });
  });

  it('refuses a cross-province pair on edit, and writes nothing', async () => {
    const created = await createPlace();
    const before = await placeRow(created.id);

    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      name: 'Tên mới',
      provinceCode: otherProvince,
      communeCode: mapped.communeCode,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HIERARCHY_INVALID');

    // The whole save is one transaction: a refused pair does not leave a
    // renamed place behind.
    expect((await placeRow(created.id)).name).toBe(before.name);
  });
});

describe('an edit is not a moderation decision', () => {
  it('marks a contradicted VERIFIED mapping STALE, keeping its codes and reviewer', async () => {
    const created = await createPlace();
    await verifyMapping(created.id, mapped);

    // The pin moves into a commune the boundaries really do claim, so the
    // resolver has a definite answer that is not the verified one.
    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      lat: neighbourInside.lat,
      lng: neighbourInside.lng,
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await placeRow(created.id);
    expect(row).toMatchObject({
      administrativeMappingStatus: 'STALE',
      // Not re-pointed: choosing the new commune is a person's job.
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      administrativeMappingSource: 'editor',
      // The verification happened. It is the place that moved.
      administrativeMappedBy: adminIds.moderator,
    });

    const detail = (await get(`/v1/cms/places/${created.id}`, 'editor')).json();
    expect(detail.administrative.approvalBlock.code).toBe('MAPPING_STALE');
  });

  it('does not demote a VERIFIED mapping on codes that merely disagree with the pin', async () => {
    const created = await createPlace();
    await verifyMapping(created.id, mapped);

    // An editor typing codes that contradict the place's own geometry produces
    // a disagreement, and a disagreement is the resolver saying it cannot tell.
    // Demoting a person's decision on "I cannot tell" is how a catalogue
    // empties itself every time a release loses a polygon.
    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      provinceCode: neighbour.provinceCode,
      communeCode: neighbour.communeCode,
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await placeRow(created.id);
    expect(row.administrativeMappingStatus).toBe('VERIFIED');
    expect(row.communeCode).toBe(mapped.communeCode);
    expect(row.administrativeMappedBy).toBe(adminIds.moderator);
  });

  it('leaves a VERIFIED mapping alone when the edit does not contradict it', async () => {
    const created = await createPlace();
    await verifyMapping(created.id, mapped);

    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
    });
    expect(res.statusCode).toBe(200);
    expect(await placeRow(created.id)).toMatchObject({
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappedBy: adminIds.moderator,
    });
  });

  it('leaves a VERIFIED mapping alone when the edit produces no evidence either way', async () => {
    const created = await createPlace();
    await verifyMapping(created.id, mapped);

    // The pin moves somewhere no polygon claims. "I cannot tell" is not a
    // contradiction, and demoting on it would empty the verified catalogue
    // every time a release lost a polygon.
    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      lat: outside.lat,
      lng: outside.lng,
    });
    expect(res.statusCode).toBe(200);
    expect((await placeRow(created.id)).administrativeMappingStatus).toBe('VERIFIED');
  });

  it('never touches a REJECTED mapping — an edit is not an appeal', async () => {
    const created = await createPlace();
    const place = await placeRow(created.id);
    const rejected = await send(
      'POST',
      `/v1/cms/places/${created.id}/administrative-mapping/reject`,
      'moderator',
      { reason: 'sai xã', expectedUpdatedAt: place.updatedAt.toISOString() },
    );
    expect(rejected.statusCode).toBe(201);
    const before = await placeRow(created.id);

    const res = await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      lat: outside.lat,
      lng: outside.lng,
    });
    expect(res.statusCode).toBe(200);

    const after = await placeRow(created.id);
    expect(after.administrativeMappingStatus).toBe('REJECTED');
    expect(after.provinceCode).toBe(before.provinceCode);
    expect(after.communeCode).toBe(before.communeCode);
    expect(after.administrativeMappedBy).toBe(adminIds.moderator);
  });
});

describe('the create and edit paths ask nobody', () => {
  it('issues no Google request and no Redis command to map a place', async () => {
    // ADR-0019 §10 / GoGo-BE#464: the codes are GoGo facts precisely because no
    // provider is asked. ADR-0019 §8: administrative data is not in Upstash.
    const google = await metricCount('places_provider_requests_total');
    const redis = await metricCount('provider_requests_total', 'upstash');

    const created = await createPlace({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      city: 'Hà Nội',
      district: 'Ba Đình',
    });
    await send('PATCH', `/v1/cms/places/${created.id}`, 'editor', {
      lat: outside.lat,
      lng: outside.lng,
    });
    await get(`/v1/cms/places/${created.id}`, 'editor');

    expect(await metricCount('places_provider_requests_total')).toBe(google);
    expect(await metricCount('provider_requests_total', 'upstash')).toBe(redis);
  });
});

async function metricCount(metric: string, contains?: string): Promise<number> {
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
    .reduce((total, line) => total + Number(line.split(' ').pop() ?? 0), 0);
}
