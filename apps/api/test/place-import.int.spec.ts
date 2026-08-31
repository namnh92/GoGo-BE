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
import { PlaceImportJobService } from '@gogo/modules';
import { PLACE_PROVIDER, ProviderQuotaExceededError, SHEETS_PROVIDER } from '@gogo/providers';
import type { FakePlaceProvider, FakeSheets } from '@gogo/providers';

/**
 * PI-BE-011..017 acceptance over real HTTP + PostGIS: upload, validation,
 * mapping, chunked processing, quota pause, cancel/retry, publish RBAC and the
 * error report.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: FakePlaceProvider;
let sheets: FakeSheets;
let imports: PlaceImportJobService;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.70.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_import_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_MAPS_API_KEY = '';
  process.env.GOOGLE_SHEETS_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  for (const key of ['cafe', 'restaurant']) {
    await db.insert(schema.taxonomies).values({ kind: 'category', key });
  }
  for (const key of ['chill', 'cozy']) {
    await db.insert(schema.taxonomies).values({ kind: 'mood', key });
  }
  for (const key of ['couple', 'group']) {
    await db.insert(schema.taxonomies).values({ kind: 'suitability', key });
  }

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  places = app.get(PLACE_PROVIDER);
  sheets = app.get(SHEETS_PROVIDER);
  imports = app.get(PlaceImportJobService);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('PI-BE-011/013 — upload, validation, mapping', () => {
  it('dry-run reports per-row errors and never calls the provider', async () => {
    const editor = await createAdmin('import-editor@gogo.local', 'editor');
    const body = multipart(
      { mode: 'dry_run', defaultCity: 'Hồ Chí Minh' },
      {
        name: 'places.csv',
        content: csv([
          'HCM-1,Quán A,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-a,cafe,100000,250000,per_person',
          'HCM-2,Quán B,,Quận 3,https://evil.example.com/maps,cafe,100000,50000,per_person',
          ',Quán C,Hồ Chí Minh,,,unknown_key,,,',
        ]),
      },
    );
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.status).toBe('completed');
    expect(job.totals.rows).toBe(3);
    expect(job.totals.failed).toBe(2);

    const rows = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${job.id}/rows`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    const items = rows.json().items as { sourceRowId: string; errors: { code: string }[] }[];
    const codes = (id: string) =>
      items.find((r) => r.sourceRowId === id)!.errors.map((e) => e.code);
    expect(codes('HCM-1')).toEqual([]);
    expect(codes('HCM-2')).toEqual(expect.arrayContaining(['URL_INVALID', 'PRICE_RANGE_INVALID']));
    expect(items.some((r) => r.errors.some((e) => e.code === 'CATEGORY_UNKNOWN'))).toBe(true);
  });

  it('re-uploading the same file in the same mode reuses the job', async () => {
    const editor = await createAdmin('import-editor2@gogo.local', 'editor');
    const content = csv([
      'DUP-1,Quán A,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-a,cafe,,,',
    ]);
    const send = async () => {
      const body = multipart({ mode: 'dry_run' }, { name: 'dup.csv', content });
      return api().inject({
        method: 'POST',
        url: '/v1/cms/place-imports',
        remoteAddress: ip(),
        headers: { ...auth(editor.token), ...body.headers },
        payload: body.payload,
      });
    };
    const first = (await send()).json();
    const second = (await send()).json();
    expect(second.id).toBe(first.id);
    expect(second.reused).toBe(true);
  });

  it('rejects a .xlsx name carrying CSV bytes', async () => {
    const editor = await createAdmin('import-editor3@gogo.local', 'editor');
    const body = multipart({ mode: 'dry_run' }, { name: 'fake.xlsx', content: csv(['X,Y']) });
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FILE_TYPE_MISMATCH');
  });
});

describe('PI-BE-012 — Google Sheets source', () => {
  it('imports the selected tabs and maps the tab name to a city', async () => {
    const editor = await createAdmin('sheet-editor@gogo.local', 'editor');
    sheets.seed('1AbCdEfGhIjKlMnOpQrStUvWxYz012345678', 'HCM', [
      ['source_row_id', 'name', 'category', 'google_maps_url'],
      ['S-1', 'Quán Sheet', 'cafe', 'https://www.google.com/maps?place_id=fake-a'],
    ]);
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl:
          'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345678/edit#gid=0',
        sheets: ['HCM'],
        mode: 'dry_run',
        tabCityMapping: { HCM: 'Hồ Chí Minh' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totals.failed).toBe(0);
  });

  it('surfaces a permission error as 403, not a 500', async () => {
    const editor = await createAdmin('sheet-editor2@gogo.local', 'editor');
    sheets.denied.add('2DeniedDeniedDeniedDenied0000000');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '2DeniedDeniedDeniedDenied0000000',
        mode: 'dry_run',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SHEET_PERMISSION_DENIED');
  });

  it('reports an unconfigured provider as 503, not as a missing sheet', async () => {
    // PI-BE-021: this is the exact shape of the DEV incident — a valid, public
    // spreadsheet URL against a process with no Sheets credential. It answered
    // 400 SHEET_NOT_FOUND, and the editor went looking at their sharing
    // settings. The status is what tells them, and alerting, whose fault it is.
    const editor = await createAdmin('sheet-editor-unconfigured@gogo.local', 'editor');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl:
          'https://docs.google.com/spreadsheets/d/3NeverSeededNeverSeeded00000000000/edit?usp=sharing',
        mode: 'dry_run',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SHEET_PROVIDER_NOT_CONFIGURED');
    // Never retryable: no amount of waiting puts a key in the environment.
    expect(res.json().retryable).toBe(false);
  });

  it('rejects a non-Google spreadsheet URL', async () => {
    const editor = await createAdmin('sheet-editor3@gogo.local', 'editor');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { spreadsheetUrl: 'https://evil.example.com/spreadsheets/d/x', mode: 'dry_run' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SHEET_URL_INVALID');
  });
});

describe('PI-BE-015/016 — processing, quota pause, publish RBAC', () => {
  async function createJob(token: string, rows: string[], mode = 'create_drafts') {
    const body = multipart(
      { mode, defaultCity: 'Hồ Chí Minh' },
      { name: `job-${rows.length}-${Math.random()}.csv`, content: csv(rows) },
    );
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(token), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('resolves ready rows and publishes drafts, editor cannot publish', async () => {
    const editor = await createAdmin('proc-editor@gogo.local', 'editor');
    const ops = await createAdmin('proc-ops@gogo.local', 'ops_admin');
    places.seed({ providerPlaceId: 'fake-ready', name: 'Quán Ready', lat: 10.78, lng: 106.7 });

    const job = await createJob(editor.token, [
      'RDY-1,Quán Ready,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-ready,cafe,100000,200000,per_person',
    ]);
    expect(job.status).toBe('review_required');

    const started = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(started.json().status).toBe('processing');

    // The worker tick, driven directly so the test does not need Redis.
    await imports.processJob(job.id);

    const after = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${job.id}`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(after.json().rowsByStatus.ready).toBe(1);
    expect(after.json().status).toBe('completed');

    const denied = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('ROLE_DENIED');

    const published = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(published.json().created).toBe(1);

    const [place] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Quán Ready'))
      .limit(1);
    expect(place?.status).toBe('draft');
    const [priced] = await db
      .select()
      .from(schema.placePrices)
      .where(eq(schema.placePrices.placeId, place!.id));
    expect(priced?.priceMin).toBe(100_000);

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, job.id));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'place_import.created',
        'place_import.started',
        'place_import.published',
      ]),
    );
  });

  it('parks the job on provider quota and resumes without losing rows', async () => {
    const editor = await createAdmin('quota-editor@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'fake-quota', name: 'Quán Quota', lat: 10.79, lng: 106.71 });
    const job = await createJob(editor.token, [
      'Q-1,Quán Quota,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-quota,cafe,,,',
    ]);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });

    const original = places.details.bind(places);
    places.details = async () => {
      throw new ProviderQuotaExceededError('google.places');
    };
    await imports.processJob(job.id);
    places.details = original;

    const paused = await imports.getJob(job.id);
    expect(paused.status).toBe('paused_provider_quota');
    // The row is untouched, not marked invalid.
    expect(paused.rowsByStatus.pending).toBe(1);

    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(job.id);
    const resumed = await imports.getJob(job.id);
    expect(resumed.rowsByStatus.ready).toBe(1);
  });

  it('links a duplicate row to the existing place instead of creating another', async () => {
    const editor = await createAdmin('dup-editor@gogo.local', 'editor');
    const ops = await createAdmin('dup-ops@gogo.local', 'ops_admin');
    places.seed({ providerPlaceId: 'fake-dup', name: 'Quán Dup', lat: 10.8, lng: 106.72 });

    const first = await createJob(editor.token, [
      'D-1,Quán Dup,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-dup,cafe,,,',
    ]);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${first.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(first.id);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${first.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });

    const second = await createJob(editor.token, [
      'D-2,Quán Dup,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-dup,cafe,,,',
    ]);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${second.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(second.id);
    const job = await imports.getJob(second.id);
    expect(job.rowsByStatus.duplicate).toBe(1);

    const counted = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.places)
      .where(eq(schema.places.name, 'Quán Dup'));
    expect(counted[0]?.n).toBe(1);
  });

  it('cancel stops pending work and retry re-queues failed rows', async () => {
    const editor = await createAdmin('cancel-editor@gogo.local', 'editor');
    const job = await createJob(editor.token, [
      'C-1,Quán Không Tồn Tại,Hồ Chí Minh,Quận 1,,cafe,,,',
    ]);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    const cancelled = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/cancel`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(cancelled.json().status).toBe('cancelled');

    // A cancelled job processes nothing.
    const result = await imports.processJob(job.id);
    expect(result.processed).toBe(0);

    const retried = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/retry`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(retried.json().status).toBe('processing');
    await imports.processJob(job.id);
    const done = await imports.getJob(job.id);
    expect(done.rowsByStatus.unresolved).toBe(1);
    expect(done.status).toBe('failed');
  });
});

describe('PI-BE-017 — error report', () => {
  it('serves a CSV with formula injection neutralised', async () => {
    const editor = await createAdmin('report-editor@gogo.local', 'editor');
    const body = multipart(
      { mode: 'dry_run' },
      {
        name: 'report.csv',
        content: csv(['=HCM-EVIL,Quán X,,Quận 1,,cafe,,,']),
      },
    );
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), ...body.headers },
      payload: body.payload,
    });
    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${created.json().id}/error-report`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toContain(`"'=HCM-EVIL"`);
    expect(res.body).toContain('CITY_REQUIRED');
  });
});

describe('RBAC', () => {
  it('a moderator can read import history but cannot start an import', async () => {
    // BE-IMP-008: reads are hierarchical (a moderator ranks with an editor, so
    // it sees the queue), writes still need the exact role.
    const moderator = await createAdmin('import-mod@gogo.local', 'moderator');
    const read = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: auth(moderator.token),
    });
    expect(read.statusCode).toBe(200);

    const body = multipart(
      { mode: 'dry_run' },
      { name: 'mod.csv', content: csv(['M-1,Q,HCM,,,cafe,,,']) },
    );
    const write = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(moderator.token), ...body.headers },
      payload: body.payload,
    });
    expect(write.json().code).toBe('ROLE_DENIED');
  });

  it('an authenticated non-admin user is refused', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'not-admin@gogo.local',
        password: 'sufficiently-long-pw',
        displayName: 'U',
      },
    });
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: auth(reg.json().accessToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PI-QA-002 — bulk import at 0 / 1 / 100 / 5.000 rows', () => {
  async function upload(token: string, content: Buffer, mode: string, name: string) {
    const body = multipart({ mode, defaultCity: 'Hồ Chí Minh' }, { name, content });
    return api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(token), ...body.headers },
      payload: body.payload,
    });
  }

  function rows(count: number, prefix: string): string[] {
    return Array.from(
      { length: count },
      (_, i) =>
        `${prefix}-${i},Quán ${prefix} ${i},Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-scale-${i % 25},cafe,100000,200000,per_person`,
    );
  }

  it('0 rows is a bad request, not an empty job', async () => {
    const editor = await createAdmin('scale0@gogo.local', 'editor');
    const res = await upload(editor.token, csv([]), 'dry_run', 'empty.csv');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FILE_EMPTY');
  });

  it('1 row: counts, progress and error report agree', async () => {
    const editor = await createAdmin('scale1@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'fake-scale-0', name: 'Quán One', lat: 10.9, lng: 106.9 });

    const job = (
      await upload(editor.token, csv(rows(1, 'ONE')), 'create_drafts', 'one.csv')
    ).json();
    expect(job.totals.rows).toBe(1);

    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(job.id);

    const done = await imports.getJob(job.id);
    expect(done.totals.processed).toBe(1);
    expect(done.totals.success).toBe(1);
    expect(done.totals.failed).toBe(0);
    expect(done.status).toBe('completed');

    const report = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${job.id}/error-report`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    // No errors, no warnings → header row only.
    expect(report.body.trim().split('\r\n')).toHaveLength(1);
  });

  it('100 rows: mixed outcomes, and retry does not duplicate', async () => {
    const editor = await createAdmin('scale100@gogo.local', 'editor');
    for (let i = 0; i < 25; i++) {
      places.seed({
        providerPlaceId: `fake-scale-${i}`,
        name: `Quán Scale ${i}`,
        lat: 10.5 + i / 100,
        lng: 106.5 + i / 100,
      });
    }
    // 90 resolvable rows + 10 that fail validation up front.
    const bad = Array.from({ length: 10 }, (_, i) => `,Quán Bad ${i},,,,,,,`);
    const job = (
      await upload(editor.token, csv([...rows(90, 'C'), ...bad]), 'create_drafts', 'hundred.csv')
    ).json();
    expect(job.totals.rows).toBe(100);
    expect(job.totals.failed).toBe(10);

    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(job.id);

    const done = await imports.getJob(job.id);
    expect(done.totals.processed).toBe(100);
    expect(done.rowsByStatus.validation_failed).toBe(10);
    // 25 distinct provider places: the first row of each is ready, the rest
    // are same-provider duplicates of it — no second canonical place.
    expect((done.rowsByStatus.ready ?? 0) + (done.rowsByStatus.duplicate ?? 0)).toBe(90);
    expect(done.status).toBe('partial_success');

    const report = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${job.id}/error-report`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    // Header + one line per row carrying an error or warning.
    const lines = report.body.trim().split('\r\n');
    expect(lines.length - 1).toBe(
      (done.rowsByStatus.validation_failed ?? 0) + (done.rowsByStatus.duplicate ?? 0),
    );

    const readyRows = await imports.listRows(job.id, { status: 'ready', limit: 100, offset: 0 });
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth((await createAdmin('scale100-ops@gogo.local', 'ops_admin')).token),
      payload: {},
    });
    const afterPublish = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.places)
      .where(sql`${schema.places.name} like 'Quán C %'`);
    const placesAfter = afterPublish[0]?.n ?? 0;
    expect(placesAfter).toBe(readyRows.items.length);

    // Retry re-queues nothing resolvable and creates no second place.
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/retry`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(job.id);
    const afterRetry = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.places)
      .where(sql`${schema.places.name} like 'Quán C %'`);
    expect(afterRetry[0]?.n).toBe(placesAfter);
  });

  it('5.000 rows: accepted, chunked and counted; 5.001 is refused', async () => {
    const editor = await createAdmin('scale5k@gogo.local', 'editor');
    const job = (
      await upload(editor.token, csv(rows(5000, 'K')), 'dry_run', 'five-thousand.csv')
    ).json();
    expect(job.totals.rows).toBe(5000);
    expect(job.totals.failed).toBe(0);

    const page = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${job.id}/rows?limit=100&offset=4900`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(page.json().items).toHaveLength(100);
    // Exactly the last page: nextOffset is null rather than a page that would
    // come back empty.
    expect(page.json().nextOffset).toBeNull();

    const midPage = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${job.id}/rows?limit=100&offset=0`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(midPage.json().nextOffset).toBe(100);

    const tooMany = await upload(editor.token, csv(rows(5001, 'X')), 'dry_run', 'over.csv');
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().code).toBe('TOO_MANY_ROWS');
  });
});

describe('BE-IMP-004 — update_existing re-syncs an edited sheet', () => {
  async function runImport(token: string, rows: string[], mode: string, name: string) {
    const body = multipart({ mode, defaultCity: 'Hồ Chí Minh' }, { name, content: csv(rows) });
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(token), ...body.headers },
      payload: body.payload,
    });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(token),
    });
    await imports.processJob(job.id);
    return job.id as string;
  }

  it('a corrected price in the sheet reaches the catalog', async () => {
    const editor = await createAdmin('upd-editor@gogo.local', 'editor');
    const ops = await createAdmin('upd-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-upd',
      name: 'Quán Update',
      lat: 10.81,
      lng: 106.73,
      ratingCount: 300,
      primaryType: 'cafe',
    });
    const row = (price: string) =>
      `U-1,Quán Update,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-upd,cafe,${price},per_person`;

    const first = await runImport(editor.token, [row('100000,200000')], 'create_drafts', 'u1.csv');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${first}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    const [place] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Quán Update'));
    expect(place).toBeTruthy();

    // Before this mode existed, re-importing a corrected sheet did nothing at
    // all: the row matched by provider id, went `duplicate`, and stopped.
    const second = await runImport(
      editor.token,
      [row('150000,300000')],
      'update_existing',
      'u2.csv',
    );
    const job = await imports.getJob(second);
    expect(job.rowsByStatus.imported).toBe(1);

    const prices = await db
      .select()
      .from(schema.placePrices)
      .where(eq(schema.placePrices.placeId, place!.id));
    expect(prices.some((p) => p.priceMin === 150_000 && p.priceMax === 300_000)).toBe(true);

    // Still one canonical place — an update must never fork the catalog.
    const all = await db.select().from(schema.places).where(eq(schema.places.name, 'Quán Update'));
    expect(all).toHaveLength(1);
  });

  it('a place that changed hands goes to review instead of being overwritten', async () => {
    const editor = await createAdmin('upd-identity@gogo.local', 'editor');
    const ops = await createAdmin('upd-identity-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-owner',
      name: 'Cà Phê Cũ',
      lat: 10.82,
      lng: 106.74,
      ratingCount: 600,
      primaryType: 'cafe',
    });
    const row = `O-1,Cà Phê Cũ,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-owner,cafe,,,`;

    const first = await runImport(editor.token, [row], 'create_drafts', 'o1.csv');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${first}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    const [place] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Cà Phê Cũ'));

    // Same provider id, but the business behind it is new: reviews reset and
    // the category moved. Name similarity alone would have waved this through.
    places.seed({
      providerPlaceId: 'fake-owner',
      name: 'Karaoke Cũ',
      lat: 10.82,
      lng: 106.74,
      ratingCount: 9,
      primaryType: 'karaoke',
    });

    const second = await runImport(editor.token, [row], 'update_existing', 'o2.csv');
    const rows = await imports.listRows(second, { limit: 10, offset: 0 });
    expect(rows.items[0]!.status).toBe('needs_confirmation');
    expect(rows.items[0]!.errors.map((e) => e.code)).toContain('PLACE_IDENTITY_CHANGED');
    expect(rows.items[0]!.matchReasons).toEqual(
      expect.arrayContaining(['RATING_COUNT_RESET', 'PRIMARY_TYPE_CHANGED']),
    );

    // Nothing was written: the old editorial content still describes the old
    // business, and a human decides what happens to it.
    const [unchanged] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place!.id));
    expect(unchanged!.name).toBe('Cà Phê Cũ');
  });
});
