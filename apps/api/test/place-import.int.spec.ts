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
  process.env.GOOGLE_PLACES_API_KEY = '';
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

  // #274 — the HCM sheet that failed every row on ROW_ID_MISSING.
  it('imports a sheet with no source_row_id column, deriving row identity', async () => {
    const editor = await createAdmin('sheet-editor-norowid@gogo.local', 'editor');
    sheets.seed('3NoRowIdNoRowIdNoRowIdNoRowId1234567', 'HCM', [
      // The real failing sheet's headers, verbatim.
      ['name', 'category', 'district', 'google_maps_url', 'tags', 'source', 'notes', 'city'],
      [
        'Lacàph Coffee Experiences Space',
        'cafe',
        'District 1',
        'https://www.google.com/maps/search/?api=1&query=Lacaph+Coffee',
        'coffee,date,indoor',
        'Google Maps',
        'Specialty coffee',
        'Ho Chi Minh City',
      ],
      [
        'Quán Thứ Hai',
        'cafe',
        'District 3',
        'https://www.google.com/maps?place_id=fake-a',
        'coffee',
        'Google Maps',
        '',
        'Ho Chi Minh City',
      ],
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '3NoRowIdNoRowIdNoRowIdNoRowId1234567',
        sheets: ['HCM'],
        mode: 'dry_run',
      },
    });

    expect(res.statusCode).toBe(201);
    const job = res.json();
    // Before #274 both rows failed on ROW_ID_MISSING even though the service
    // went on to derive and store the very id the validator had rejected.
    expect(job.totals.failed).toBe(0);
    expect(job.totals.rows).toBe(2);

    const rows = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${job.id}/rows`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    const items = rows.json().items;
    expect(items.map((r: { sourceRowId: string }) => r.sourceRowId)).toEqual(['HCM#1', 'HCM#2']);
    for (const row of items) {
      expect(row.status).not.toBe('validation_failed');
      expect(row.errors).toEqual([]);
      expect(row.warnings.map((w: { code: string }) => w.code)).toContain('ROW_ID_DERIVED');
    }
  });

  it('keeps the create-time column diagnostics readable from the job detail', async () => {
    const editor = await createAdmin('sheet-editor-diagnostics@gogo.local', 'editor');
    sheets.seed('4DiagnosticsDiagnosticsDiag01234567', 'HCM', [
      ['name', 'category', 'tags', 'notes', 'city'],
      ['Quán A', 'cafe', 'coffee', 'ghi chú', 'Ho Chi Minh City'],
    ]);

    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '4DiagnosticsDiagnosticsDiag01234567',
        sheets: ['HCM'],
        mode: 'dry_run',
      },
    });
    expect(created.statusCode).toBe(201);

    // The wizard navigates away immediately, so the refetch is what an editor
    // actually reads. It used to carry neither field.
    const detail = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${created.json().id}`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });

    const body = detail.json();
    // Derivable on its own, so it is not the operator's problem to fix — the
    // per-row ROW_ID_DERIVED warning carries that fact instead.
    expect(body.missingRequiredColumns).not.toContain('HCM:source_row_id');
    // `notes` is not an alias of `note`; both columns are silently dropped
    // unless the job says so.
    expect(body.unmappedHeaders).toEqual(expect.arrayContaining(['HCM:tags', 'HCM:notes']));
    expect(body.unmappedHeaders).toEqual(created.json().unmappedHeaders);
  });

  it('lists only the required columns the operator must actually add', async () => {
    const editor = await createAdmin('sheet-editor-defaultcity@gogo.local', 'editor');
    // No `source_row_id` (derivable) and no `city` (defaulted below), so
    // neither is listed. `category` is: the mapping genuinely does not cover it.
    sheets.seed('5DefaultCityDefaultCityDefau1234567', 'HCM', [['name'], ['Quán B']]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '5DefaultCityDefaultCityDefau1234567',
        sheets: ['HCM'],
        mode: 'dry_run',
        defaultCity: 'Hồ Chí Minh',
      },
    });

    expect(res.statusCode).toBe(201);
    const missing = res.json().missingRequiredColumns;
    expect(missing).toEqual(['HCM:category']);
    // #286: the column is still missing and still worth naming — a sheet
    // without it depends entirely on Google being able to classify every row.
    // But it no longer fails the row at parse time, because the row names a
    // place the resolver can look up a few steps later.
    expect(res.json().totals.failed).toBe(0);
    const rows = await imports.listRows(res.json().id, { limit: 5, offset: 0 });
    expect(rows.items[0]!.warnings.map((w: { code: string }) => w.code)).toContain(
      'CATEGORY_PENDING_PROVIDER',
    );
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

// #276 — one canonical vocabulary, and no way to have a mapping ignored.
describe('PI-BE-019 — explicit column mapping is strict', () => {
  /** The enum the OpenAPI file publishes, read back through the wire. */
  const PUBLISHED_FIELDS = [
    'source_row_id',
    'name',
    'city',
    'district',
    'google_maps_url',
    'google_maps_query',
    'category',
    'category_raw',
    'price_min',
    'price_max',
    'price_unit',
    'price_raw',
    'audiences',
    'audiences_raw',
    'vibes',
    'vibes_raw',
    'highlight',
    'note',
  ];

  it('accepts every field the contract publishes', async () => {
    const editor = await createAdmin('mapping-all@gogo.local', 'editor');
    // Deliberately opaque headers: nothing here auto-detects, so the mapping
    // is the only thing that can have placed them.
    const headers = PUBLISHED_FIELDS.map((_, i) => `col_${i}`);
    const mapping = Object.fromEntries(PUBLISHED_FIELDS.map((f, i) => [`col_${i}`, f]));
    sheets.seed('6MappingAllFieldsMappingAll012345678', 'HCM', [
      headers,
      headers.map((_, i) => (PUBLISHED_FIELDS[i] === 'category' ? 'cafe' : `v${i}`)),
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '6MappingAllFieldsMappingAll012345678',
        sheets: ['HCM'],
        mode: 'dry_run',
        mapping,
      },
    });

    expect(res.statusCode).toBe(201);
    // Every published value was honoured; none fell through to auto-detection.
    expect(res.json().unmappedHeaders).toEqual([]);
  });

  it('normalises the legacy spellings the shipped CMS emitted', async () => {
    const editor = await createAdmin('mapping-legacy-sheet@gogo.local', 'editor');
    sheets.seed('7MappingLegacyMappingLegacy01234567', 'HCM', [
      ['Link', 'Tên', 'category', 'city'],
      ['https://www.google.com/maps?place_id=fake-a', 'Quán A', 'cafe', 'Hồ Chí Minh'],
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '7MappingLegacyMappingLegacy01234567',
        sheets: ['HCM'],
        mode: 'dry_run',
        // `/v1` accepted this; it must keep working, now actually honoured.
        mapping: { Link: 'googleMapsUrl', Tên: 'name' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().unmappedHeaders).toEqual([]);

    const rows = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${res.json().id}/rows`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    const normalized = rows.json().items[0].normalized;
    expect(normalized.name).toBe('Quán A');
    // Proof the alias was honoured rather than merely tolerated: the URL only
    // lands here if `Link` resolved to `google_maps_url`.
    expect(normalized.googleMapsUrl).toContain('place_id=fake-a');
  });

  it('still accepts the three retired fields, and says the column was skipped', async () => {
    const editor = await createAdmin('mapping-retired@gogo.local', 'editor');
    sheets.seed('8MappingRetiredMappingRetir01234567', 'HCM', [
      ['Địa chỉ', 'name', 'category', 'city'],
      ['126 NTMK', 'Quán A', 'cafe', 'Hồ Chí Minh'],
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '8MappingRetiredMappingRetir01234567',
        sheets: ['HCM'],
        mode: 'dry_run',
        mapping: { 'Địa chỉ': 'address' },
      },
    });

    // `/v1` answered 200 and ignored it; that stays true.
    expect(res.statusCode).toBe(201);
    expect(res.json().totals.failed).toBe(0);
    // But the outcome is visible now instead of silent.
    expect(res.json().unmappedHeaders).toContain('HCM:Địa chỉ');
  });

  it('accepts every mapping value the shipped CMS could emit', async () => {
    const editor = await createAdmin('mapping-shipped@gogo.local', 'editor');
    sheets.seed('9MappingShippedMappingShipp01234567', 'HCM', [
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
      ['Quán A', '126 NTMK', 'HCM', 'Q1', '', 'cafe', '', '', '', '', ''],
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '9MappingShippedMappingShipp01234567',
        sheets: ['HCM'],
        mode: 'dry_run',
        // MAPPABLE_FIELDS + HEADER_HINTS from every GoGo-CMS commit that has
        // ever contained them. Not one of these may 400.
        mapping: {
          a: 'name',
          b: 'address',
          c: 'city',
          d: 'district',
          e: 'googleMapsUrl',
          f: 'category',
          g: 'priceMin',
          h: 'priceMax',
          i: 'phone',
          j: 'website',
          k: 'note',
        },
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('accepts an unknown value and leaves its column unmapped', async () => {
    const editor = await createAdmin('mapping-unknown@gogo.local', 'editor');
    sheets.seed('4MappingUnknownMappingUnkno01234567', 'HCM', [
      ['Tên địa điểm', 'category', 'city'],
      ['Quán A', 'cafe', 'Hồ Chí Minh'],
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '4MappingUnknownMappingUnkno01234567',
        sheets: ['HCM'],
        mode: 'dry_run',
        mapping: { 'Tên địa điểm': 'placeName' },
      },
    });

    // `/v1` answered 200 for any string here, and still does.
    expect(res.statusCode).toBe(201);
    // `Tên địa điểm` would auto-detect to `name`; it must not, because the
    // operator named the column and got it wrong.
    expect(res.json().unmappedHeaders).toContain('HCM:Tên địa điểm');

    const rows = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${res.json().id}/rows`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(rows.json().items[0].normalized.name).toBeNull();
  });

  it('still refuses a mapping that is not a JSON object of strings', async () => {
    const editor = await createAdmin('mapping-bad-file@gogo.local', 'editor');
    const body = multipart(
      { mode: 'dry_run', mapping: '{not json' },
      { name: 'mapping3.csv', content: csv(['M-3,Quán A,Hồ Chí Minh,Quận 1,,cafe,,,']) },
    );

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), ...body.headers },
      payload: body.payload,
    });

    // Unchanged from `/v1`: the shape was always enforced.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('MAPPING_INVALID');
  });

  it('still reports malformed JSON as a different mistake', async () => {
    const editor = await createAdmin('mapping-bad-json@gogo.local', 'editor');
    const body = multipart(
      { mode: 'dry_run', mapping: '{not json' },
      { name: 'mapping2.csv', content: csv(['M-2,Quán B,Hồ Chí Minh,Quận 1,,cafe,,,']) },
    );

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('MAPPING_INVALID');
  });

  it('lets an explicit mapping override what auto-detection would pick', async () => {
    const editor = await createAdmin('mapping-override@gogo.local', 'editor');
    // `Tên địa điểm` auto-detects to `name`; the operator says it is the
    // highlight column and `Ghi chú` holds the real name.
    sheets.seed('8MappingOverrideMappingOver01234567', 'HCM', [
      ['Tên địa điểm', 'Ghi chú', 'category', 'city'],
      ['Bò né sốt tiêu', 'Quán Ăn Sáng', 'cafe', 'Hồ Chí Minh'],
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '8MappingOverrideMappingOver01234567',
        sheets: ['HCM'],
        mode: 'dry_run',
        mapping: { 'Tên địa điểm': 'highlight', 'Ghi chú': 'name' },
      },
    });

    expect(res.statusCode).toBe(201);
    const rows = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${res.json().id}/rows`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    const normalized = rows.json().items[0].normalized;
    expect(normalized.name).toBe('Quán Ăn Sáng');
    expect(normalized.highlight).toBe('Bò né sốt tiêu');
  });

  it('auto-detects the columns the mapping says nothing about', async () => {
    const editor = await createAdmin('mapping-partial@gogo.local', 'editor');
    sheets.seed('9MappingPartialMappingPartia1234567', 'HCM', [
      ['Tên địa điểm', 'category', 'city'],
      ['Quán A', 'cafe', 'Hồ Chí Minh'],
    ]);

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: '9MappingPartialMappingPartia1234567',
        sheets: ['HCM'],
        mode: 'dry_run',
        mapping: { 'Tên địa điểm': 'name' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().unmappedHeaders).toEqual([]);
    const rows = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${res.json().id}/rows`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    // `category` and `city` were never named, and still landed.
    expect(rows.json().items[0].normalized.categoryKey).toBe('cafe');
    expect(rows.json().items[0].normalized.city).toBe('Hồ Chí Minh');
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

  /**
   * #337 review item 2 — a DB-first duplicate row skips category derivation, so
   * this proves nothing downstream of `duplicate` needed the derived category.
   *
   * Deriving one costs an Enterprise `details` call, and a duplicate row never
   * creates a place to put it on. The row the sheet describes has no category
   * and a Google type the taxonomy does not map, which before #337 made it
   * `validation_failed` on CATEGORY_REQUIRED — a worse answer than `duplicate`,
   * since the place it duplicates is already published and categorised.
   */
  it('a categoryless duplicate row still resolves as a duplicate, and stays usable', async () => {
    const editor = await createAdmin('dup-nocat-editor@gogo.local', 'editor');
    const ops = await createAdmin('dup-nocat-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-dup-nocat',
      name: 'Quán Không Category',
      lat: 10.81,
      lng: 106.73,
      // Nothing the taxonomy can map, so a derivation attempt could not rescue
      // the row even if one were made.
      primaryType: 'plumber',
      types: ['plumber', 'point_of_interest', 'establishment'],
    });

    const first = await createJob(editor.token, [
      'DNC-1,Quán Không Category,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-dup-nocat,cafe,,,',
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

    // Second sheet: same place, category column left blank.
    const second = await createJob(editor.token, [
      'DNC-2,Quán Không Category,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-dup-nocat,,,,',
    ]);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${second.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    places.tiersRequested.length = 0;
    await imports.processJob(second.id);

    const job = await imports.getJob(second.id);
    expect(job.rowsByStatus.duplicate, 'duplicate, not validation_failed').toBe(1);
    expect(job.rowsByStatus.validation_failed ?? 0).toBe(0);
    expect(places.tiersRequested, 'a known id costs no Details').toEqual([]);

    // Downstream handling of that row needs no category: it reads back with the
    // place it duplicates, carries no error, and publish leaves it alone
    // because publish only ever touches `ready` rows.
    const rows = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${second.id}/rows`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    const row = rows.json().items[0];
    expect(row.status).toBe('duplicate');
    expect(row.matchedPlaceId).toBeTruthy();
    expect(row.errors).toEqual([]);

    const published = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${second.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(published.json().created, 'a duplicate row creates nothing').toBe(0);
    expect(published.json().failed).toEqual([]);

    const counted = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.places)
      .where(eq(schema.places.name, 'Quán Không Category'));
    expect(counted[0]?.n, 'still exactly one canonical place').toBe(1);
  });

  /**
   * COST-BE-005 (#338) — the bulk pipeline's two stages want different fields,
   * and now pay different prices for them.
   *
   * Asserted on `tiersRequested` rather than on a mask string, because the
   * question a reviewer actually has is not "what does `core` contain?" (the
   * unit spec pins that) but "which SKU does this flow buy?". A regression
   * here is a bill, and it is invisible in every other test: resolving at
   * `quality` produces exactly the same row outcomes as resolving at `core`.
   */
  it('resolves a row at core and pays Enterprise only at publish', async () => {
    const editor = await createAdmin('tier-editor@gogo.local', 'editor');
    const ops = await createAdmin('tier-ops@gogo.local', 'ops_admin');
    places.seed({ providerPlaceId: 'fake-tier', name: 'Quán Phân Tầng', lat: 10.78, lng: 106.7 });

    const job = await createJob(editor.token, [
      'TIER-1,Quán Phân Tầng,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-tier,cafe,100000,200000,per_person',
    ]);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });

    places.tiersRequested.length = 0;
    await imports.processJob(job.id);
    // Resolve settles an identity, a category and a confidence. Every field it
    // reads is a Pro field.
    expect(places.tiersRequested, 'resolve buys Pro, not Enterprise').toEqual(['core']);

    places.tiersRequested.length = 0;
    const published = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(published.json().created).toBe(1);
    // Publish writes the catalogue row, and that row carries rating, review
    // count, price level and the weekly hours.
    expect(places.tiersRequested, 'publish buys Enterprise, because it keeps it').toEqual([
      'quality',
    ]);

    const [place] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Quán Phân Tầng'));
    // The cheaper resolve did not cost the catalogue anything: the row holds
    // the same provider facts it always did.
    expect(place!.rating).toBe('4.40');
    expect(place!.ratingCount).toBe(250);
    expect(place!.priceLevel).toBe(2);

    const [source] = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'fake-tier'));
    expect(source!.fetchTier, 'the row records the tier that produced it').toBe('quality');
  });

  it('update_existing resolves at quality — it writes what it reads', async () => {
    const editor = await createAdmin('tier-upd-editor@gogo.local', 'editor');
    const ops = await createAdmin('tier-upd-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-tier-upd',
      name: 'Quán Cập Nhật',
      lat: 10.78,
      lng: 106.7,
    });

    const row =
      'TIER-2,Quán Cập Nhật,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-tier-upd,cafe,,,';
    const first = await createJob(editor.token, [row]);
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

    const second = await createJob(editor.token, [row], 'update_existing');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${second.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    places.tiersRequested.length = 0;
    await imports.processJob(second.id);

    // This mode overwrites `rating`, `ratingCount` and `priceLevel` on a live
    // catalogue row. A `core` fetch would write `null`, `0` and `null` over
    // them — a cheaper call that destroys data is not a saving.
    expect(places.tiersRequested, 'the refreshing mode pays for what it refreshes').toEqual([
      'quality',
    ]);
    const [place] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Quán Cập Nhật'));
    expect(place!.rating).toBe('4.40');
    expect(place!.ratingCount).toBe(250);
  });

  /**
   * COST-BE-006 (#339) / ADR-0006 §8 — an identity change routes the *place*
   * to review, not just the import row that noticed it.
   */
  it('a place that may have changed hands leaves circulation', async () => {
    const editor = await createAdmin('idc-editor@gogo.local', 'editor');
    const ops = await createAdmin('idc-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-identity',
      name: 'Nhà Hàng Sen Việt',
      lat: 10.78,
      lng: 106.7,
    });

    const row =
      'IDC-1,Nhà Hàng Sen Việt,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-identity,restaurant,,,';
    // `publish_approved`, so the place really reaches `published` — the state
    // this rule exists to take it out of.
    const first = await createJob(editor.token, [row], 'publish_approved');
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

    // ADM-009 (#462): a newly imported place is never published by the import —
    // nobody has verified its administrative mapping — so it lands in `review`.
    // This test is about what happens to a place that has *changed hands* while
    // in circulation, so the precondition is set directly rather than by routing
    // the import through a reviewer it is not testing.
    const [imported] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Nhà Hàng Sen Việt'));
    expect(imported!.status, 'the import ingests it, deferring publication').toBe('review');
    await db
      .update(schema.places)
      .set({ status: 'published' })
      .where(eq(schema.places.id, imported!.id));
    const [published] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, imported!.id));
    expect(published!.status, 'precondition: it is published and being served').toBe('published');

    // The same Google id, describing a different business: a name sharing
    // nothing with the old one, and the review count reset the way Google
    // resets it for a new listing.
    places.seed({
      providerPlaceId: 'fake-identity',
      name: 'Karaoke Hoàng Kim',
      lat: 10.78,
      lng: 106.7,
      ratingCount: 4,
      primaryType: 'karaoke',
    });

    const second = await createJob(editor.token, [row], 'update_existing');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${second.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(second.id);

    const [after] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, published!.id));
    // Search reads `places.status`. Holding the finding on the import row
    // alone left the suspect place published: still searched, still suggested,
    // still plannable, while a job artifact nobody opens carried the only
    // record that it might now be a different business.
    expect(after!.status, 'the place is out of circulation until an editor rules').toBe('review');
    // …and nothing was overwritten. Taking the new name onto the old
    // highlight, price and category produces a record that lies.
    expect(after!.name).toBe('Nhà Hàng Sen Việt');

    const audit = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, published!.id));
    const entry = audit.find((a) => a.action === 'place.identity_review_required');
    // The diff is what an editor decides on. `place_ingest_rows` records the
    // finding for the job, but a job is transient and the editor who opens the
    // place months later has no reason to go looking through one.
    expect(entry, 'an editor is told why, on the place').toBeTruthy();
    const diff = entry!.diff as { reasons: string[]; name: { before: string; after: string } };
    expect(diff.reasons.length).toBeGreaterThan(0);
    expect(diff.name).toEqual({ before: 'Nhà Hàng Sen Việt', after: 'Karaoke Hoàng Kim' });
    expect(entry!.actorType, 'the importer noticed; a person still has to rule').toBe('system');
  });

  /**
   * COST-BE-006 (#339) — the third door, and the debt behind it.
   *
   * A closed place may reach the catalogue: it is then hidden by the
   * `source_status` filter. `FUTURE_OPENING` cannot be hidden that way,
   * because `provider_source_status` has no value for it (migrations 0002,
   * 0007) and ADR-0006 §9.5 forbids adding one while §9.6 is unsigned. So the
   * refusal has to happen before the row is written.
   */
  it('bulk publish refuses a place that has not opened yet', async () => {
    const editor = await createAdmin('fo-editor@gogo.local', 'editor');
    const ops = await createAdmin('fo-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-future',
      name: 'Quán Sắp Mở',
      lat: 10.78,
      lng: 106.7,
      businessStatus: 'FUTURE_OPENING',
    });

    const job = await createJob(editor.token, [
      'FO-1,Quán Sắp Mở,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-future,cafe,,,',
    ]);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(job.id);

    const published = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });

    expect(published.json().created, 'nothing unopened reaches the catalogue').toBe(0);
    expect(published.json().failed).toEqual([
      expect.objectContaining({ code: 'PLACE_NOT_YET_OPEN' }),
    ]);
    const rows = await db.select().from(schema.places).where(eq(schema.places.name, 'Quán Sắp Mở'));
    expect(rows, 'no place row, so nothing to hide from search later').toEqual([]);
  });

  it('records the lossy status mapping that ADR-0006 §9.5 currently forces', async () => {
    // Not a feature — a debt, pinned so it is visible and so the migration
    // that closes it has a test to flip. `provider_source_status` cannot say
    // `future_opening`, so `upsertProviderSource` flattens it to `unknown`,
    // losing the difference between "Google says this has not opened" and "we
    // do not know". `unknown` is the safe direction: it is the one value
    // DB-first declines to map, so such a row is re-asked rather than served.
    const editor = await createAdmin('fo-map-editor@gogo.local', 'editor');
    const ops = await createAdmin('fo-map-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-future-map',
      name: 'Quán Đổi Trạng Thái',
      lat: 10.78,
      lng: 106.7,
    });

    const row =
      'FO-2,Quán Đổi Trạng Thái,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-future-map,cafe,,,';
    const job = await createJob(editor.token, [row], 'publish_approved');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(job.id);
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });

    // The place exists and is `active` while Google calls it operational.
    const [live] = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'fake-future-map'));
    expect(live!.sourceStatus).toBe('active');

    // Google now says it has not opened. `update_existing` is the one mode
    // that re-writes the provider row.
    places.seed({
      providerPlaceId: 'fake-future-map',
      name: 'Quán Đổi Trạng Thái',
      lat: 10.78,
      lng: 106.7,
      businessStatus: 'FUTURE_OPENING',
    });
    const second = await createJob(editor.token, [row], 'update_existing');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${second.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(second.id);

    const [after] = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'fake-future-map'));
    // `unknown`, not `active` — the catalogue must not go on calling it open.
    // When §9.6 is signed this becomes `future_opening` and this assertion is
    // the one that has to change.
    expect(after!.sourceStatus).toBe('unknown');
    expect(
      after!.sourceStatus,
      'never `active`: that would put an unopened place back into search',
    ).not.toBe('active');
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

  /**
   * ADM-009 (#462) — bulk import may not publish an administratively unverified
   * place, and must say so rather than reporting it as published.
   */
  describe('publish_approved is a request, not a permission', () => {
    it('ingests a new place into review and defers its publication', async () => {
      const editor = await createAdmin('adm009-import-editor@gogo.local', 'editor');
      const ops = await createAdmin('adm009-import-ops@gogo.local', 'ops_admin');
      places.seed({
        providerPlaceId: 'fake-adm009-defer',
        name: 'Quán Chờ Duyệt',
        lat: 10.78,
        lng: 106.7,
      });
      const row =
        'ADM9-1,Quán Chờ Duyệt,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-adm009-defer,cafe,,,';
      const job = await createJob(editor.token, [row], 'publish_approved');
      await api().inject({
        method: 'POST',
        url: `/v1/cms/place-imports/${job.id}/start`,
        remoteAddress: ip(),
        headers: auth(editor.token),
      });
      await imports.processJob(job.id);
      await api().inject({
        method: 'POST',
        url: `/v1/cms/place-imports/${job.id}/publish`,
        remoteAddress: ip(),
        headers: auth(ops.token),
        payload: {},
      });

      const [created] = await db
        .select()
        .from(schema.places)
        .where(eq(schema.places.name, 'Quán Chờ Duyệt'));
      // Ingested, in front of a reviewer, and not live.
      expect(created!.status).toBe('review');
      expect(created!.administrativeMappingStatus).toBe('UNMAPPED');

      const detail = await api().inject({
        method: 'GET',
        url: `/v1/cms/place-imports/${job.id}`,
        remoteAddress: ip(),
        headers: auth(editor.token),
      });
      const publication = detail.json().publication;
      // The result never calls a deferred row published.
      expect(publication.published).toBe(0);
      expect(publication.requested).toBe(1);
      expect(publication.deferred).toBe(1);
      // No administrative dataset exists in this suite, which is its own reason.
      expect(publication.noActiveAdministrativeDataset + publication.mappingUnverified).toBe(1);

      const [ingestRow] = await db
        .select()
        .from(schema.placeIngestRows)
        .where(eq(schema.placeIngestRows.jobId, job.id));
      expect(ingestRow!.publicationOutcome).not.toBe('published');
      expect(ingestRow!.status).toBe('imported');

      // The deferral is audited as what it is.
      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'place.publication_deferred'));
      expect(audits.length).toBeGreaterThan(0);
    }, 120_000);

    it('does not fail the import merely because publication was deferred', async () => {
      const editor = await createAdmin('adm009-import-editor2@gogo.local', 'editor');
      places.seed({
        providerPlaceId: 'fake-adm009-ok',
        name: 'Quán Vẫn Nhập',
        lat: 10.78,
        lng: 106.7,
      });
      const row =
        'ADM9-2,Quán Vẫn Nhập,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-adm009-ok,cafe,,,';
      const job = await createJob(editor.token, [row], 'publish_approved');
      await api().inject({
        method: 'POST',
        url: `/v1/cms/place-imports/${job.id}/start`,
        remoteAddress: ip(),
        headers: auth(editor.token),
      });
      await imports.processJob(job.id);

      const detail = await api().inject({
        method: 'GET',
        url: `/v1/cms/place-imports/${job.id}`,
        remoteAddress: ip(),
        headers: auth(editor.token),
      });
      // A deferred publication is a successful import of a place that is not yet
      // live, not a failed row.
      expect(detail.json().totals.failed).toBe(0);
      expect(
        detail.json().rowsByStatus.ready ?? detail.json().rowsByStatus.imported,
      ).toBeGreaterThan(0);
    }, 120_000);
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
    // 90 resolvable rows + 10 that fail validation up front. A district and
    // nothing else: since #286 a row with a name is no longer failed for a
    // missing category (the resolver may supply one), so a row that must fail
    // at parse time has to be one nothing can be resolved from at all.
    const bad = Array.from({ length: 10 }, (_, i) => `,,,Quận Bad ${i},,,,,`);
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

// --- #286 — category derived from Google `types[]` --------------------------

describe('PI-BE-023 — the sheet stops guessing the category', () => {
  /** The HCM sheet as it stands today, minus the column this issue removes. */
  const HCM_HEADERS = ['name', 'district', 'google_maps_url', 'tags', 'source', 'notes', 'city'];

  async function runSheet(token: string, spreadsheetId: string, rows: string[][]) {
    sheets.seed(spreadsheetId, 'HCM', [HCM_HEADERS, ...rows]);
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { spreadsheetUrl: spreadsheetId, sheets: ['HCM'], mode: 'create_drafts' },
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

  const sheetRow = (name: string, placeId: string) => [
    name,
    'District 1',
    `https://www.google.com/maps?place_id=${placeId}`,
    'coffee,date,indoor',
    'Google Maps',
    'Specialty coffee',
    'Ho Chi Minh City',
  ];

  it('imports the HCM sheet with no category column at all', async () => {
    const editor = await createAdmin('cat-derive@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-lacaph',
      name: 'Lacàph Coffee Experiences Space',
      lat: 10.7845,
      lng: 106.6912,
      primaryType: 'coffee_shop',
      types: ['coffee_shop', 'cafe', 'food', 'point_of_interest'],
      googleMapsUri: 'https://maps.google.com/?cid=99',
    });

    const jobId = await runSheet(editor.token, 'C1DeriveCategoryDeriveCateg01234567', [
      sheetRow('Lacàph Coffee Experiences Space', 'fake-lacaph'),
    ]);

    const rows = await imports.listRows(jobId, { limit: 10, offset: 0 });
    const row = rows.items[0]!;

    // Before this issue the row never reached the provider: CATEGORY_REQUIRED
    // failed it at parse time, which is what made an operator type a category
    // by hand — and `rooftop`/`attraction` is what they typed.
    expect(row.status).toBe('ready');
    expect(row.errors).toEqual([]);
    expect(row.warnings.map((w: { code: string }) => w.code)).toContain('CATEGORY_DERIVED');
    expect((row.normalized as { categoryKey: string }).categoryKey).toBe('cafe');
  });

  it('names where the category came from, so a row can be argued with', async () => {
    const editor = await createAdmin('cat-derive-msg@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-derive-msg',
      name: 'Quán Nguồn',
      lat: 10.79,
      lng: 106.69,
      primaryType: 'coffee_shop',
      types: ['coffee_shop', 'cafe'],
    });

    const jobId = await runSheet(editor.token, 'C2DeriveMessageDeriveMessa01234567', [
      sheetRow('Quán Nguồn', 'fake-derive-msg'),
    ]);
    const rows = await imports.listRows(jobId, { limit: 10, offset: 0 });
    const derived = rows.items[0]!.warnings.find(
      (w: { code: string }) => w.code === 'CATEGORY_DERIVED',
    );

    expect(derived?.message).toContain('cafe');
    expect(derived?.message).toContain('google_primary_type');
    expect(derived?.message).toContain('coffee_shop');
  });

  it('never overwrites a category the operator supplied', async () => {
    const editor = await createAdmin('cat-explicit@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-explicit',
      name: 'Quán Chọn Tay',
      lat: 10.77,
      lng: 106.71,
      primaryType: 'coffee_shop',
      types: ['coffee_shop', 'cafe'],
    });

    // Sheet says `restaurant`; Google would have said `cafe`. Taxonomy is
    // GoGo-owned (ADR-0006 §3) and the editor keeps it.
    sheets.seed('C3ExplicitCategoryExplicitC01234567', 'HCM', [
      [...HCM_HEADERS, 'category'],
      [...sheetRow('Quán Chọn Tay', 'fake-explicit'), 'restaurant'],
    ]);
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: 'C3ExplicitCategoryExplicitC01234567',
        sheets: ['HCM'],
        mode: 'create_drafts',
      },
    });
    const jobId = created.json().id as string;
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(jobId);

    const rows = await imports.listRows(jobId, { limit: 10, offset: 0 });
    const row = rows.items[0]!;
    expect((row.normalized as { categoryKey: string }).categoryKey).toBe('restaurant');
    expect(row.warnings.map((w: { code: string }) => w.code)).not.toContain('CATEGORY_DERIVED');
  });

  it('asks for a category only when Google could not supply one', async () => {
    const editor = await createAdmin('cat-underivable@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-attraction',
      name: 'Bưu điện Trung tâm Sài Gòn',
      lat: 10.78,
      lng: 106.699,
      primaryType: 'tourist_attraction',
      types: ['tourist_attraction', 'point_of_interest', 'establishment'],
    });

    const jobId = await runSheet(editor.token, 'C4UnderivableUnderivableUn01234567', [
      sheetRow('Bưu điện Trung tâm Sài Gòn', 'fake-attraction'),
    ]);

    const rows = await imports.listRows(jobId, { limit: 10, offset: 0 });
    const row = rows.items[0]!;
    const error = row.errors.find((e: { code: string }) => e.code === 'CATEGORY_REQUIRED');

    expect(row.status).toBe('validation_failed');
    // `tourist_attraction` is not silently turned into `park`: the row says
    // what Google called the place and asks a human for the category.
    expect(error?.message).toContain('tourist_attraction');
    expect((row.normalized as { categoryKey: string | null }).categoryKey).toBeNull();
  });

  it('records the tier it paid for and the provider URI it was given', async () => {
    const editor = await createAdmin('cat-provenance@gogo.local', 'editor');
    const ops = await createAdmin('cat-provenance-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-provenance',
      name: 'Quán Nguồn Gốc',
      lat: 10.762,
      lng: 106.682,
      primaryType: 'cafe',
      types: ['cafe', 'food'],
      googleMapsUri: 'https://maps.google.com/?cid=555',
    });

    const jobId = await runSheet(editor.token, 'C5ProvenanceProvenancePro01234567', [
      sheetRow('Quán Nguồn Gốc', 'fake-provenance'),
    ]);
    const published = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(published.statusCode).toBe(201);

    const [source] = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'fake-provenance'));

    // `fetch_tier` used to be the string 'quality' regardless of what was
    // fetched, and `provider_uri` was never written at all — the adapter did
    // not ask Google for `googleMapsUri`.
    expect(source!.fetchTier).toBe('quality');
    expect(source!.providerUri).toBe('https://maps.google.com/?cid=555');
    expect(source!.primaryType).toBe('cafe');
  });
});

/**
 * PI-BE-024 — a sheet identifies its places, and says so plainly.
 *
 * The audit found that the only way to state a Google Place ID was to wrap it
 * in `https://www.google.com/maps?place_id=<ID>` so `parseMapsUrl` could unwrap
 * it again. Every fixture above still does exactly that, which is the clearest
 * evidence there was: the tests had adopted the workaround.
 */
describe('PI-BE-024 — Place ID identity', () => {
  const HEADERS = ['source_row_id', 'name', 'google_maps_url', 'google_place_id', 'category'];

  async function runRows(token: string, spreadsheetId: string, rows: string[][]) {
    sheets.seed(spreadsheetId, 'ID', [HEADERS, ...rows]);
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { spreadsheetUrl: spreadsheetId, sheets: ['ID'], mode: 'create_drafts' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = created.json();
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(token),
    });
    await imports.processJob(job.id);
    const listed = await imports.listRows(job.id as string, { limit: 20, offset: 0 });
    return { jobId: job.id as string, rows: listed.items };
  }

  it('resolves a row that carries only a Place ID, with no city and no link', async () => {
    const editor = await createAdmin('id-only@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-id-only',
      name: 'Quán Chỉ Có ID',
      lat: 10.78,
      lng: 106.7,
      primaryType: 'cafe',
      types: ['cafe'],
    });

    const { rows } = await runRows(editor.token, 'IdOnlyIdOnlyIdOnlyIdOnly0123456789', [
      ['R1', '', '', 'fake-id-only', 'cafe'],
    ]);

    expect(rows[0]!.status).toBe('ready');
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.resolvedGooglePlaceId).toBe('fake-id-only');
  });

  it('accepts a link and an id that name the same place', async () => {
    const editor = await createAdmin('id-agree@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-agree',
      name: 'Quán Khớp',
      lat: 10.77,
      lng: 106.69,
      primaryType: 'cafe',
      types: ['cafe'],
    });

    const { rows } = await runRows(editor.token, 'AgreeAgreeAgreeAgreeAgree012345678', [
      ['R1', '', 'https://www.google.com/maps?place_id=fake-agree', 'fake-agree', 'cafe'],
    ]);

    expect(rows[0]!.status).toBe('ready');
    expect(rows[0]!.resolvedGooglePlaceId).toBe('fake-agree');
  });

  it('compares an explicit query_place_id locally, spending nothing', async () => {
    const editor = await createAdmin('id-querypid@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-querypid',
      name: 'Quán Query Place Id',
      lat: 10.775,
      lng: 106.695,
      primaryType: 'cafe',
      types: ['cafe'],
    });

    // The shape Google's Share button produces for a search result.
    const before = places.tiersRequested.length;
    const { rows } = await runRows(editor.token, 'QueryPidQueryPidQueryPidQueryPid01', [
      [
        'R1',
        '',
        'https://www.google.com/maps/search/?api=1&query=Qu%C3%A1n&query_place_id=fake-querypid',
        'fake-querypid',
        'cafe',
      ],
    ]);

    expect(rows[0]!.status).toBe('ready');
    expect(rows[0]!.resolvedGooglePlaceId).toBe('fake-querypid');
    // One Details call for the place itself — none for establishing agreement,
    // because two strings were compared.
    expect(places.tiersRequested.length - before).toBe(1);
  });

  it('refuses a link and an id that name different places, before paying Google', async () => {
    const editor = await createAdmin('id-mismatch@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'fake-left', name: 'Bên Trái', lat: 10.77, lng: 106.69 });
    places.seed({ providerPlaceId: 'fake-right', name: 'Bên Phải', lat: 10.78, lng: 106.7 });

    const before = places.tiersRequested.length;
    const { rows } = await runRows(editor.token, 'MismatchMismatchMismatch0123456789', [
      ['R1', '', 'https://www.google.com/maps?query_place_id=fake-left', 'fake-right', 'cafe'],
    ]);

    expect(rows[0]!.status).toBe('validation_failed');
    expect(rows[0]!.errors.map((e: { code: string }) => e.code)).toEqual(['PLACE_ID_URL_MISMATCH']);
    // The disagreement is arithmetic on two strings; nothing was bought to find
    // it. Expanding the link is a redirect hop, not a Places request.
    expect(places.tiersRequested.length).toBe(before);
    expect(rows[0]!.matchedPlaceId).toBeNull();
  });

  /**
   * The shape the audit found in the wild: `maps.app.goo.gl/<code>` expands to
   * `/maps/place/<name>/data=!3m1!4b1!4m6…`, whose `data` blob holds a hex
   * feature id — not a Places API Place ID. Nothing in that URL can be compared
   * with the column, so agreement has to be resolved rather than parsed.
   */
  describe('a URL with no extractable Place ID', () => {
    it('resolves the link and compares the resolved id', async () => {
      const editor = await createAdmin('id-resolve-agree@gogo.local', 'editor');
      places.seed({
        providerPlaceId: 'fake-dataurl',
        name: 'Zyxwv Quánduynhat',
        lat: 10.7845,
        lng: 106.6912,
        primaryType: 'cafe',
        types: ['cafe'],
      });

      const before = places.tiersRequested.length;
      const { rows } = await runRows(editor.token, 'DataUrlDataUrlDataUrlDataUrl01234', [
        [
          'R1',
          '',
          'https://www.google.com/maps/place/Zyxwv+Qu%C3%A1nduynhat/@10.7845,106.6912,17z/data=!3m1!4b1!4m6!3m5!1s0x317529292e8d3dd1:0x123',
          'fake-dataurl',
          'cafe',
        ],
      ]);

      expect(rows[0]!.status).toBe('ready');
      expect(rows[0]!.resolvedGooglePlaceId).toBe('fake-dataurl');
      // Exactly the resolution that established agreement — and no second
      // fetch afterwards "using the supplied id", which would buy the same
      // answer twice.
      expect(places.tiersRequested.length - before).toBe(1);
    });

    it('refuses when the resolved id is not the declared one', async () => {
      const editor = await createAdmin('id-resolve-clash@gogo.local', 'editor');
      places.seed({
        providerPlaceId: 'fake-resolved-other',
        name: 'Wxyzq Khacbiet',
        lat: 10.781,
        lng: 106.688,
        primaryType: 'cafe',
        types: ['cafe'],
      });
      places.seed({
        providerPlaceId: 'fake-declared-other',
        name: 'Một Nơi Khác Hẳn',
        lat: 21.02,
        lng: 105.8,
      });

      const { rows } = await runRows(editor.token, 'DataClashDataClashDataClash012345', [
        [
          'R1',
          '',
          'https://www.google.com/maps/place/Wxyzq+Khacbiet/@10.781,106.688,17z/data=!4m6!3m5!1s0x31752:0x9',
          'fake-declared-other',
          'cafe',
        ],
      ]);

      expect(rows[0]!.status).toBe('validation_failed');
      expect(rows[0]!.errors.map((e: { code: string }) => e.code)).toEqual([
        'PLACE_ID_URL_MISMATCH',
      ]);
    });

    it('refuses when the link names nothing GoGo can resolve', async () => {
      const editor = await createAdmin('id-unverifiable@gogo.local', 'editor');
      places.seed({
        providerPlaceId: 'fake-unverifiable',
        name: 'Quán Có Thật',
        lat: 10.79,
        lng: 106.7,
      });

      // Nothing seeded answers this name, so resolution comes back UNRESOLVED.
      const { rows } = await runRows(editor.token, 'UnverifiableUnverifiable01234567', [
        [
          'R1',
          '',
          'https://www.google.com/maps/place/Khong+Ai+Tim+Duoc+Cho+Nay+Dau/@1.0,1.0,17z/data=!4m2',
          'fake-unverifiable',
          'cafe',
        ],
      ]);

      // The failure that matters: finding no second id is not agreement, so the
      // row must not be filed under the declared one on the strength of it.
      expect(rows[0]!.status).toBe('validation_failed');
      expect(rows[0]!.errors.map((e: { code: string }) => e.code)).toEqual([
        'PLACE_ID_URL_UNVERIFIABLE',
      ]);
      expect(rows[0]!.resolvedGooglePlaceId).toBeNull();
    });
  });

  it('expands a maps.app.goo.gl short link and compares what it lands on', async () => {
    const editor = await createAdmin('id-shortlink@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-shortlink',
      name: 'Quán Link Rút Gọn',
      lat: 21.03,
      lng: 105.81,
      primaryType: 'cafe',
      types: ['cafe'],
    });

    // The redirect walk is SSRF-guarded and goes through global fetch, so the
    // hop is stubbed rather than the parser bypassed: this exercises the real
    // `expandShortLink`, allowlist and all.
    const realFetch = globalThis.fetch;
    type FetchInput = Parameters<typeof fetch>[0];
    globalThis.fetch = (async (input: FetchInput) => {
      const target = String(input);
      if (target.startsWith('https://maps.app.goo.gl/')) {
        return {
          status: 302,
          url: target,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'location'
                ? 'https://www.google.com/maps/search/?api=1&query=Qu%C3%A1n&query_place_id=fake-shortlink'
                : null,
          },
        } as unknown as Response;
      }
      return realFetch(input);
    }) as typeof fetch;

    try {
      const before = places.tiersRequested.length;
      const { rows } = await runRows(editor.token, 'ShortLinkShortLinkShortLink01234', [
        ['R1', '', 'https://maps.app.goo.gl/CpyF14zdX84AhCKw5', 'fake-shortlink', 'cafe'],
      ]);

      expect(rows[0]!.status).toBe('ready');
      expect(rows[0]!.resolvedGooglePlaceId).toBe('fake-shortlink');
      // The expansion lands on an explicit `query_place_id`, so agreement is
      // still settled by comparing strings: one Details call, for the place.
      expect(places.tiersRequested.length - before).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('answers a Place ID the catalogue already holds without asking Google', async () => {
    const editor = await createAdmin('id-duplicate@gogo.local', 'editor');
    places.seed({
      providerPlaceId: 'fake-dupe-id',
      name: 'Quán Đã Có',
      lat: 10.75,
      lng: 106.67,
      primaryType: 'cafe',
      types: ['cafe'],
    });

    // First job creates it. Publishing is an ops decision, not an editor's.
    const ops = await createAdmin('id-duplicate-ops@gogo.local', 'ops_admin');
    const first = await runRows(editor.token, 'DupeFirstDupeFirstDupeFirst012345', [
      ['R1', '', '', 'fake-dupe-id', 'cafe'],
    ]);
    const published = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${first.jobId}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().created).toBe(1);

    const before = places.tiersRequested.length;
    const second = await runRows(editor.token, 'DupeSecondDupeSecondDupeSecond012', [
      ['R1', '', '', 'fake-dupe-id', 'cafe'],
    ]);

    expect(second.rows[0]!.status).toBe('duplicate');
    expect(second.rows[0]!.matchReasons).toContain('DB_FIRST');
    // The whole point of resolving the id first: a decision already made costs
    // no Details call.
    expect(places.tiersRequested.length).toBe(before);
  });
});

/**
 * PI-BE-025 — the GoGo-owned columns reach the catalogue.
 *
 * The audit's rule for this task: no accepted column may disappear during
 * persistence. So the assertion is not that the parser read the value — it is
 * that the row on `places` holds it after the publish.
 */
describe('PI-BE-025 — GoGo-owned columns persist', () => {
  const HEADERS = [
    'source_row_id',
    'google_place_id',
    'category',
    'phone',
    'website',
    'avg_visit_minutes',
    'is_lodging',
    'curated_rank',
    'highlight',
  ];

  it('writes every column the sheet supplied, and records who claimed them', async () => {
    const editor = await createAdmin('gogo-cols@gogo.local', 'editor');
    const ops = await createAdmin('gogo-cols-ops@gogo.local', 'ops_admin');
    places.seed({
      providerPlaceId: 'fake-gogo-cols',
      name: 'Khách Sạn Nào Đó',
      lat: 21.03,
      lng: 105.81,
      primaryType: 'cafe',
      types: ['cafe'],
    });

    sheets.seed('GogoColsGogoColsGogoColsGogoCols01', 'C', [
      HEADERS,
      [
        'R1',
        'fake-gogo-cols',
        'cafe',
        '028 3822 9999',
        'chaoban.vn/menu',
        '90',
        'true',
        '3',
        'Bar tầng thượng',
      ],
    ]);
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: 'GogoColsGogoColsGogoColsGogoCols01',
        sheets: ['C'],
        mode: 'create_drafts',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = created.json();
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(job.id);

    const published = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${job.id}/publish`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().created).toBe(1);

    const rows = await imports.listRows(job.id as string, { limit: 10, offset: 0 });
    const placeId = rows.items[0]!.matchedPlaceId as string;
    const [place] = await db.select().from(schema.places).where(eq(schema.places.id, placeId));

    expect(place).toMatchObject({
      phone: '+842838229999',
      website: 'https://chaoban.vn/menu',
      avgVisitMinutes: 90,
      isLodging: true,
      curatedRank: 3,
      description: 'Bar tầng thượng',
    });
    // PI-CMS-009 — `suitability` is not an import column, so an imported place
    // has whatever the schema defaults it to and nothing the file said.
    expect(place!.suitability).toBeNull();

    // The import wrote no provenance at all before this, so a field with no
    // recorded origin was indistinguishable from one GoGo authored.
    const provenance = await db
      .select()
      .from(schema.placeFieldProvenance)
      .where(eq(schema.placeFieldProvenance.placeId, placeId));
    const byField = new Map(provenance.map((row) => [row.field, row]));
    for (const field of ['description', 'phone', 'website']) {
      expect(byField.get(field), field).toMatchObject({ sourceType: 'editorial' });
    }
    // The sheet let the provider name the place, so it claimed no name.
    expect(byField.has('name')).toBe(false);
  });

  it('fails the row instead of dropping a value it cannot store', async () => {
    const editor = await createAdmin('gogo-cols-bad@gogo.local', 'editor');
    places.seed({ providerPlaceId: 'fake-cols-bad', name: 'Quán Lỗi', lat: 21.02, lng: 105.8 });

    sheets.seed('GogoColsBadGogoColsBadGogoColsBad1', 'C', [
      HEADERS,
      [
        'R1',
        'fake-cols-bad',
        'cafe',
        'gọi cho Nam',
        'javascript:alert(1)',
        '5',
        'couple:0.9',
        'có lẽ',
        '-2',
        '',
      ],
    ]);
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports/google-sheet',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        spreadsheetUrl: 'GogoColsBadGogoColsBadGogoColsBad1',
        sheets: ['C'],
        mode: 'dry_run',
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const rows = await imports.listRows(created.json().id as string, { limit: 10, offset: 0 });
    const codes = rows.items[0]!.errors.map((e: { code: string }) => e.code);
    expect(rows.items[0]!.status).toBe('validation_failed');
    for (const code of [
      'PHONE_INVALID',
      'WEBSITE_INVALID',
      'AVG_VISIT_INVALID',
      'IS_LODGING_INVALID',
      'CURATED_RANK_INVALID',
    ]) {
      expect(codes, code).toContain(code);
    }
  });
});
