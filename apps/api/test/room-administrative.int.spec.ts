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
 * ADM-020 (#567) — a room's canonical area: validated on write, kept on
 * omission and on an echoed read, cleared on null, readable after the dataset
 * moves on, and a hard scope for candidate retrieval within the same dataset.
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
const placeIds: Record<string, string> = {};

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.61.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
type Body = Record<string, unknown>;

const budget = { budgetMode: 'per_person', budgetAmount: 300_000, currency: 'VND' };

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: email.split('@')[0] },
  });
  return res.json().accessToken as string;
}

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  token: string,
  url: string,
  payload?: Body,
) {
  return api().inject({
    method,
    url,
    remoteAddress: ip(),
    headers: auth(token),
    ...(method === 'GET' ? {} : { payload: payload ?? {} }),
  });
}

async function createRoom(token: string, constraint: Body) {
  return send('POST', token, '/v1/rooms', {
    type: 'group',
    decisionMode: 'vote',
    participantCount: 4,
    constraint: { ...budget, ...constraint },
  });
}

function patchConstraints(token: string, roomId: string, body: Body) {
  return send('PATCH', token, `/v1/rooms/${roomId}/constraints`, body);
}

async function readRoom(token: string, roomId: string) {
  return (await send('GET', token, `/v1/rooms/${roomId}`)).json();
}

/** A guest joins and both members finish preferences, so the host may rank. */
async function readyToRank(hostToken: string, roomId: string) {
  const invite = await send('POST', hostToken, `/v1/rooms/${roomId}/invites`, { maxUses: 5 });
  const join = await api().inject({
    method: 'POST',
    url: '/v1/rooms/join/guest',
    remoteAddress: ip(),
    payload: { inviteCode: invite.json().code, displayName: 'Khách' },
  });
  expect(join.statusCode).toBe(201);
  const guestToken = join.json().accessToken as string;
  for (const token of [hostToken, guestToken]) {
    const saved = await send('PUT', token, `/v1/rooms/${roomId}/preferences/me`, {
      expectedVersion: 0,
      selections: { mood: ['chill'] },
    });
    expect(saved.statusCode).toBe(200);
    expect((await send('POST', token, `/v1/rooms/${roomId}/preferences/complete`)).statusCode).toBe(
      200,
    );
  }
  return guestToken;
}

async function insertPlace(
  name: string,
  mapping: {
    provinceCode?: string;
    communeCode?: string;
    datasetVersion?: string;
    status: 'VERIFIED' | 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'STALE' | 'UNMAPPED';
  },
  mood: string,
) {
  const [place] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: name.toLowerCase(),
      status: 'published',
      geom: { x: 106.7, y: 10.776 },
      rating: '4.40',
      ratingCount: 500,
      suitability: { couple: 0.9, group: 0.9 },
      avgVisitMinutes: 60,
      confidence: '0.9',
      freshnessCheckedAt: new Date(),
      provinceCode: mapping.provinceCode ?? null,
      communeCode: mapping.communeCode ?? null,
      administrativeDatasetVersion: mapping.datasetVersion ?? null,
      administrativeMappingStatus: mapping.status,
    })
    .returning();
  await db.insert(schema.placeTaxonomies).values({ placeId: place!.id, taxonomyId: mood });
  await db.insert(schema.placePrices).values({
    placeId: place!.id,
    priceMin: 50_000,
    priceMax: 90_000,
    currency: 'VND',
    unit: 'per_person',
    confidence: '0.8',
    source: 'editor',
    verifiedAt: new Date(),
  });
  for (let day = 0; day < 7; day++) {
    await db.insert(schema.placeHours).values({
      placeId: place!.id,
      dayOfWeek: day,
      openMinute: 7 * 60,
      closeMinute: 23 * 60,
      isOvernight: false,
      source: 'editor',
    });
  }
  return place!.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_room_administrative_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  await db.insert(schema.serviceAreas).values({
    key: 'hcm_q1',
    name: 'Quận 1',
    city: 'TP.HCM',
    centerLat: 10.7769,
    centerLng: 106.7009,
    radiusM: 5000,
  });
  const [mood] = await db
    .insert(schema.taxonomies)
    .values({ kind: 'mood', key: 'chill' })
    .returning();

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

  const m = mood!.id;
  placeIds.inCommune = await insertPlace(
    'Trong xã',
    { provinceCode, communeCode, datasetVersion, status: 'VERIFIED' },
    m,
  );
  placeIds.siblingCommune = await insertPlace(
    'Xã bên cạnh',
    { provinceCode, communeCode: siblingCommuneCode, datasetVersion, status: 'VERIFIED' },
    m,
  );
  placeIds.autoMatched = await insertPlace(
    'Chỉ tự khớp',
    { provinceCode, communeCode, datasetVersion, status: 'AUTO_MATCHED' },
    m,
  );
  placeIds.otherProvince = await insertPlace(
    'Tỉnh khác',
    { provinceCode: otherProvinceCode, datasetVersion, status: 'VERIFIED' },
    m,
  );
  placeIds.staleMapping = await insertPlace(
    'Mã từ bộ dữ liệu cũ',
    { provinceCode, communeCode, datasetVersion: 'previous-dataset', status: 'STALE' },
    m,
  );
  placeIds.underReview = await insertPlace(
    'Đang chờ duyệt',
    { provinceCode, communeCode, datasetVersion, status: 'NEEDS_REVIEW' },
    m,
  );
  placeIds.unmapped = await insertPlace('Chưa ánh xạ', { status: 'UNMAPPED' }, m);

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

describe('ADM-020 room administrative area', () => {
  it('creates with a commune or a whole province, labels from the server, legacy key replaced', async () => {
    const host = await register('room-area-create@gogo.test');
    const commune = await createRoom(host, {
      areaKey: 'hcm_q1',
      administrativeArea: {
        datasetVersion,
        provinceCode,
        communeCode,
        provinceName: 'Tên do client bịa',
        communeName: 'Tên do client bịa',
        status: 'current',
      },
    });
    expect(commune.statusCode).toBe(201);
    const area = commune.json().constraints.administrativeArea;
    expect(area).toMatchObject({ datasetVersion, provinceCode, communeCode, status: 'current' });
    expect(area.provinceName).not.toBe('Tên do client bịa');
    expect(area.provinceName.length).toBeGreaterThan(0);
    expect(area.communeName.length).toBeGreaterThan(0);
    expect(commune.json().constraints.areaKey).toBeUndefined();

    const province = await createRoom(host, {
      administrativeArea: { datasetVersion, provinceCode, communeCode: null },
    });
    expect(province.statusCode).toBe(201);
    expect(province.json().constraints.administrativeArea).toMatchObject({
      provinceCode,
      communeCode: null,
      communeName: null,
      status: 'current',
    });

    const legacy = await createRoom(host, { areaKey: 'hcm_q1' });
    expect(legacy.statusCode).toBe(201);
    expect(legacy.json().constraints).toMatchObject({
      administrativeArea: null,
      areaKey: 'hcm_q1',
    });
  });

  it('rejects a commune under another province, unknown codes and an unpublished dataset', async () => {
    const host = await register('room-area-invalid@gogo.test');
    for (const administrativeArea of [
      { datasetVersion, provinceCode: otherProvinceCode, communeCode },
      { datasetVersion, provinceCode: '99999', communeCode: null },
    ]) {
      expect((await createRoom(host, { administrativeArea })).statusCode).toBe(400);
    }
    const stale = await createRoom(host, {
      administrativeArea: { datasetVersion: 'not-published', provinceCode, communeCode },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('ADMINISTRATIVE_VERSION_CHANGED');

    const room = (await createRoom(host, {})).json();
    const refused = await patchConstraints(host, room.id, {
      ...budget,
      administrativeArea: { datasetVersion, provinceCode: otherProvinceCode, communeCode },
      expectedConstraintVersion: room.constraintVersion,
    });
    expect(refused.statusCode).toBe(400);
    expect((await readRoom(host, room.id)).constraintVersion).toBe(room.constraintVersion);
  });

  it('keeps the area on omission and on an echoed read, clears on null, validates a new choice', async () => {
    const host = await register('room-area-update@gogo.test');
    const created = (
      await createRoom(host, {
        administrativeArea: { datasetVersion, provinceCode, communeCode },
      })
    ).json();
    const stored = created.constraints.administrativeArea;

    const omitted = await patchConstraints(host, created.id, {
      ...budget,
      budgetAmount: 500_000,
      expectedConstraintVersion: created.constraintVersion,
    });
    expect(omitted.statusCode).toBe(200);
    expect(omitted.json().constraints.administrativeArea).toEqual(stored);
    expect(omitted.json().constraintVersion).toBe(created.constraintVersion + 1);

    const read = await readRoom(host, created.id);
    const echoed = await patchConstraints(host, created.id, {
      ...read.constraints,
      budgetAmount: 600_000,
      expectedConstraintVersion: read.constraintVersion,
    });
    expect(echoed.statusCode).toBe(200);
    expect(echoed.json().constraints).toMatchObject({ budgetAmount: 600_000 });
    expect(echoed.json().constraints.administrativeArea).toEqual(stored);

    const widened = await patchConstraints(host, created.id, {
      ...budget,
      administrativeArea: { datasetVersion, provinceCode, communeCode: null },
      expectedConstraintVersion: echoed.json().constraintVersion,
    });
    expect(widened.statusCode).toBe(200);
    expect(widened.json().constraints.administrativeArea).toMatchObject({
      communeCode: null,
      communeName: null,
    });

    const cleared = await patchConstraints(host, created.id, {
      ...budget,
      administrativeArea: null,
      expectedConstraintVersion: widened.json().constraintVersion,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().constraints.administrativeArea).toBeNull();

    const guest = await readyToRank(host, created.id);
    const denied = await patchConstraints(guest, created.id, {
      ...budget,
      administrativeArea: { datasetVersion, provinceCode, communeCode },
      expectedConstraintVersion: cleared.json().constraintVersion,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('refuses edits outside editable states and on a concurrent version', async () => {
    const host = await register('room-area-guards@gogo.test');
    const room = (await createRoom(host, {})).json();
    const first = await patchConstraints(host, room.id, {
      ...budget,
      administrativeArea: { datasetVersion, provinceCode, communeCode },
      expectedConstraintVersion: room.constraintVersion,
    });
    expect(first.statusCode).toBe(200);
    const conflict = await patchConstraints(host, room.id, {
      ...budget,
      administrativeArea: null,
      expectedConstraintVersion: room.constraintVersion,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('CONSTRAINT_VERSION_CONFLICT');

    await db.update(schema.rooms).set({ status: 'active' }).where(eq(schema.rooms.id, room.id));
    const locked = await patchConstraints(host, room.id, {
      ...budget,
      administrativeArea: null,
      expectedConstraintVersion: first.json().constraintVersion,
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().code).toBe('ROOM_NOT_EDITABLE');
  });

  it('scopes candidates to verified mappings in the same dataset, commune or whole province', async () => {
    const { SuggestionsRepository } =
      await import('../../../libs/modules/suggestions/infrastructure/suggestions.repository.js');
    const repository = app.get(SuggestionsRepository);
    const host = await register('room-area-candidates@gogo.test');
    const ours = new Set(Object.values(placeIds));
    const idsFor = async (constraint: Body) => {
      const room = (await createRoom(host, constraint)).json();
      const candidates = await repository.retrieveCandidates(
        await repository.buildSnapshot(room.id),
      );
      return candidates.map((c) => c.placeId).filter((id) => ours.has(id));
    };
    expect(
      await idsFor({ administrativeArea: { datasetVersion, provinceCode, communeCode } }),
    ).toEqual([placeIds.inCommune]);
    expect(
      (
        await idsFor({ administrativeArea: { datasetVersion, provinceCode, communeCode: null } })
      ).sort(),
    ).toEqual([placeIds.inCommune, placeIds.siblingCommune].sort());
    // No area: nothing about administrative mapping narrows the pool.
    expect((await idsFor({})).sort()).toEqual([...ours].sort());
  });

  it('keeps a stored area readable after the dataset moves on and refuses to rank until reselected', async () => {
    const host = await register('room-area-dataset@gogo.test');
    const room = (
      await createRoom(host, { administrativeArea: { datasetVersion, provinceCode, communeCode } })
    ).json();
    await readyToRank(host, room.id);
    const before = await readRoom(host, room.id);
    await db
      .update(schema.roomConstraints)
      .set({
        administrativeArea: {
          ...before.constraints.administrativeArea,
          datasetVersion: 'previous-dataset',
          status: undefined,
        },
      })
      .where(
        and(
          eq(schema.roomConstraints.roomId, room.id),
          eq(schema.roomConstraints.version, before.constraintVersion),
        ),
      );

    const aged = await readRoom(host, room.id);
    expect(aged.constraints.administrativeArea).toEqual({
      ...before.constraints.administrativeArea,
      datasetVersion: 'previous-dataset',
      status: 'needs_reselection',
    });

    // An unrelated budget edit echoing the stale area neither fails nor re-maps it.
    const budgetEdit = await patchConstraints(host, room.id, {
      ...aged.constraints,
      budgetAmount: 350_000,
      expectedConstraintVersion: aged.constraintVersion,
    });
    expect(budgetEdit.statusCode).toBe(200);
    expect(budgetEdit.json().constraints.administrativeArea).toEqual(
      aged.constraints.administrativeArea,
    );

    const refused = await send('POST', host, `/v1/rooms/${room.id}/suggestions`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('ADMINISTRATIVE_VERSION_CHANGED');
    const runs = await db
      .select()
      .from(schema.suggestionRuns)
      .where(eq(schema.suggestionRuns.roomId, room.id));
    expect(runs).toHaveLength(0);

    const reselected = await patchConstraints(host, room.id, {
      ...budget,
      administrativeArea: { datasetVersion, provinceCode, communeCode },
      expectedConstraintVersion: budgetEdit.json().constraintVersion,
    });
    expect(reselected.statusCode).toBe(200);
    expect(reselected.json().constraints.administrativeArea.status).toBe('current');

    const ranked = await send('POST', host, `/v1/rooms/${room.id}/suggestions`);
    expect(ranked.statusCode).toBe(201);
    const candidateIds = (ranked.json().candidates as { placeId: string }[]).map((c) => c.placeId);
    expect(candidateIds).toContain(placeIds.inCommune);
    expect(candidateIds).not.toContain(placeIds.siblingCommune);

    // FR-ROOM-005: changing the area makes the ranking computed under it stale.
    const widened = await patchConstraints(host, room.id, {
      ...budget,
      administrativeArea: { datasetVersion, provinceCode, communeCode: null },
      expectedConstraintVersion: reselected.json().constraintVersion,
    });
    expect(widened.statusCode).toBe(200);
    const current = await send('GET', host, `/v1/rooms/${room.id}/suggestions/current`);
    expect(current.json().run.stale).toBe(true);
  });
});
