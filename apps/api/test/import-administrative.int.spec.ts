import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  PlaceImportJobService,
} from '@gogo/modules';
import { PLACE_PROVIDER } from '@gogo/providers';
import type { FakePlaceProvider } from '@gogo/providers';

/**
 * ADM-017 (#497) — the two import doors, mapped.
 *
 * Neither of them consulted the administrative resolver, so every place either
 * one created was `UNMAPPED` — which the approval policy then blocked, with the
 * import screen unable to say why. These tests are about the two claims that
 * matter: that the mapping is written in the same transaction as the place, and
 * that what the operator was shown beforehand is what actually got stored.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: FakePlaceProvider;
let imports: PlaceImportJobService;
let datasetVersion: string;

const BOUNDARY_VERSION = 'fixture-v5.0.0';
const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.72.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Discovered from the fixture, never assumed. */
let mapped: { communeCode: string; provinceCode: string };
let inside: { lng: number; lat: number };
/** In Vietnam, in none of the fixture's polygons. */
const outside = { lng: 108.5, lat: 12.0 };

async function createAdmin(email: string, role: 'editor' | 'moderator' | 'ops_admin') {
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: 'Admin', role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  return { id: row!.id, token: res.json().accessToken as string };
}

/** Fastify inject has no form-data helper; build the body by hand. */
function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = '----gogoformboundary1234567890';
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    file.content,
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const CSV_HEADER =
  'source_row_id,name,city,district,google_maps_url,category,price_min,price_max,price_unit';

function csv(rows: string[]): Buffer {
  return Buffer.from([CSV_HEADER, ...rows].join('\n'), 'utf8');
}

async function createJob(token: string, rows: string[], mode = 'create_drafts') {
  const body = multipart(
    { mode, defaultCity: 'Hồ Chí Minh' },
    { name: `adm017-${Math.random()}.csv`, content: csv(rows) },
  );
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/place-imports',
    remoteAddress: ip(),
    headers: { ...auth(token), ...body.headers },
    payload: body.payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function rowsOf(jobId: string, token: string) {
  const res = await api().inject({
    method: 'GET',
    url: `/v1/cms/place-imports/${jobId}/rows`,
    remoteAddress: ip(),
    headers: auth(token),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as {
    id: string;
    status: string;
    matchedPlaceId: string | null;
    administrative: {
      provinceCode: string | null;
      provinceName: string | null;
      communeCode: string | null;
      communeName: string | null;
      status: string | null;
      datasetVersion: string | null;
      requiresReview: boolean;
      blocksPublication: boolean;
    } | null;
  }[];
}

/** Upload → start → one worker tick. Returns the job's rows. */
async function runImport(token: string, rows: string[], mode = 'create_drafts') {
  const job = await createJob(token, rows, mode);
  await api().inject({
    method: 'POST',
    url: `/v1/cms/place-imports/${job.id}/start`,
    remoteAddress: ip(),
    headers: auth(token),
  });
  await imports.processJob(job.id);
  return { job, rows: await rowsOf(job.id, token) };
}

function rowFor(id: string, name: string, url: string, city = 'Hồ Chí Minh', district = 'Quận 1') {
  return `${id},${name},${city},${district},${url},cafe,100000,200000,per_person`;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_import_administrative_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.GOOGLE_SHEETS_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  for (const key of ['cafe', 'restaurant']) {
    await db.insert(schema.taxonomies).values({ kind: 'category', key });
  }

  // #489 — a dataset import binds the boundary release loaded at the time.
  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    archivePath: FIXTURE,
  });
  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: BOUNDARY_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, report.datasetVersionId));
  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: BOUNDARY_VERSION,
    archivePath: FIXTURE,
  });

  const drawn = await db.execute(sql`
    select b.code, b.parent_code,
           st_x(st_pointonsurface(b.geom)) as lng, st_y(st_pointonsurface(b.geom)) as lat
    from administrative_unit_boundaries b
    where b.boundary_version = ${BOUNDARY_VERSION} and b.level = 'COMMUNE'
    order by b.code limit 1`);
  const row = (
    drawn as unknown as {
      rows: { code: string; parent_code: string; lng: number; lat: number }[];
    }
  ).rows[0]!;
  mapped = { communeCode: row.code, provinceCode: row.parent_code };
  inside = { lng: Number(row.lng), lat: Number(row.lat) };

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  places = app.get(PLACE_PROVIDER);
  imports = app.get(PlaceImportJobService);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('a spreadsheet row says which commune it lands in, before it lands', () => {
  it('previews the identity on a resolved row and commits the same one', async () => {
    const editor = await createAdmin('adm017-preview@gogo.local', 'editor');
    const ops = await createAdmin('adm017-preview-ops@gogo.local', 'ops_admin');
    places.seed({ providerPlaceId: 'adm017-a', name: 'Quán A', ...inside });

    const { job, rows } = await runImport(editor.token, [
      rowFor('A-1', 'Quán A', 'https://www.google.com/maps?place_id=adm017-a'),
    ]);
    expect(rows[0]!.status).toBe('ready');
    const preview = rows[0]!.administrative!;
    expect(preview).toMatchObject({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      status: 'AUTO_MATCHED',
      datasetVersion,
      requiresReview: false,
      // The claim an import screen is most tempted to make, and must not.
      blocksPublication: true,
    });
    expect(preview.communeName).toBeTruthy();

    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });

    const after = await rowsOf(job.id, editor.token);
    expect(after[0]!.status).toBe('imported');
    // What the operator was shown is what was stored. The two ran the same
    // resolver over the same coordinate — separately, which is what makes the
    // comparison worth making.
    expect(after[0]!.administrative).toMatchObject({
      provinceCode: preview.provinceCode,
      communeCode: preview.communeCode,
      status: preview.status,
      datasetVersion: preview.datasetVersion,
    });

    const [place] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, after[0]!.matchedPlaceId!));
    expect(place).toMatchObject({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeDatasetVersion: datasetVersion,
    });
  }, 180_000);

  it('reports a row nothing can place as UNMAPPED rather than as a review task', async () => {
    const editor = await createAdmin('adm017-unmapped@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'adm017-b', name: 'Quán B', ...outside });

    const { rows } = await runImport(editor.token, [
      rowFor('B-1', 'Quán B', 'https://www.google.com/maps?place_id=adm017-b'),
    ]);
    expect(rows[0]!.administrative).toMatchObject({
      status: 'UNMAPPED',
      provinceCode: null,
      communeCode: null,
      // Nothing is claimed, so no version is stamped.
      datasetVersion: null,
      requiresReview: false,
    });
  }, 180_000);

  it('never calls an automatic match a publication', async () => {
    const editor = await createAdmin('adm017-defer@gogo.local', 'editor');
    const ops = await createAdmin('adm017-defer-ops@gogo.local', 'ops_admin');
    places.seed({ providerPlaceId: 'adm017-c', name: 'Quán C', ...inside });

    const { job } = await runImport(
      editor.token,
      [rowFor('C-1', 'Quán C', 'https://www.google.com/maps?place_id=adm017-c')],
      'publish_approved',
    );
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });

    const [place] = await db.select().from(schema.places).where(eq(schema.places.name, 'Quán C'));
    // Mapped, and still not live: AUTO_MATCHED is the resolver's answer, and
    // publication needs a person's.
    expect(place!.administrativeMappingStatus).toBe('AUTO_MATCHED');
    expect(place!.status).toBe('review');

    const [ingestRow] = await db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.jobId, job.id));
    expect(ingestRow!.publicationOutcome).toBe('deferred_mapping_unverified');
  }, 180_000);

  it('keeps the sheet’s legacy city and district out of the identity', async () => {
    const editor = await createAdmin('adm017-legacy@gogo.local', 'editor');
    const ops = await createAdmin('adm017-legacy-ops@gogo.local', 'ops_admin');
    places.seed({ providerPlaceId: 'adm017-d', name: 'Quán D', ...inside });

    // The sheet says Hồ Chí Minh / Quận 1; the coordinate says otherwise, and
    // the coordinate is the evidence that can be checked.
    const { job, rows } = await runImport(editor.token, [
      rowFor(
        'D-1',
        'Quán D',
        'https://www.google.com/maps?place_id=adm017-d',
        'Hồ Chí Minh',
        'Quận 1',
      ),
    ]);
    expect(rows[0]!.administrative!.communeCode).toBe(mapped.communeCode);

    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    const [place] = await db.select().from(schema.places).where(eq(schema.places.name, 'Quán D'));
    expect(place!.communeCode).toBe(mapped.communeCode);
  }, 180_000);
});

describe('the Google-link create form opens on a real identity', () => {
  it('answers a resolved link with both current levels', async () => {
    const editor = await createAdmin('adm017-link@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'adm017-link-1', name: 'Quán Link', ...inside });

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/places/resolve-link',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { googlePlaceId: 'adm017-link-1' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.status).toBe('RESOLVED');
    expect(body.administrative).toMatchObject({
      provinceCode: mapped.provinceCode,
      communeCode: mapped.communeCode,
      status: 'AUTO_MATCHED',
      datasetVersion,
    });
    expect(body.administrative.communeName).toBeTruthy();
  }, 120_000);

  it('says UNMAPPED for a point no polygon claims, and stores nothing either way', async () => {
    const editor = await createAdmin('adm017-link2@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'adm017-link-2', name: 'Quán Xa', ...outside });

    const before = await db.execute(sql`select count(*)::int as n from places`);
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/places/resolve-link',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { googlePlaceId: 'adm017-link-2' },
    });
    expect(res.json().administrative).toMatchObject({
      status: 'UNMAPPED',
      provinceCode: null,
      communeCode: null,
    });

    // A preview writes nothing — not a place, and not a mapping.
    const after = await db.execute(sql`select count(*)::int as n from places`);
    expect((after as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(
      (before as unknown as { rows: { n: number }[] }).rows[0]!.n,
    );
  }, 120_000);
});

describe('mapping an import asks nobody', () => {
  it('adds no Google request and no Redis command beyond the resolve it already made', async () => {
    // ADR-0019 §10 / GoGo-BE#464: administrative codes are GoGo facts because
    // no provider is asked for them. ADR-0019 §8: they are not in Upstash.
    const editor = await createAdmin('adm017-quiet@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'adm017-e', name: 'Quán E', ...inside });
    const { job } = await runImport(editor.token, [
      rowFor('E-1', 'Quán E', 'https://www.google.com/maps?place_id=adm017-e'),
    ]);

    const google = await metricCount('places_provider_requests_total');
    const redis = await metricCount('provider_requests_total', 'upstash');
    // Re-reading the rows re-renders the identity from what is stored.
    await rowsOf(job.id, editor.token);
    expect(await metricCount('places_provider_requests_total')).toBe(google);
    expect(await metricCount('provider_requests_total', 'upstash')).toBe(redis);
  }, 180_000);
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
