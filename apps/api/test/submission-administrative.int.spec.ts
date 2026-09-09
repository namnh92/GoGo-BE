import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { PLACE_PROVIDER } from '@gogo/providers';
import type { FakePlaceProvider } from '@gogo/providers';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  AdministrativeResolverService,
} from '@gogo/modules';

/**
 * PI-BE-030 (#525) — a place approved from a Mobile contribution is mapped
 * like every other place.
 *
 * Three doors lead into the catalogue: the console's link form, a bulk import,
 * and a contribution a person sent from the app. The first two resolved the
 * administrative identity in the transaction that created the place; this one
 * did not, so a contributed place arrived `UNMAPPED` — blocked from publication
 * with nothing for a reviewer to approve, while the same Google link through
 * either other door arrived `AUTO_MATCHED`.
 *
 * Everything here goes through the real HTTP endpoints, against real fixture
 * geometry, because the claim is about what the catalogue ends up holding.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: FakePlaceProvider;
let datasetId: string;
let datasetVersion: string;

/** A commune the fixture actually draws, and a point safely inside it. */
let mapped: { provinceCode: string; communeCode: string };
let inside: { lng: number; lat: number };
/** Inside Vietnam, inside no polygon this fixture carries. */
const outside = { lng: 108.5, lat: 12.0 };

const BOUNDARY_VERSION = 'v5.0.0';
const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.62.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const tokens: Record<'moderator' | 'editor', string> = { moderator: '', editor: '' };

async function createAdmin(role: 'moderator' | 'editor') {
  const email = `adm030-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: role, role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'U' },
  });
  return res.json().accessToken as string;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

async function placeRow(id: string) {
  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  return row!;
}

let submissionSeq = 0;

/**
 * The Mobile contribution, end to end: the app resolves a link, the person
 * submits the place it named, and a moderator approves it.
 */
async function contributeAndApprove(
  at: { lng: number; lat: number },
  over: { name?: string } = {},
): Promise<{ placeId: string; decideStatus: number; googlePlaceId: string }> {
  submissionSeq += 1;
  const googlePlaceId = `fake-contrib-${submissionSeq}`;
  places.seed({
    providerPlaceId: googlePlaceId,
    name: over.name ?? `Quán Đóng Góp ${submissionSeq}`,
    lat: at.lat,
    lng: at.lng,
  });

  const token = await register(`contrib-${submissionSeq}@gogo.id.vn`);
  const submitted = await api().inject({
    method: 'POST',
    url: '/v1/place-submissions',
    remoteAddress: ip(),
    headers: auth(token),
    payload: { googlePlaceId },
  });
  expect(submitted.statusCode, submitted.body).toBe(201);

  const decided = await api().inject({
    method: 'POST',
    url: `/v1/cms/place-submissions/${submitted.json().submissionId}/decide`,
    remoteAddress: ip(),
    headers: auth(tokens.moderator),
    payload: { decision: 'approved', reason: 'đủ dữ liệu, đúng khu vực' },
  });
  return {
    placeId: (decided.json().placeId as string) ?? '',
    decideStatus: decided.statusCode,
    googlePlaceId,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_submission_administrative_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';

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

  const [drawn] = await rows<{ code: string; parent_code: string; lng: number; lat: number }>(sql`
    select b.code, b.parent_code,
           st_x(st_pointonsurface(b.geom)) as lng, st_y(st_pointonsurface(b.geom)) as lat
    from administrative_unit_boundaries b
    where b.boundary_version = ${BOUNDARY_VERSION} and b.level = 'COMMUNE'
    order by b.code limit 1`);
  mapped = { communeCode: drawn!.code, provinceCode: drawn!.parent_code };
  inside = { lng: Number(drawn!.lng), lat: Number(drawn!.lat) };

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  places = app.get(PLACE_PROVIDER) as FakePlaceProvider;
  for (const role of ['moderator', 'editor'] as const) await createAdmin(role);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table places cascade`);
  await db.execute(sql`truncate table place_submissions cascade`);
  await db.execute(sql`delete from audit_logs`);
  places.tiersRequested.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approving a Mobile contribution maps the place it creates', () => {
  it('resolves the stored coordinate to both levels and calls it AUTO_MATCHED', async () => {
    const { placeId, decideStatus } = await contributeAndApprove(inside);
    expect(decideStatus).toBe(201);

    const place = await placeRow(placeId);
    expect(place.status).toBe('community_submitted');
    expect(place.provinceCode).toBe(mapped.provinceCode);
    expect(place.communeCode).toBe(mapped.communeCode);
    expect(place.administrativeMappingStatus).toBe('AUTO_MATCHED');
    // The version the codes were checked against, so a later dataset can tell
    // whether this mapping is still current.
    expect(place.administrativeDatasetVersion).toBe(datasetVersion);
    expect(place.administrativeBoundaryVersion).toBe(BOUNDARY_VERSION);
  });

  it('never writes VERIFIED — approving a submission is not certifying where it is', async () => {
    const { placeId } = await contributeAndApprove(inside);
    const place = await placeRow(placeId);

    expect(place.administrativeMappingStatus).not.toBe('VERIFIED');
    // Nobody is credited with a decision nobody made, and a machine answer
    // carries no reviewer.
    expect(place.administrativeMappedBy).toBeNull();
  });

  it('leaves the publication blocker exactly where the policy puts it', async () => {
    const { placeId } = await contributeAndApprove(inside);
    const detail = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${placeId}`,
      remoteAddress: ip(),
      headers: auth(tokens.editor),
    });

    const administrative = detail.json().administrative as {
      status: string;
      approvalBlock: { code: string } | null;
    };
    expect(administrative.status).toBe('AUTO_MATCHED');
    expect(administrative.approvalBlock?.code).toBe('MAPPING_NOT_VERIFIED');
  });

  it('says UNMAPPED when the coordinate is inside no unit, rather than guessing', async () => {
    const { placeId, decideStatus } = await contributeAndApprove(outside);
    expect(decideStatus).toBe(201);

    const place = await placeRow(placeId);
    expect(place.administrativeMappingStatus).toBe('UNMAPPED');
    expect(place.provinceCode).toBeNull();
    expect(place.communeCode).toBeNull();
    // The place still exists: an address nobody can place is not a reason to
    // discard a contribution a moderator accepted.
    expect(place.status).toBe('community_submitted');
  });

  it('says NEEDS_REVIEW when two units both claim the coordinate', async () => {
    /*
     * Two deterministic sources naming different communes is the one thing the
     * resolver must never resolve by picking. The fixture draws no overlap, so
     * one is made: a second polygon, under a real commune code, covering the
     * same ground. That is exactly the shape a boundary release with an overlap
     * would have, and `boundary-validation` degrades such a release to review
     * for this reason.
     */
    const [neighbour] = await rows<{ code: string; parent_code: string }>(sql`
      select code, parent_code from administrative_unit_boundaries
      where boundary_version = ${BOUNDARY_VERSION} and level = 'COMMUNE' and code <> ${mapped.communeCode}
      order by code limit 1`);
    await db.execute(sql`
      insert into administrative_unit_boundaries
        (boundary_version, code, level, parent_code, name, name_normalized, geom, source, source_checksum)
      select ${BOUNDARY_VERSION}, ${`${neighbour!.code}-overlap`}, 'COMMUNE', ${neighbour!.parent_code},
             'Chồng lấn', 'chong lan', geom, 'test-overlap', 'test'
      from administrative_unit_boundaries
      where boundary_version = ${BOUNDARY_VERSION} and level = 'COMMUNE' and code = ${mapped.communeCode}`);

    try {
      const { placeId, decideStatus } = await contributeAndApprove(inside);
      expect(decideStatus).toBe(201);

      const place = await placeRow(placeId);
      expect(place.administrativeMappingStatus).toBe('NEEDS_REVIEW');
      // Nothing is written as a fact when the evidence conflicts.
      expect(place.communeCode).toBeNull();
      expect(place.status).toBe('community_submitted');
    } finally {
      await db.execute(sql`
        delete from administrative_unit_boundaries
        where boundary_version = ${BOUNDARY_VERSION} and source = 'test-overlap'`);
    }
  });

  it('creates the place anyway when the deployment has published no dataset', async () => {
    // The existing policy: no active dataset is a deployment state, not a
    // reason to fail a moderator's decision or to invent an identity.
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'STAGED' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    try {
      const { placeId, decideStatus } = await contributeAndApprove(inside);
      expect(decideStatus).toBe(201);

      const place = await placeRow(placeId);
      expect(place.status).toBe('community_submitted');
      expect(place.administrativeMappingStatus).toBe('UNMAPPED');
      expect(place.administrativeDatasetVersion).toBeNull();
    } finally {
      await db
        .update(schema.administrativeDatasetVersions)
        .set({ status: 'PUBLISHED' })
        .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    }
  });

  it('pays for exactly one provider fetch, the one that becomes the row', async () => {
    await contributeAndApprove(inside);
    // Submitting verifies the id, approving re-verifies at `quality` because
    // that fetch becomes the catalogue row. Resolving the mapping adds nothing:
    // it reads the coordinate already stored.
    expect(places.tiersRequested.filter((t) => t === 'detail')).toHaveLength(0);
    expect(places.tiersRequested.filter((t) => t === 'quality')).toHaveLength(1);
  });

  it('creates no place at all when the mapping write fails', async () => {
    const resolver = app.get(AdministrativeResolverService);
    vi.spyOn(resolver, 'persistWithin').mockRejectedValue(new Error('boom'));

    const { decideStatus } = await contributeAndApprove(inside);
    expect(decideStatus).toBeGreaterThanOrEqual(500);

    // One transaction: a place without its mapping is the state this whole
    // issue is about, so a half-written one must not survive either.
    const placeCount = await rows<{ n: number }>(sql`select count(*)::int as n from places`);
    expect(placeCount[0]!.n).toBe(0);
    const approvedCount = await rows<{ n: number }>(sql`
      select count(*)::int as n from place_submissions where status = 'approved'`);
    expect(approvedCount[0]!.n).toBe(0);
  });

  it('lands on the same mapping the console link form would have produced', async () => {
    const contributed = await contributeAndApprove(inside);
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/places',
      remoteAddress: ip(),
      headers: auth(tokens.editor),
      payload: { name: 'Quán Tạo Từ CMS', lat: inside.lat, lng: inside.lng },
    });
    expect(created.statusCode, created.body).toBe(201);

    const fromApp = await placeRow(contributed.placeId);
    const fromConsole = await placeRow(created.json().id as string);

    // Same coordinate, same dataset, same answer — whichever door it came in.
    for (const key of [
      'administrativeMappingStatus',
      'provinceCode',
      'communeCode',
      'administrativeDatasetVersion',
      'administrativeBoundaryVersion',
      'administrativeMappingSource',
    ] as const) {
      expect(fromApp[key], key).toEqual(fromConsole[key]);
    }
  });
});
