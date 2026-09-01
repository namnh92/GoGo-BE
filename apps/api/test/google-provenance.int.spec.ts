import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { PlaceDedupService, PlaceImportJobService } from '@gogo/modules';
import { PLACE_PROVIDER } from '@gogo/providers';
import type { FakePlaceProvider } from '@gogo/providers';

/**
 * #334 (PR1) — one Google Place ID, one GoGo place, one provenance table.
 *
 * The defect this covers was asymmetric blindness: ingestion's dedup read both
 * `place_provider_sources` and `place_sources`, the legacy `/v1/places/imports`
 * read only the latter, and `/v1/places/:id` attribution read only the latter
 * too. So the same Google place could become two GoGo places depending on
 * which door it arrived through, and a place that arrived through ingestion
 * was served with no attribution at all.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: FakePlaceProvider;
let imports: PlaceImportJobService;
let dedup: PlaceDedupService;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.90.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const MIGRATION_0033 = path.resolve(
  __dirname,
  '../../../migrations/0033_unify-google-provenance.sql',
);

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'U' },
  });
  return res.json().accessToken as string;
}

async function createAdmin(email: string, role: 'editor' | 'moderator' | 'ops_admin') {
  const [row] = await db
    .insert(schema.adminUsers)
    .values({
      email,
      passwordHash: await argon2.hash('admin-password-123', { type: argon2.argon2id }),
      displayName: 'Admin',
      role,
    })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  return { id: row!.id, token: res.json().accessToken as string };
}

const CSV_HEADER =
  'source_row_id,name,city,district,google_maps_url,category,price_min,price_max,price_unit';

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = '----gogoprovenanceboundary';
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

async function newPlace(name: string, lng = 106.7, lat = 10.78) {
  const [place] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: 'set-by-trigger',
      status: 'published',
      geom: { x: lng, y: lat },
    })
    .returning();
  return place!.id;
}

/** Runs the real migration, statement by statement, exactly as drizzle would. */
async function runMigration0033() {
  const statements = readFileSync(MIGRATION_0033, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_provenance_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.GOOGLE_SHEETS_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  await db.insert(schema.serviceAreas).values({
    key: 'hcm_q1',
    name: 'Quận 1, TP.HCM',
    centerLat: 10.7769,
    centerLng: 106.7009,
    radiusM: 8000,
  });
  for (const key of ['cafe', 'restaurant']) {
    await db.insert(schema.taxonomies).values({ kind: 'category', key });
  }

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  places = app.get(PLACE_PROVIDER);
  imports = app.get(PlaceImportJobService);
  dedup = app.get(PlaceDedupService);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('one Google Place ID resolves to one place from every door (#334)', () => {
  it('legacy import, mobile submission and bulk import agree on one place', async () => {
    places.seed({
      providerPlaceId: 'ChIJunify',
      name: 'Quán Hợp Nhất',
      lat: 10.778,
      lng: 106.701,
      attribution: 'Data © Fake Provider',
    });

    // Door 1 — the legacy community import. It used to write `place_sources`.
    const token = await register('unify@gogo.id.vn');
    const legacy = await api().inject({
      method: 'POST',
      url: '/v1/places/imports',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { url: 'https://maps.google.com/maps?place_id=ChIJunify' },
    });
    expect(legacy.json().status).toBe('verified');
    const placeId = legacy.json().placeId as string;
    expect(placeId).toBeTruthy();

    // The identity landed in the canonical table, and nowhere else.
    const legacyRows = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.externalId, 'ChIJunify'));
    expect(legacyRows).toHaveLength(0);

    const providerRows = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'ChIJunify'));
    expect(providerRows).toHaveLength(1);
    expect(providerRows[0]).toMatchObject({
      placeId,
      provider: 'google_places',
      fetchTier: 'quality',
    });
    expect(providerRows[0]!.attribution).toEqual({ text: 'Data © Fake Provider' });
    // ADR-0006 §9.5 — unifying an identity does not move provider content into
    // another table. Only the ID, the link, the attribution and our own
    // fetch metadata may travel.
    expect(providerRows[0]!.rating).toBeNull();
    expect(providerRows[0]!.ratingCount).toBeNull();
    expect(providerRows[0]!.priceLevel).toBeNull();
    expect(providerRows[0]!.primaryType).toBeNull();
    expect(providerRows[0]!.derivedScore).toBeNull();

    // Door 2 — mobile submission. Before PR1 this already read both tables;
    // it must keep resolving to the place the legacy door created.
    const submitter = await register('unify-sub@gogo.id.vn');
    const submission = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(submitter),
      payload: { googlePlaceId: 'ChIJunify' },
    });
    expect(submission.json()).toMatchObject({ status: 'ALREADY_EXISTS', placeId });

    // Door 3 — CMS bulk import. The row is a duplicate of the same place.
    const editor = await createAdmin('unify-editor@gogo.local', 'editor');
    const file = multipart(
      { mode: 'create_drafts', defaultCity: 'Hồ Chí Minh' },
      {
        name: 'unify.csv',
        content: Buffer.from(
          [
            CSV_HEADER,
            'U-1,Quán Hợp Nhất,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=ChIJunify,cafe,100000,200000,per_person',
          ].join('\n'),
          'utf8',
        ),
      },
    );
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), ...file.headers },
      payload: file.payload,
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;
    const started = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(started.json().status).toBe('processing');
    // The worker tick, driven directly so the test does not need Redis.
    await imports.processJob(jobId);
    const [row] = await db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.jobId, jobId));
    expect(row!.status).toBe('duplicate');
    expect(row!.matchedPlaceId).toBe(placeId);

    // One place, one provider row, still.
    const finalProviderRows = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'ChIJunify'));
    expect(finalProviderRows).toHaveLength(1);
    const placesNamed = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Quán Hợp Nhất'));
    expect(placesNamed).toHaveLength(1);
  });

  it('never writes the Details payload (ADR-0006 §9.4 R1)', async () => {
    const withRaw = await db.execute(sql`
      select count(*)::int as n from place_sources where raw is not null
    `);
    expect((withRaw.rows[0] as { n: number }).n).toBe(0);
  });
});

describe('attribution reaches a place that arrived through ingestion (#334)', () => {
  it('/v1/places/:id carries Google provenance for an approved submission', async () => {
    places.seed({
      providerPlaceId: 'ChIJmobile',
      name: 'Quán Từ Điện Thoại',
      lat: 10.779,
      lng: 106.702,
      attribution: 'Data © Fake Provider',
    });
    const token = await register('attrib@gogo.id.vn');
    const submitted = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { googlePlaceId: 'ChIJmobile' },
    });
    expect(submitted.json().status).toBe('PENDING');

    const mod = await createAdmin('attrib-mod@gogo.local', 'moderator');
    const decided = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${submitted.json().submissionId}/decide`,
      remoteAddress: ip(),
      headers: auth(mod.token),
      payload: { decision: 'approved', reason: 'đủ dữ liệu' },
    });
    expect(decided.statusCode).toBe(201);
    const placeId = decided.json().placeId as string;

    // This is the regression: before PR1 the array came back empty, because
    // the reader looked only at `place_sources` and ingestion never wrote it.
    const detail = await api().inject({
      method: 'GET',
      url: `/v1/places/${placeId}`,
      remoteAddress: ip(),
    });
    expect(detail.statusCode).toBe(200);
    const sources = detail.json().sources as { provider: string; attribution: string | null }[];
    expect(sources).toHaveLength(1);
    // The public label is unchanged by where the row now lives.
    expect(sources[0]!.provider).toBe('google');
    expect(sources[0]!.attribution).toBe('Data © Fake Provider');

    const cms = await createAdmin('attrib-editor@gogo.local', 'editor');
    const cmsDetail = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${placeId}`,
      remoteAddress: ip(),
      headers: auth(cms.token),
    });
    expect(cmsDetail.statusCode).toBe(200);
    const cmsSources = cmsDetail.json().sources as {
      provider: string;
      externalId: string;
      fetchedAt: string | null;
    }[];
    expect(cmsSources).toHaveLength(1);
    expect(cmsSources[0]).toMatchObject({ provider: 'google', externalId: 'ChIJmobile' });
    expect(cmsSources[0]!.fetchedAt).toBeTruthy();
  });
});

describe('migration 0033 backfill', () => {
  it('is idempotent, copies no provider content, and parks real conflicts', async () => {
    // A place as the legacy importer used to leave it: identity and payload in
    // `place_sources`, nothing in the canonical table.
    const legacyPlaceId = await newPlace('Quán Cũ');
    const importedAt = new Date('2026-01-02T03:04:05.000Z');
    await db.insert(schema.placeSources).values({
      placeId: legacyPlaceId,
      provider: 'google',
      externalId: 'ChIJlegacy',
      url: 'https://maps.google.com/?cid=ChIJlegacy',
      attribution: 'Data © Legacy',
      raw: { id: 'ChIJlegacy', displayName: { text: 'Quán Cũ' } },
      rawUpdatedAt: importedAt,
    });

    // And the case a backfill cannot decide for itself: the same external ID
    // already held by a different place.
    const canonicalPlaceId = await newPlace('Quán Đúng', 106.71, 10.79);
    const rivalPlaceId = await newPlace('Quán Trùng', 106.72, 10.8);
    await db.insert(schema.placeProviderSources).values({
      placeId: canonicalPlaceId,
      provider: 'google_places',
      externalId: 'ChIJclash',
      attribution: { text: 'Data © Canonical' },
    });
    await db.insert(schema.placeSources).values({
      placeId: rivalPlaceId,
      provider: 'google',
      externalId: 'ChIJclash',
      attribution: 'Data © Rival',
      raw: { id: 'ChIJclash' },
      rawUpdatedAt: importedAt,
    });

    await runMigration0033();
    await runMigration0033();

    const [copied] = await db
      .select()
      .from(schema.placeProviderSources)
      .where(
        and(
          eq(schema.placeProviderSources.externalId, 'ChIJlegacy'),
          eq(schema.placeProviderSources.provider, 'google_places'),
        ),
      );
    expect(copied).toBeDefined();
    expect(copied!.placeId).toBe(legacyPlaceId);
    expect(copied!.fetchTier).toBe('quality');
    // Nobody observed this business's state, so the row does not claim one.
    expect(copied!.sourceStatus).toBe('unknown');
    expect(copied!.attribution).toEqual({ text: 'Data © Legacy' });
    expect(copied!.providerUri).toBe('https://maps.google.com/?cid=ChIJlegacy');
    expect(copied!.fetchedAt?.toISOString()).toBe(importedAt.toISOString());
    expect(copied!.refreshAfter?.toISOString()).toBe(
      new Date(importedAt.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
    );
    expect(copied!.rating).toBeNull();
    expect(copied!.priceLevel).toBeNull();
    expect(copied!.primaryType).toBeNull();

    // Twice run, one row — the whole point of ON CONFLICT DO NOTHING here.
    const copies = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'ChIJlegacy'));
    expect(copies).toHaveLength(1);

    // R1: the payload is gone, and stays gone on a second pass.
    const raws = await db.execute(sql`
      select count(*)::int as n from place_sources
      where raw is not null or raw_updated_at is not null
    `);
    expect((raws.rows[0] as { n: number }).n).toBe(0);

    // The conflict is recorded once, and nothing was overwritten or deleted:
    // the canonical row still points where it did, and the rival place and its
    // legacy row both survive for a human to merge.
    const conflicts = await db
      .select()
      .from(schema.placeIdentityConflicts)
      .where(eq(schema.placeIdentityConflicts.externalId, 'ChIJclash'));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      canonicalPlaceId,
      legacyPlaceId: rivalPlaceId,
      resolvedAt: null,
    });
    const clashRows = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'ChIJclash'));
    expect(clashRows).toHaveLength(1);
    expect(clashRows[0]!.placeId).toBe(canonicalPlaceId);
    const rivalLegacy = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.externalId, 'ChIJclash'));
    expect(rivalLegacy).toHaveLength(1);
    expect(rivalLegacy[0]!.placeId).toBe(rivalPlaceId);
  });

  it('serves a conflicted legacy place its own provenance, not the winner’s', async () => {
    const [rival] = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.externalId, 'ChIJclash'));
    const detail = await api().inject({
      method: 'GET',
      url: `/v1/places/${rival!.placeId}`,
      remoteAddress: ip(),
    });
    const sources = detail.json().sources as { attribution: string | null }[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.attribution).toBe('Data © Rival');
  });
});

describe('an open identity conflict blocks every runtime path (#334)', () => {
  let winnerId = '';
  let rivalId = '';

  beforeAll(async () => {
    // Built the way production gets one: two provenance rows disagreeing, and
    // the migration — not the test — recording the conflict.
    winnerId = await newPlace('Quán Tranh Chấp A', 106.703, 10.776);
    rivalId = await newPlace('Quán Tranh Chấp B', 106.704, 10.7765);
    await db.insert(schema.placeProviderSources).values({
      placeId: winnerId,
      provider: 'google_places',
      externalId: 'ChIJblocked',
      attribution: { text: 'Data © Fake Provider' },
    });
    await db.insert(schema.placeSources).values({
      placeId: rivalId,
      provider: 'google',
      externalId: 'ChIJblocked',
      attribution: 'Data © Fake Provider',
    });
    await runMigration0033();
    places.seed({
      providerPlaceId: 'ChIJblocked',
      name: 'Quán Tranh Chấp',
      lat: 10.776,
      lng: 106.7005,
    });
  });

  it('the resolver reports a conflict instead of the canonical winner', async () => {
    const identity = await dedup.resolveGoogleIdentity('ChIJblocked');
    // The precise regression: canonical-first would silently answer `winnerId`.
    expect(identity.kind).toBe('CONFLICT');
    expect(identity.kind === 'CONFLICT' && identity.placeIds.sort()).toEqual(
      [winnerId, rivalId].sort(),
    );
  });

  it('the legacy import rejects with IDENTITY_CONFLICT and creates nothing', async () => {
    const before = await db.execute(sql`select count(*)::int as n from places`);
    const token = await register('conflict-import@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/places/imports',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { url: 'https://maps.google.com/maps?place_id=ChIJblocked' },
    });
    expect(res.json().status).toBe('rejected');
    expect(res.json().reasonCode).toBe('IDENTITY_CONFLICT');
    expect(res.json().placeId ?? null).toBeNull();
    const after = await db.execute(sql`select count(*)::int as n from places`);
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);
  });

  it('the link preview says UNRESOLVED, not ALREADY_EXISTS', async () => {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      remoteAddress: ip(),
      payload: { url: 'https://maps.google.com/maps?place_id=ChIJblocked' },
    });
    // ALREADY_EXISTS would send the user to whichever row the query returned
    // first; RESOLVED would invite them to submit a third place.
    expect(res.json().status).toBe('UNRESOLVED');
    expect(res.json().reasonCodes).toContain('PLACE_IDENTITY_CONFLICT');
    expect(res.json().existingPlaceId).toBeUndefined();
  });

  it('the mobile submission is refused 409, and no submission row is written', async () => {
    const token = await register('conflict-sub@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { googlePlaceId: 'ChIJblocked' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_IDENTITY_CONFLICT');
    const rows = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.googlePlaceId, 'ChIJblocked'));
    expect(rows).toHaveLength(0);
  });

  it('the bulk import row waits for a human, and is not called a duplicate', async () => {
    const editor = await createAdmin('conflict-editor@gogo.local', 'editor');
    const file = multipart(
      { mode: 'create_drafts', defaultCity: 'Hồ Chí Minh' },
      {
        name: 'conflict.csv',
        content: Buffer.from(
          [
            CSV_HEADER,
            'C-1,Quán Tranh Chấp,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=ChIJblocked,cafe,100000,200000,per_person',
          ].join('\n'),
          'utf8',
        ),
      },
    );
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), ...file.headers },
      payload: file.payload,
    });
    const jobId = created.json().id as string;
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/start`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    await imports.processJob(jobId);

    const [row] = await db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.jobId, jobId));
    // `duplicate` asserts which place the row duplicates, and that is exactly
    // what nobody has decided yet.
    expect(row!.status).toBe('needs_confirmation');
    expect(row!.errors.map((e) => e.code)).toContain('PLACE_IDENTITY_CONFLICT');
  });

  it('resolving the conflict by merging unblocks the same import', async () => {
    const admin = await createAdmin('conflict-merge@gogo.local', 'editor');
    const merged = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${winnerId}/merge`,
      remoteAddress: ip(),
      headers: auth(admin.token),
      payload: { duplicateId: rivalId },
    });
    expect(merged.statusCode).toBe(201);

    expect(await dedup.resolveGoogleIdentity('ChIJblocked')).toEqual({
      kind: 'RESOLVED',
      placeId: winnerId,
    });
    // A block is a queue, not a dead end: the door that was refused now works.
    const token = await register('conflict-after@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/places/imports',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { url: 'https://maps.google.com/maps?place_id=ChIJblocked' },
    });
    expect(res.json().status).toBe('verified');
    expect(res.json().placeId).toBe(winnerId);
  });
});

describe('merge moves the identity with the place (#334)', () => {
  it('leaves no provider row on the archived duplicate and dedup follows', async () => {
    const canonicalId = await newPlace('Quán Gộp Đích', 106.73, 10.81);
    const duplicateId = await newPlace('Quán Gộp Nguồn', 106.74, 10.82);
    await db.insert(schema.placeProviderSources).values({
      placeId: duplicateId,
      provider: 'google_places',
      externalId: 'ChIJmerge',
      attribution: { text: 'Data © Fake Provider' },
    });
    await db.insert(schema.placeHours).values({
      placeId: duplicateId,
      dayOfWeek: 1,
      openMinute: 480,
      closeMinute: 1320,
      source: 'provider',
    });
    const [cafe] = await db
      .select()
      .from(schema.taxonomies)
      .where(eq(schema.taxonomies.key, 'cafe'));
    await db.insert(schema.placeTaxonomies).values({ placeId: duplicateId, taxonomyId: cafe!.id });
    await db.insert(schema.travelLegs).values({
      fromPlaceId: duplicateId,
      toPlaceId: canonicalId,
      minutes: 12,
      distanceM: 3000,
    });

    // Write is per-role, not hierarchical: catalog edits belong to `editor`.
    const admin = await createAdmin('merge-admin@gogo.local', 'editor');
    const merged = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${canonicalId}/merge`,
      remoteAddress: ip(),
      headers: auth(admin.token),
      payload: { duplicateId },
    });
    expect(merged.statusCode).toBe(201);

    const onDuplicate = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.placeId, duplicateId));
    expect(onDuplicate).toHaveLength(0);
    const onCanonical = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'ChIJmerge'));
    expect(onCanonical).toHaveLength(1);
    expect(onCanonical[0]!.placeId).toBe(canonicalId);

    // The canonical place had no hours, so the duplicate's move over.
    const hours = await db
      .select()
      .from(schema.placeHours)
      .where(eq(schema.placeHours.placeId, canonicalId));
    expect(hours).toHaveLength(1);
    const taxonomies = await db
      .select()
      .from(schema.placeTaxonomies)
      .where(eq(schema.placeTaxonomies.placeId, canonicalId));
    expect(taxonomies).toHaveLength(1);
    // A cached duration measured from the duplicate's coordinates is not the
    // canonical place's travel time, and a self-leg is nonsense.
    const legs = await db.execute(sql`
      select count(*)::int as n from travel_legs
      where from_place_id = ${duplicateId}::uuid or to_place_id = ${duplicateId}::uuid
    `);
    expect((legs.rows[0] as { n: number }).n).toBe(0);

    const [archived] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, duplicateId));
    expect(archived!.status).toBe('archived');

    // The whole reason the row had to move: the next import of that ID must
    // land on the place that is still in the catalogue.
    expect(await dedup.resolveGoogleIdentity('ChIJmerge')).toEqual({
      kind: 'RESOLVED',
      placeId: canonicalId,
    });
  });

  it('closes the identity conflict a merge resolves', async () => {
    const [conflict] = await db
      .select()
      .from(schema.placeIdentityConflicts)
      .where(eq(schema.placeIdentityConflicts.externalId, 'ChIJclash'));
    const admin = await createAdmin('merge-conflict@gogo.local', 'editor');
    const merged = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${conflict!.canonicalPlaceId}/merge`,
      remoteAddress: ip(),
      headers: auth(admin.token),
      payload: { duplicateId: conflict!.legacyPlaceId },
    });
    expect(merged.statusCode).toBe(201);
    const [resolved] = await db
      .select()
      .from(schema.placeIdentityConflicts)
      .where(eq(schema.placeIdentityConflicts.id, conflict!.id));
    expect(resolved!.resolution).toBe('merged');
    expect(resolved!.resolvedAt).not.toBeNull();
  });
});
