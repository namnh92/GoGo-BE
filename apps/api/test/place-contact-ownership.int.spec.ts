import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { PlaceDedupService, PlaceImportJobService } from '@gogo/modules';
import { PLACE_PROVIDER, type FakePlaceProvider } from '@gogo/providers';
import { idempotencyHeader } from './support/cms-place-create';

/**
 * GoGo-BE#280 — address, phone and website are GoGo-owned place data (owner
 * decision 2026-10-02, option A; shape by SA, ADR-0031).
 *
 * What these cases hold, over real HTTP and PostGIS: a value is written only
 * with independent evidence, through every door (console create/edit, bulk
 * import in both modes, submission approval); Google is never its source and
 * cannot overwrite or resurrect it; two concurrent edits resolve as one
 * conflict; the public detail says whose each value is without leaking the
 * evidence; and none of it costs a provider call.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: FakePlaceProvider;
let imports: PlaceImportJobService;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.81.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const EVIDENCE = {
  sourceType: 'editorial',
  sourceReference: 'Gọi điện chủ quán, anh Nam, 2026-09-30',
  collectedAt: '2026-09-30T02:00:00Z',
};

async function createAdmin(email: string, role: 'editor' | 'moderator' | 'ops_admin') {
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: email.split('@')[0]!, role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  expect(res.statusCode).toBe(201);
  return { id: row!.id, token: res.json().accessToken as string };
}

let seq = 0;
async function makePlace(overrides: Partial<typeof schema.places.$inferInsert> = {}) {
  const name = `Quán Liên Hệ ${++seq}`;
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: name.toLowerCase(),
      status: 'draft',
      geom: { x: 106.7 + seq / 1000, y: 10.77 + seq / 1000 },
      ...overrides,
    })
    .returning();
  return row!;
}

async function provenanceOf(placeId: string) {
  const rows = await db
    .select()
    .from(schema.placeFieldProvenance)
    .where(eq(schema.placeFieldProvenance.placeId, placeId));
  return new Map(rows.map((r) => [r.field, r]));
}

let editor: { id: string; token: string };
let moderator: { id: string; token: string };
let ops: { id: string; token: string };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_contact_ownership_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.GOOGLE_SHEETS_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  await db.insert(schema.taxonomies).values({ kind: 'category', key: 'cafe' });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  places = app.get(PLACE_PROVIDER) as FakePlaceProvider;
  imports = app.get(PlaceImportJobService);

  editor = await createAdmin('contact-editor@gogo.local', 'editor');
  moderator = await createAdmin('contact-moderator@gogo.local', 'moderator');
  ops = await createAdmin('contact-ops@gogo.local', 'ops_admin');
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

const patch = (id: string, payload: Record<string, unknown>, token = editor.token) =>
  api().inject({ method: 'PATCH', url: `/v1/cms/places/${id}`, headers: auth(token), payload });
const cmsDetail = (id: string) =>
  api().inject({ method: 'GET', url: `/v1/cms/places/${id}`, headers: auth(editor.token) });

// ---------------------------------------------------------------- console

describe('#280 console edit — evidence or nothing', () => {
  it('refuses a typed phone with no evidence — typing does not confer ownership', async () => {
    // FAIL-before: 200, stored, and recorded `editorial` with a null reference.
    const place = await makePlace();
    const res = await patch(place.id, {
      phone: '0283 822 9999',
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().field_errors).toEqual([
      expect.objectContaining({ field: 'provenance.phone', code: 'required' }),
    ]);
    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(after!.phone).toBeNull();
    expect((await provenanceOf(place.id)).size).toBe(0);
  });

  it('writes value, evidence and audit together, and reports the field as GoGo’s', async () => {
    const place = await makePlace();
    const res = await patch(place.id, {
      addressText: '  12 Nguyễn Huệ, Phường Sài Gòn  ',
      phone: '0283 822 9999',
      website: 'chaoban.vn/lien-he',
      provenance: {
        addressText: { ...EVIDENCE, sourceType: 'editorial' },
        phone: EVIDENCE,
        website: { ...EVIDENCE, sourceReference: 'https://chaoban.vn/lien-he' },
      },
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode, res.body).toBe(200);

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(after).toMatchObject({
      addressText: '12 Nguyễn Huệ, Phường Sài Gòn',
      phone: '+842838229999',
      website: 'https://chaoban.vn/lien-he',
    });
    const prov = await provenanceOf(place.id);
    expect(prov.get('phone')).toMatchObject({
      sourceType: 'editorial',
      sourceReference: EVIDENCE.sourceReference,
      actorId: editor.id,
    });
    expect(prov.get('phone')!.collectedAt!.toISOString()).toBe('2026-09-30T02:00:00.000Z');

    const detail = (await cmsDetail(place.id)).json();
    expect(detail.provenance.phone).toMatchObject({
      sourceType: 'editorial',
      collectedAt: '2026-09-30T02:00:00.000Z',
      ownership: 'gogo',
    });

    // The audit names fields and source types — never the number or the reference.
    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, place.id),
          eq(schema.auditLogs.action, 'place.updated'),
        ),
      );
    const diff = JSON.stringify(audit!.diff);
    expect(diff).toContain('"phone"');
    expect(diff).not.toContain('2838229999');
    expect(diff).not.toContain('anh Nam');

    // The existing reindex event, so search sees the new facts.
    const { rows } = await db.execute(sql`
      select count(*)::int as n from outbox_events
      where resource_id = ${place.id} and event_type = 'place.updated'
    `);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('requires the form version for a contact write', async () => {
    const place = await makePlace();
    const res = await patch(place.id, { phone: '0283 822 9999', provenance: { phone: EVIDENCE } });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors).toEqual([
      expect.objectContaining({ field: 'expectedUpdatedAt', code: 'required' }),
    ]);
  });

  it('lets exactly one of two simultaneous edits win', async () => {
    // FAIL-before: the staleness check ran outside the transaction, so two
    // saves loaded from one version both passed it and the later one won.
    //
    // Made deterministic rather than hoped for: a separate connection holds
    // the row lock while both requests are sent, so both have passed every
    // check that runs before their write and are queued on the row when it is
    // released. Only a comparison made *under* the lock can tell them apart.
    const place = await makePlace();
    const version = place.updatedAt.toISOString();
    const blocker = await pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from places where id = $1 for update', [place.id]);
      const pending = ['0283 822 1111', '0283 822 2222'].map((phone) =>
        patch(place.id, { phone, provenance: { phone: EVIDENCE }, expectedUpdatedAt: version }),
      );
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await pool.query(
          `select count(*)::int as n from pg_stat_activity
           where wait_event_type = 'Lock' and datname = current_database()`,
        );
        if ((rows[0] as { n: number }).n >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await blocker.query('rollback');
      const results = await Promise.all(pending);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('PLACE_MODIFIED');
    } finally {
      blocker.release();
    }
  });

  it('clears with null, drops the provenance, and never needs evidence to do it', async () => {
    const place = await makePlace({ website: 'https://chaoban.vn/' });
    await db.insert(schema.placeFieldProvenance).values({
      placeId: place.id,
      field: 'website',
      sourceType: 'editorial',
      sourceReference: 'menu',
      collectedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const res = await patch(place.id, {
      website: null,
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(after!.website).toBeNull();
    expect((await provenanceOf(place.id)).has('website')).toBe(false);
  });

  it('treats a re-sent unchanged value as no write: no evidence asked, verifiedAt unmoved', async () => {
    const place = await makePlace({ phone: '+842838229999' });
    const verifiedAt = new Date('2026-09-01T00:00:00Z');
    await db.insert(schema.placeFieldProvenance).values({
      placeId: place.id,
      field: 'phone',
      sourceType: 'editorial',
      sourceReference: 'menu',
      collectedAt: verifiedAt,
      verifiedAt,
    });
    // A whole-form save that only renames the place.
    const res = await patch(place.id, { name: 'Tên mới', phone: '028 3822 9999' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await provenanceOf(place.id)).get('phone')!.verifiedAt.toISOString()).toBe(
      verifiedAt.toISOString(),
    );
  });

  it('rolls value and evidence back with the rest of a failed save', async () => {
    const place = await makePlace();
    // No administrative dataset is published here, so asserting codes is a
    // 503 raised inside the transaction — after the contact plan was accepted.
    const res = await patch(place.id, {
      phone: '0283 822 9999',
      provenance: { phone: EVIDENCE },
      provinceCode: '79',
      communeCode: '26734',
      // #440 F-07 — asserted codes name their evidence on an edit too.
      sourceReferences: { provinceCode: 'biển hiệu phường', communeCode: 'biển hiệu phường' },
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode, res.body).toBe(503);
    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(after!.phone).toBeNull();
    expect((await provenanceOf(place.id)).size).toBe(0);
  });

  it.each([
    ['phone', '+0912 345 678', 'phone'],
    ['website', 'https://user:pass@chaoban.vn', 'website'],
    ['website', 'http://192.168.1.10/menu', 'website'],
    ['addressText', '<b>12 Lê Lợi</b>', 'addressText'],
  ])('refuses %s %j against its own field', async (field, value, errorField) => {
    // FAIL-before for the first two: both were accepted and stored.
    const place = await makePlace();
    const res = await patch(place.id, {
      [field]: value,
      provenance: { [field]: EVIDENCE },
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({ field: errorField });
  });

  it('refuses Google as the evidence', async () => {
    const place = await makePlace();
    const res = await patch(place.id, {
      addressText: '9 Nguyễn Huệ',
      provenance: {
        addressText: { ...EVIDENCE, sourceType: 'google_derived' },
      },
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({
      field: 'provenance.addressText.sourceType',
      code: 'google_not_independent',
    });
  });

  it('keeps the edit closed to a moderator', async () => {
    const place = await makePlace();
    const res = await patch(
      place.id,
      {
        phone: '0283 822 9999',
        provenance: { phone: EVIDENCE },
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
      moderator.token,
    );
    expect(res.statusCode).toBe(403);
  });

  it('spends no provider request on any of it', async () => {
    const before = places.tiersRequested.length;
    const place = await makePlace();
    await patch(place.id, {
      website: 'chaoban.vn',
      provenance: { website: EVIDENCE },
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(places.tiersRequested.length).toBe(before);
  });
});

describe('#280 console create', () => {
  // The full create matrix (alpha.66: provenance only, sourceReferences.<contact>
  // unknown, value_missing / not_allowed / google) lives with the rest of the
  // create contract in `cms-place-create.int.spec.ts`.
  it('creates with evidence and records it', async () => {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/places',
      headers: { ...auth(editor.token), ...idempotencyHeader() },
      payload: {
        name: 'Quán Tự Nhập',
        lat: 10.95,
        lng: 106.95,
        phone: '0912 345 678',
        sourceReferences: { name: 'biển hiệu tại quán', geom: 'khảo sát thực địa' },
        provenance: { phone: EVIDENCE },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().phone).toBe('+84912345678');
    expect(res.json().provenance.phone.ownership).toBe('gogo');
  });
});

describe('#280 × #440 edit references and legacy rows', () => {
  it('refuses sourceReferences.phone on an edit as unknown, naming provenance', async () => {
    const place = await makePlace();
    const res = await patch(place.id, {
      phone: '0912 345 670',
      provenance: { phone: EVIDENCE },
      sourceReferences: { phone: EVIDENCE.sourceReference },
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SOURCE_REFERENCE_INVALID');
    expect(res.json().field_errors).toEqual([
      expect.objectContaining({ field: 'sourceReferences.phone', code: 'unknown' }),
    ]);
    expect(res.json().field_errors[0].message).toContain('provenance.phone');
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(row!.phone).toBeNull();
  });

  it('reads a contact row written before alpha.66 (reference, no collected-at) as unknown', async () => {
    // What alpha.62–65's `sourceReferences.phone` stored: editorial + a reference,
    // no collection time. Not backfilled; it stays unknown until re-verified.
    const place = await makePlace({ phone: '+842838221212' });
    await db.insert(schema.placeFieldProvenance).values({
      placeId: place.id,
      field: 'phone',
      sourceType: 'editorial',
      sourceReference: 'gọi xác nhận 2026-10-01',
      actorId: editor.id,
    });
    const res = await cmsDetail(place.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.phone).toMatchObject({
      sourceType: 'editorial',
      collectedAt: null,
      ownership: 'unknown',
    });
  });
});

// ---------------------------------------------------------------- public

describe('#280 public place detail', () => {
  it('says whose each value is, suppresses an unsafe legacy link, and leaks no evidence', async () => {
    const place = await makePlace({
      status: 'published',
      addressText: '5 Hai Bà Trưng',
      phone: '+842838229999',
      website: 'javascript:alert(1)',
    });
    await db.insert(schema.placeFieldProvenance).values([
      {
        placeId: place.id,
        field: 'phone',
        sourceType: 'editorial',
        sourceReference: 'Biên bản khảo sát bí mật 42',
        collectedAt: new Date('2026-09-30T02:00:00Z'),
        verifiedAt: new Date('2026-10-01T03:00:00Z'),
        actorId: editor.id,
      },
      // A legacy claim: a person typed it, nobody recorded where it came from.
      { placeId: place.id, field: 'address_text', sourceType: 'editorial' },
    ]);

    const res = await api().inject({ method: 'GET', url: `/v1/places/${place.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.phone).toBe('+842838229999');
    expect(body.website).toBeUndefined();
    expect(body.provenance).toEqual({
      phone: { sourceType: 'gogo', verifiedAt: '2026-10-01T03:00:00.000Z' },
      addressText: { sourceType: 'unknown' },
    });
    expect(res.body).not.toContain('khảo sát bí mật');
    expect(res.body).not.toContain(editor.id);
  });

  it('keeps a Google seed Google, pointing at an attribution entry it returns', async () => {
    const place = await makePlace({ status: 'published', addressText: '1 Fake St, HCMC' });
    await db.insert(schema.placeSources).values({
      placeId: place.id,
      provider: 'google',
      externalId: `fake-seed-${place.id}`,
      attribution: 'Google',
    });
    await db.insert(schema.placeFieldProvenance).values({
      placeId: place.id,
      field: 'address_text',
      sourceType: 'google_derived',
      sourceReference: `fake-seed-${place.id}`,
    });
    const body = (await api().inject({ method: 'GET', url: `/v1/places/${place.id}` })).json();
    expect(body.provenance).toEqual({ addressText: { sourceType: 'google', provider: 'google' } });
    expect(body.sources.map((s: { provider: string }) => s.provider)).toContain('google');
  });

  it('reports an orphaned Google seed as unknown, never pointing at absent attribution (F-04)', async () => {
    // FAIL-before: `google` with `provider: google` and no `sources[]` entry.
    const place = await makePlace({ status: 'published', addressText: '1 Fake St, HCMC' });
    await db.insert(schema.placeFieldProvenance).values({
      placeId: place.id,
      field: 'address_text',
      sourceType: 'google_derived',
      sourceReference: 'fake-seed-orphan',
    });
    const body = (await api().inject({ method: 'GET', url: `/v1/places/${place.id}` })).json();
    expect(body.sources ?? []).toEqual([]);
    expect(body.provenance).toEqual({ addressText: { sourceType: 'unknown' } });
  });

  it('omits provenance entirely for a place with none of the three', async () => {
    const place = await makePlace({ status: 'published' });
    const body = (await api().inject({ method: 'GET', url: `/v1/places/${place.id}` })).json();
    expect(body.provenance).toBeUndefined();
    expect(body.addressText).toBeUndefined();
  });
});

// ---------------------------------------------------------------- import

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = `----gogo${Math.random().toString(16).slice(2)}`;
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

const IMPORT_HEADER = [
  'source_row_id',
  'name',
  'google_place_id',
  'category',
  'address',
  'address_source_type',
  'address_source_reference',
  'address_collected_at',
  'phone',
  'phone_source_type',
  'phone_source_reference',
  'phone_collected_at',
  'website',
  'website_source_type',
  'website_source_reference',
  'website_collected_at',
].join(',');

type ContactCells = { address?: string; phone?: string; website?: string; evidence?: boolean };
function importRow(id: string, googlePlaceId: string, c: ContactCells): string {
  const ev = (v: string | undefined) =>
    v && c.evidence !== false
      ? ['editorial', '"Thực đơn in tại quán, chụp 2026-09-30"', '2026-09-30T02:00:00Z']
      : ['', '', ''];
  return [
    id,
    '',
    googlePlaceId,
    'cafe',
    c.address ? `"${c.address}"` : '',
    ...ev(c.address),
    c.phone ?? '',
    ...ev(c.phone),
    c.website ?? '',
    ...ev(c.website),
  ].join(',');
}

let importer = 0;
async function runImport(rows: string[], mode: string, name: string, header = IMPORT_HEADER) {
  const content = Buffer.from([header, ...rows].join('\n'), 'utf8');
  const body = multipart({ mode }, { name, content });
  // One editor per job: job creation is rate-limited per actor, and this file
  // creates more jobs than one person would in a minute.
  const uploader = await createAdmin(`contact-importer-${++importer}@gogo.local`, 'editor');
  const created = await api().inject({
    method: 'POST',
    url: '/v1/cms/place-imports',
    remoteAddress: ip(),
    headers: { ...auth(uploader.token), ...body.headers },
    payload: body.payload,
  });
  expect(created.statusCode, created.body).toBe(201);
  const jobId = created.json().id as string;
  if (mode !== 'dry_run') {
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/start`,
      remoteAddress: ip(),
      headers: auth(uploader.token),
    });
    await imports.processJob(jobId);
  }
  return jobId;
}

async function publish(jobId: string) {
  const res = await api().inject({
    method: 'POST',
    url: `/v1/cms/place-imports/${jobId}/publish`,
    remoteAddress: ip(),
    headers: auth(ops.token),
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function placeLinkedTo(googlePlaceId: string) {
  const { rows } = await db.execute(sql`
    select p.* from places p
    join place_provider_sources ps on ps.place_id = p.id
    where ps.external_id = ${googlePlaceId}
  `);
  return rows[0] as
    | { id: string; address_text: string | null; phone: string | null; website: string | null }
    | undefined;
}

describe('#280 bulk import', () => {
  it('fails a contact cell with no evidence in dry-run, naming the column', async () => {
    const jobId = await runImport(
      [importRow('D-1', 'fake-imp-dry', { phone: '028 3822 9999', evidence: false })],
      'dry_run',
      'dry.csv',
    );
    const rows = await imports.listRows(jobId, { limit: 10, offset: 0 });
    expect(rows.items[0]!.status).toBe('validation_failed');
    expect(rows.items[0]!.errors.map((e) => e.code)).toContain('PHONE_EVIDENCE_REQUIRED');
  });

  it('creates with the sheet’s address and evidence, never Google’s address', async () => {
    // FAIL-before: `address` was a retired mapping value, and `address_text`
    // was filled from the provider's formatted address.
    places.seed({ providerPlaceId: 'fake-imp-a', name: 'Quán Import A', lat: 10.71, lng: 106.61 });
    places.seed({ providerPlaceId: 'fake-imp-b', name: 'Quán Import B', lat: 10.72, lng: 106.62 });
    const jobId = await runImport(
      [
        importRow('A-1', 'fake-imp-a', {
          address: '88 Pasteur, Phường Sài Gòn',
          phone: '028 3822 1234',
          website: 'quanimporta.vn',
        }),
        importRow('B-1', 'fake-imp-b', {}),
      ],
      'create_drafts',
      'create.csv',
    );
    await publish(jobId);

    const a = await placeLinkedTo('fake-imp-a');
    expect(a).toMatchObject({
      address_text: '88 Pasteur, Phường Sài Gòn',
      phone: '+842838221234',
      website: 'https://quanimporta.vn/',
    });
    const prov = await provenanceOf(a!.id);
    expect(prov.get('address_text')).toMatchObject({
      sourceType: 'editorial',
      sourceReference: 'Thực đơn in tại quán, chụp 2026-09-30',
      actorId: ops.id,
    });
    expect(prov.get('address_text')!.collectedAt).not.toBeNull();

    // No sheet address, so no address at all — the provider's is not a fallback.
    const b = await placeLinkedTo('fake-imp-b');
    expect(b!.address_text).toBeNull();
    expect((await provenanceOf(b!.id)).has('address_text')).toBe(false);
  });

  it('update_existing writes the sheet’s contacts, keeps blanks, and Google cannot overwrite', async () => {
    places.seed({ providerPlaceId: 'fake-imp-u', name: 'Quán Update', lat: 10.73, lng: 106.63 });
    const first = await runImport(
      [importRow('U-1', 'fake-imp-u', { address: '1 Đồng Khởi', website: 'quanupdate.vn' })],
      'create_drafts',
      'u1.csv',
    );
    await publish(first);
    const place = await placeLinkedTo('fake-imp-u');
    expect(place!.address_text).toBe('1 Đồng Khởi');

    // Google's answer moves on; the sheet adds a phone and leaves website blank.
    places.seed({
      providerPlaceId: 'fake-imp-u',
      name: 'Quán Update',
      addressText: 'Địa chỉ Google mới',
      lat: 10.73,
      lng: 106.63,
    });
    // FAIL-before: this mode validated phone/website and then never wrote them.
    await runImport(
      [importRow('U-1', 'fake-imp-u', { address: '2 Đồng Khởi', phone: '0912 000 111' })],
      'update_existing',
      'u2.csv',
    );
    const after = await placeLinkedTo('fake-imp-u');
    expect(after).toMatchObject({
      address_text: '2 Đồng Khởi',
      phone: '+84912000111',
      website: 'https://quanupdate.vn/',
    });

    // A third run with every contact cell blank: nothing moves, Google's
    // address included.
    await runImport([importRow('U-1', 'fake-imp-u', {})], 'update_existing', 'u3.csv');
    const third = await placeLinkedTo('fake-imp-u');
    expect(third!.address_text).toBe('2 Đồng Khởi');
  });

  it('update_existing persists phone and website onto an existing place', async () => {
    // FAIL-before: this mode parsed and validated phone/website, then never
    // wrote them — a corrected sheet changed nothing.
    places.seed({ providerPlaceId: 'fake-imp-p', name: 'Quán Phone', lat: 10.75, lng: 106.65 });
    const first = await runImport([importRow('P-1', 'fake-imp-p', {})], 'create_drafts', 'p1.csv');
    await publish(first);
    await runImport(
      [importRow('P-1', 'fake-imp-p', { phone: '0912 222 333', website: 'quanphone.vn' })],
      'update_existing',
      'p2.csv',
    );
    expect(await placeLinkedTo('fake-imp-p')).toMatchObject({
      phone: '+84912222333',
      website: 'https://quanphone.vn/',
    });
  });

  it('Google cannot write an address onto a place nobody gave one', async () => {
    // FAIL-before: with no `editorial` claim on `address_text`, update_existing
    // took Google's formatted address — restoring one an operator had removed
    // outside the console, or inventing one the place never had.
    places.seed({ providerPlaceId: 'fake-imp-g', name: 'Quán Google', lat: 10.76, lng: 106.66 });
    const first = await runImport([importRow('G-1', 'fake-imp-g', {})], 'create_drafts', 'g1.csv');
    await publish(first);
    const place = await placeLinkedTo('fake-imp-g');
    await db
      .update(schema.places)
      .set({ addressText: null })
      .where(eq(schema.places.id, place!.id));
    await db
      .delete(schema.placeFieldProvenance)
      .where(
        and(
          eq(schema.placeFieldProvenance.placeId, place!.id),
          eq(schema.placeFieldProvenance.field, 'address_text'),
        ),
      );

    await runImport([importRow('G-1', 'fake-imp-g', {})], 'update_existing', 'g2.csv');
    expect((await placeLinkedTo('fake-imp-g'))!.address_text).toBeNull();
  });

  it('a cleared address is not resurrected by the next provider fetch', async () => {
    places.seed({ providerPlaceId: 'fake-imp-c', name: 'Quán Clear', lat: 10.74, lng: 106.64 });
    const first = await runImport(
      [importRow('C-1', 'fake-imp-c', { address: '3 Lý Tự Trọng' })],
      'create_drafts',
      'c1.csv',
    );
    await publish(first);
    const place = await placeLinkedTo('fake-imp-c');
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, place!.id));
    expect(
      (
        await patch(place!.id, {
          addressText: null,
          expectedUpdatedAt: row!.updatedAt.toISOString(),
        })
      ).statusCode,
    ).toBe(200);

    await runImport([importRow('C-1', 'fake-imp-c', {})], 'update_existing', 'c2.csv');
    expect((await placeLinkedTo('fake-imp-c'))!.address_text).toBeNull();
  });
});

// ---------------------------------------------------------------- submission approval

describe('#280 submission approval', () => {
  async function register(email: string) {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email, password: 'sufficiently-long-pw', displayName: 'U' },
    });
    return res.json().accessToken as string;
  }

  async function contribute(googlePlaceId: string) {
    places.seed({
      providerPlaceId: googlePlaceId,
      name: `Quán Đóng Góp ${googlePlaceId}`,
      addressText: 'Địa chỉ Google',
      lat: 21.03,
      lng: 105.85,
      rating: 4.4,
      ratingCount: 900,
    });
    const token = await register(`${googlePlaceId}@gogo.id.vn`);
    const res = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { googlePlaceId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().submissionId as string;
  }

  const saveReview = (id: string, draft: Record<string, unknown>) =>
    api().inject({
      method: 'PUT',
      url: `/v1/cms/place-submissions/${id}/review`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { draft },
    });
  const decide = (id: string) =>
    api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${id}/decide`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'approved', reason: 'đủ thông tin' },
    });

  it('refuses a draft contact value with no evidence at save', async () => {
    const id = await contribute('fake-sub-1');
    const res = await saveReview(id, { phone: '024 3456 7890' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({
      field: 'provenance.phone',
      code: 'required',
    });
  });

  it('refuses a transport-only reference in a draft, like every other door (F-05)', async () => {
    const id = await contribute('fake-sub-transport');
    const res = await saveReview(id, {
      phone: '024 3456 7890',
      provenance: { phone: { ...EVIDENCE, sourceReference: 'Sheet1!B7' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({
      field: 'provenance.phone.sourceReference',
      code: 'transport_only',
    });
  });

  it('stores the draft normalized and approves it with its evidence, without Google’s address', async () => {
    const id = await contribute('fake-sub-2');
    const saved = await saveReview(id, {
      phone: '024 3456 7890',
      website: 'ngocha.vn',
      provenance: { phone: EVIDENCE, website: EVIDENCE },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().draft).toMatchObject({
      phone: '+842434567890',
      website: 'https://ngocha.vn/',
      provenance: { phone: { collectedAt: '2026-09-30T02:00:00.000Z' } },
    });

    const approved = await decide(id);
    expect(approved.statusCode, approved.body).toBe(201);
    const placeId = approved.json().placeId as string;
    const [place] = await db.select().from(schema.places).where(eq(schema.places.id, placeId));
    // FAIL-before: the provider's formatted address filled `address_text`.
    expect(place).toMatchObject({
      addressText: null,
      phone: '+842434567890',
      website: 'https://ngocha.vn/',
    });
    const prov = await provenanceOf(placeId);
    expect(prov.has('address_text')).toBe(false);
    expect(prov.get('phone')).toMatchObject({ sourceType: 'editorial', actorId: moderator.id });
  });

  it('refuses to approve a pre-#280 draft whose contact values carry no evidence', async () => {
    const id = await contribute('fake-sub-3');
    await db
      .update(schema.placeSubmissions)
      .set({ reviewDraft: { phone: '024 3456 7890' } })
      .where(eq(schema.placeSubmissions.id, id));
    const res = await decide(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('REVIEW_EVIDENCE_REQUIRED');
    const { rows } = await db.execute(sql`select count(*)::int as n from places
      where name = ${'Quán Đóng Góp fake-sub-3'}`);
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

// ---------------------------------------------------------------- Sol review round 1

describe('#280 review round 1 (Sol F-01, F-02, F-05, F-06)', () => {
  it('F-01: never persists Google’s formatted address in import candidates', async () => {
    // Two branches with one name, metres apart: the resolver cannot pick, so
    // the row stores its candidates for a reviewer. FAIL-before: each stored
    // candidate carried `address: '1 Fake St, HCMC'`.
    places.seed({
      providerPlaceId: 'fake-twin-a',
      name: 'Trà Sữa Song Sinh',
      lat: 10.8,
      lng: 106.68,
    });
    places.seed({
      providerPlaceId: 'fake-twin-b',
      name: 'Trà Sữa Song Sinh',
      lat: 10.8001,
      lng: 106.6801,
    });
    const jobId = await runImport(
      ['T-1,Trà Sữa Song Sinh,Hồ Chí Minh,cafe'],
      'create_drafts',
      'twins.csv',
      'source_row_id,name,city,category',
    );
    const { rows } = await db.execute(sql`
      select status, candidates from place_ingest_rows where job_id = ${jobId}::uuid
    `);
    const row = rows[0] as { status: string; candidates: Record<string, unknown>[] };
    expect(row.candidates.length, row.status).toBeGreaterThan(0);
    for (const candidate of row.candidates) {
      expect(candidate).not.toHaveProperty('address');
      expect(candidate).toHaveProperty('googlePlaceId');
    }
    expect(JSON.stringify(row.candidates)).not.toContain('Fake St');
  });

  it('F-02: a failure after the place write rolls the whole update_existing row back', async () => {
    // FAIL-before: the place, its contact values and evidence committed in
    // their own transaction; the outbox write failing afterwards left them
    // written with no reindex event and the row not `imported`.
    places.seed({
      providerPlaceId: 'fake-imp-atomic',
      name: 'Quán Atomic',
      lat: 10.77,
      lng: 106.67,
    });
    const first = await runImport(
      [importRow('A-9', 'fake-imp-atomic', {})],
      'create_drafts',
      'atomic1.csv',
    );
    await publish(first);
    const place = await placeLinkedTo('fake-imp-atomic');
    const outboxBefore = await db.execute(sql`
      select count(*)::int as n from outbox_events where resource_id = ${place!.id}
    `);

    const dedup = app.get(PlaceDedupService);
    const spy = vi
      .spyOn(dedup, 'emitReindex')
      .mockRejectedValueOnce(new Error('injected outbox failure'));
    try {
      await runImport(
        [importRow('A-9', 'fake-imp-atomic', { phone: '0912 999 888', address: '9 Atomic' })],
        'update_existing',
        'atomic2.csv',
      ).catch(() => undefined);
      // Read before restoring: `mockRestore` also clears the call record.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const after = await placeLinkedTo('fake-imp-atomic');
    expect(after).toMatchObject({ phone: null, address_text: null });
    const prov = await provenanceOf(place!.id);
    expect(prov.has('phone')).toBe(false);
    expect(prov.has('address_text')).toBe(false);
    const outboxAfter = await db.execute(sql`
      select count(*)::int as n from outbox_events where resource_id = ${place!.id}
    `);
    expect((outboxAfter.rows[0] as { n: number }).n).toBe(
      (outboxBefore.rows[0] as { n: number }).n,
    );
    const { rows } = await db.execute(sql`
      select r.status from place_ingest_rows r
      join place_ingest_jobs j on j.id = r.job_id
      where r.source_row_id = 'A-9' and j.mode = 'update_existing'
    `);
    expect((rows[0] as { status: string }).status).not.toBe('imported');
  });

  it('F-05: refuses a transport-only reference at the console and in a sheet alike', async () => {
    const place = await makePlace();
    const res = await patch(place.id, {
      phone: '0283 822 9999',
      provenance: { phone: { ...EVIDENCE, sourceReference: 'job 123' } },
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({
      field: 'provenance.phone.sourceReference',
      code: 'transport_only',
    });

    const header =
      'source_row_id,google_place_id,category,phone,phone_source_type,phone_source_reference,phone_collected_at';
    const jobId = await runImport(
      ['J-1,fake-imp-transport,cafe,028 3822 9999,editorial,row 42,2026-09-30T02:00:00Z'],
      'dry_run',
      'transport.csv',
      header,
    );
    const rows = await imports.listRows(jobId, { limit: 10, offset: 0 });
    expect(rows.items[0]!.errors).toEqual([
      expect.objectContaining({ code: 'PHONE_EVIDENCE_INVALID', field: 'phone_source_reference' }),
    ]);
  });

  it('F-06: refuses a date-only or impossible collectedAt', async () => {
    for (const collectedAt of ['2026-09-30', '2026-02-30T00:00:00Z']) {
      const place = await makePlace();
      const res = await patch(place.id, {
        phone: '0283 822 9999',
        provenance: { phone: { ...EVIDENCE, collectedAt } },
        expectedUpdatedAt: place.updatedAt.toISOString(),
      });
      expect(res.statusCode, collectedAt).toBe(400);
      expect(res.json().field_errors[0]).toMatchObject({
        field: 'provenance.phone.collectedAt',
        code: 'invalid_datetime',
      });
    }
  });
});

// ---------------------------------------------------------------- migration

describe('#280 migration 0070', () => {
  it('adds a nullable, default-free collected_at and backfills nothing', async () => {
    const { rows } = await db.execute(sql`
      select is_nullable, column_default, data_type from information_schema.columns
      where table_name = 'place_field_provenance' and column_name = 'collected_at'
    `);
    expect(rows).toEqual([
      { is_nullable: 'YES', column_default: null, data_type: 'timestamp with time zone' },
    ]);
  });

  it('is replay-safe — running it twice changes nothing', async () => {
    const file = path.resolve(
      __dirname,
      '../../../migrations/0070_place-field-provenance-collected-at.sql',
    );
    const { readFileSync } = await import('node:fs');
    await pool.query(readFileSync(file, 'utf8'));
  });
});
