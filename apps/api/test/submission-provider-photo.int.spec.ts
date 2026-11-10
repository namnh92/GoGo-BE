import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import argon2 from 'argon2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import {
  CACHE_PURGE,
  GooglePlacesAdapter,
  PLACE_PHOTO_DISPLAY,
  PLACE_PROVIDER,
  PUBLIC_STORAGE_PROVIDER,
  type FakePlacePhotoDisplay,
  type FakePlaceProvider,
  type FakeStorage,
} from '@gogo/providers';
import { SubmissionPhotoService } from '../../../libs/modules/ingestion/application/submission-photo.service';
import { APP_CONFIG } from '../../../libs/modules/shared/config';
import { PlaceDedupService } from '../../../libs/modules/ingestion/application/place-dedup.service';
import {
  MEDIA_CLEANUP_MAX_ATTEMPTS,
  MediaCleanupService,
} from '../../../libs/modules/profile/application/media-cleanup.service';
import { DbPhotoBackfillStore } from '../../../libs/modules/places/application/place-provider-photo-backfill';
import { PROVIDER_PHOTO_RESERVATION_ACTION } from '../../../libs/modules/places/application/provider-photo-reservation';
import { cmsAccessHeaders } from './support/cms-access';

// Real Postgres/migration, real Google photo HTTP adapter with stubbed fetch,
// real API orchestration, FakeStorage recording object headers. No real Google I/O.
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let userToken: string;
let editorToken: string;
let moderatorToken: string;
let provider: FakePlaceProvider;
let storage: FakeStorage;
let photos: SubmissionPhotoService;
let cleanup: MediaCleanupService;
let refs: ReturnType<typeof vi.spyOn>;
let media: ReturnType<typeof vi.spyOn>;
let sequence = 0;
const ip = () => `10.82.${Math.floor(++sequence / 250)}.${(sequence % 250) + 1}`;
const api = () => app.getHttpAdapter().getInstance();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const marker = 'never-persist-photo-name-822';
const imageUrl = 'https://lh3.googleusercontent.com/never-persist-retrieval-822';
const requestSubmit = (googlePlaceId: string, resolutionToken?: string) =>
  api().inject({
    method: 'POST',
    url: '/v1/place-submissions',
    remoteAddress: ip(),
    headers: auth(userToken),
    payload: { googlePlaceId, resolutionToken },
  });
const decide = (id: string, decision: string, extra: Record<string, unknown> = {}) =>
  api().inject({
    method: 'POST',
    url: `/v1/cms/place-submissions/${id}/decide`,
    remoteAddress: ip(),
    headers: auth(moderatorToken),
    payload: {
      decision,
      reason: 'Reviewed independently',
      ...(decision === 'rejected' ? { rejectionReason: 'other' } : {}),
      ...extra,
    },
  });
async function row(id: string) {
  return (
    await db.select().from(schema.placeSubmissions).where(eq(schema.placeSubmissions.id, id))
  )[0]!;
}
function seed() {
  const id = `ChIJ-${randomUUID()}`;
  provider.seed({
    providerPlaceId: id,
    name: `Venue ${id}`,
    lat: 21.02,
    lng: 105.84,
    rating: 4.4,
    ratingCount: 30,
  });
  return id;
}
async function contribute(id = seed()) {
  const preview = await api().inject({
    method: 'POST',
    url: '/v1/places/resolve-google-maps-link',
    remoteAddress: ip(),
    payload: { url: `https://www.google.com/maps?place_id=${id}` },
  });
  expect(preview.statusCode, preview.body).toBe(201);
  expect(preview.json().resolutionToken).toBeTruthy();
  provider.tiersRequested.length = 0;
  const response = await requestSubmit(id, preview.json().resolutionToken);
  expect(response.statusCode, response.body).toBe(201);
  expect(provider.tiersRequested).toEqual([]); // ADR-0048 zero Details at submit stays.
  return { id: response.json().submissionId as string, googlePlaceId: id, response };
}
async function target(hasCover = false) {
  const [p] = await db
    .insert(schema.places)
    .values({
      name: randomUUID(),
      nameNormalized: 'trigger',
      status: 'published',
      geom: { x: 105.84, y: 21.02 },
    })
    .returning();
  if (hasCover)
    await db.insert(schema.placeMedia).values({
      placeId: p!.id,
      storageKey: 'places/existing.jpg',
      sourceType: 'editorial',
      moderation: 'rejected',
      isCover: true,
    });
  return p!.id;
}
async function cmsCreate(id: string, key = randomUUID()) {
  return api().inject({
    method: 'POST',
    url: '/v1/cms/places',
    remoteAddress: ip(),
    headers: { ...auth(editorToken), 'idempotency-key': key },
    payload: {
      name: `Independent ${id}`,
      lat: 21.03,
      lng: 105.85,
      googlePlaceId: id,
      allowDuplicate: true,
      sourceReferences: { name: 'Independent owner interview', geom: 'Independent survey' },
    },
  });
}
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_provider_cover_822')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.METRICS_TOKEN = 'metrics-token-int-tests';
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://assets.gogo.test';
  process.env.PLACE_RESOLUTION_ATTESTATION_SECRET =
    'submission-photo-822-attestation-secret-0123456789';
  process.env.PLACE_DISPLAY_DAILY_MAX_CALLS = '1000';
  process.env.PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD = '100';
  process.env.PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA = '1000';
  vi.stubEnv('FLAG_PLACE_PROVIDER_PHOTO_ACQUIRE', undefined);
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  db = drizzle(pool, { schema });
  // Forward-test 0095 on a real pre-0095 snapshot containing a legacy row.
  const folder = path.resolve(__dirname, '../../../migrations');
  const journal = JSON.parse(await readFile(path.join(folder, 'meta/_journal.json'), 'utf8'));
  const prior = journal.entries.filter((e: { idx: number }) => e.idx < 95);
  const snapshot = await mkdtemp(path.join(os.tmpdir(), 'be-822-migration-'));
  try {
    await mkdir(path.join(snapshot, 'meta'));
    await writeFile(
      path.join(snapshot, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: prior }),
    );
    for (const e of prior)
      await cp(path.join(folder, `${e.tag}.sql`), path.join(snapshot, `${e.tag}.sql`));
    await migrate(db, { migrationsFolder: snapshot });
    await pool.query("insert into place_submissions(google_place_id) values ('legacy-822')");
    await migrate(db, { migrationsFolder: folder });
    expect(
      (
        await pool.query(
          "select provider_photo, provider_photo_claim_id, provider_photo_claimed_at, provider_photo_attempts from place_submissions where google_place_id='legacy-822'",
        )
      ).rows,
    ).toEqual([
      {
        provider_photo: null,
        provider_photo_claim_id: null,
        provider_photo_claimed_at: null,
        provider_photo_attempts: 0,
      },
    ]);
    expect(
      (
        await pool.query(
          "select indexname from pg_indexes where indexname='place_submissions_provider_photo_key_idx'",
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
  await db
    .insert(schema.taxonomies)
    .values({ kind: 'category', key: 'cafe' })
    .onConflictDoNothing();
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  provider = app.get(PLACE_PROVIDER);
  storage = app.get(PUBLIC_STORAGE_PROVIDER);
  photos = app.get(SubmissionPhotoService);
  cleanup = app.get(MediaCleanupService);
  const registration = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: {
      email: 'cover-822@gogo.id.vn',
      password: 'Long-enough-password1!',
      displayName: 'Contributor',
    },
  });
  expect(registration.statusCode, registration.body).toBe(201);
  userToken = registration.json().accessToken;
  for (const role of ['editor', 'moderator'] as const) {
    const email = `${role}-822@gogo.local`;
    await db.insert(schema.adminUsers).values({
      email,
      passwordHash: await argon2.hash('admin-password-123'),
      displayName: role,
      role,
    });
    const login = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      headers: cmsAccessHeaders(email),
      payload: { email, password: 'admin-password-123' },
    });
    expect(login.statusCode, login.body).toBe(201);
    if (role === 'editor') editorToken = login.json().accessToken;
    else moderatorToken = login.json().accessToken;
  }
}, 180_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await db.execute(sql`truncate place_submissions, places cascade`);
  await db.execute(sql`delete from media_cleanup_queue`);
  await db.execute(sql`delete from audit_logs`);
  await db.execute(sql`delete from provider_budget_daily`);
  await db.execute(
    sql`delete from feature_flags where key in ('place_provider_photos.enabled', 'place_provider_photo_acquire.enabled', 'place_resolution_attestation.enabled')`,
  );
  await db.insert(schema.featureFlags).values(
    [
      'place_provider_photos.enabled',
      'place_provider_photo_acquire.enabled',
      'place_resolution_attestation.enabled',
    ].map((key) => ({
      key,
      environment: 'all' as const,
      platform: 'all' as const,
      enabled: true,
    })),
  );
  storage.objects.clear();
  storage.failWrites = false;
  const google = new GooglePlacesAdapter('test-key-never-persist');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === imageUrl)
        return new Response(new Uint8Array([255, 216, 255, 1]), {
          headers: { 'content-type': 'image/jpeg' },
        });
      if (url.includes('/media?')) return Response.json({ photoUri: imageUrl });
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
      return Response.json({
        id,
        photos: [
          {
            name: `places/${id}/photos/${marker}`,
            widthPx: 1600,
            heightPx: 900,
            authorAttributions: [
              { displayName: 'Lan', uri: 'https://maps.google.com/contrib/lan', photoUri: null },
            ],
            googleMapsUri: 'https://www.google.com/maps/photo/one',
          },
        ],
      });
    }),
  );
  const fake = app.get(PLACE_PHOTO_DISPLAY) as FakePlacePhotoDisplay;
  refs = vi.spyOn(fake, 'photoRefs').mockImplementation((...args) => google.photoRefs(...args));
  media = vi.spyOn(fake, 'photoMedia').mockImplementation((...args) => google.photoMedia(...args));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storage.failWrites = false;
});

describe('ADR-0052 S1 provider cover', () => {
  it('stores a provider cover on submit by default without a flag row or env override', async () => {
    await db.execute(
      sql`delete from feature_flags where key = 'place_provider_photo_acquire.enabled'`,
    );
    expect(process.env.FLAG_PLACE_PROVIDER_PHOTO_ACQUIRE).toBeUndefined();
    expect(app.get(APP_CONFIG).FLAG_PLACE_PROVIDER_PHOTO_ACQUIRE).toBe(true);
    const googlePlaceId = seed();
    const response = await requestSubmit(googlePlaceId);
    expect(response.statusCode, response.body).toBe(201);
    const pending = await row(response.json().submissionId);
    expect(pending.providerPhoto).toMatchObject({
      sourceReference: googlePlaceId,
      attribution: 'Google Maps',
      authorAttributions: [{ displayName: 'Lan' }],
    });
    expect(pending.providerPhotoAttempts).toBe(1);
    expect(pending.providerPhotoClaimId).toBeNull();
    expect(refs).toHaveBeenCalledTimes(1);
    expect(media).toHaveBeenCalledTimes(1);
    expect(storage.objects.has(pending.providerPhoto!.storageKey)).toBe(true);
  });

  it('claim, compensation and completion preserve the review revision and timestamp', async () => {
    const [pending] = await db
      .insert(schema.placeSubmissions)
      .values({ googlePlaceId: seed() })
      .returning();
    const claimId = await photos.claim(pending!.id);
    expect(claimId).toBeTruthy();
    expect(await row(pending!.id)).toMatchObject({
      submissionRevision: pending!.submissionRevision,
      updatedAt: pending!.updatedAt,
      providerPhotoAttempts: 1,
    });
    await photos.release(pending!.id, claimId!);
    await photos.acquireSubmission(pending!.id, pending!.googlePlaceId);
    const completed = await row(pending!.id);
    expect(completed).toMatchObject({
      submissionRevision: pending!.submissionRevision,
      updatedAt: pending!.updatedAt,
      providerPhotoAttempts: 2,
      providerPhotoClaimId: null,
    });
    expect(completed.providerPhoto).not.toBeNull();
    // Even a raw content write without an updated_at bump must invalidate review.
    await db
      .update(schema.placeSubmissions)
      .set({ note: 'Contributor changed the proposal' })
      .where(eq(schema.placeSubmissions.id, pending!.id));
    expect((await row(pending!.id)).submissionRevision).toBe(pending!.submissionRevision + 1);
  });
  it.each([false, true])(
    'approval fallback ignores its own claim but detects a concurrent content edit: %s',
    async (edit) => {
      const [pending] = await db
        .insert(schema.placeSubmissions)
        .values({ googlePlaceId: seed() })
        .returning();
      const prepare = photos.prepare.bind(photos);
      vi.spyOn(photos, 'prepare').mockImplementation(async (...args) => {
        const claimed = await row(pending!.id);
        expect(claimed.submissionRevision).toBe(pending!.submissionRevision);
        expect(claimed.providerPhotoClaimId).toBeTruthy();
        expect(claimed.providerPhotoAttempts).toBe(1);
        if (edit)
          await db
            .update(schema.placeSubmissions)
            .set({ reviewDraft: { name: 'A different moderation draft' } })
            .where(eq(schema.placeSubmissions.id, pending!.id));
        return prepare(...args);
      });
      const response = await decide(pending!.id, 'approved');
      expect(response.statusCode, response.body).toBe(edit ? 409 : 201);
      const current = await row(pending!.id);
      expect(current.providerPhotoAttempts).toBe(1);
      expect(current.providerPhotoClaimId).toBeNull();
      expect(await db.select().from(schema.placeMedia)).toHaveLength(edit ? 0 : 1);
      if (edit) {
        expect(response.json().code).toBe('SUBMISSION_CHANGED');
        expect(current.status).toBe('pending');
        expect(storage.objects.size).toBe(0);
      } else {
        expect(current.status).toBe('approved');
        expect(current.providerPhoto).not.toBeNull();
      }
    },
  );
  it('stores one attributed immutable cover on submit; dedup and views buy zero photos', async () => {
    const c = await contribute();
    const stored = (await row(c.id)).providerPhoto!;
    expect(media).toHaveBeenCalledTimes(1);
    expect(c.response.json().photo).toMatchObject({
      source: 'google',
      authorAttributions: [{ displayName: 'Lan' }],
    });
    expect(storage.objects.get(stored.storageKey)?.cacheControl).toBe(
      'public, max-age=31536000, immutable',
    );
    expect((await row(c.id)).providerPhotoAttempts).toBe(1);
    const bought = refs.mock.calls.length;
    expect((await requestSubmit(c.googlePlaceId)).statusCode).toBe(201);
    for (const url of [
      '/v1/me/place-submissions',
      `/v1/me/place-submissions/${c.id}`,
      `/v1/cms/place-submissions/${c.id}`,
      '/v1/cms/place-submissions',
    ]) {
      const res = await api().inject({
        method: 'GET',
        url,
        remoteAddress: ip(),
        headers: auth(url.includes('/cms/') ? moderatorToken : userToken),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('/google-provider-photo/');
    }
    expect(refs).toHaveBeenCalledTimes(bought);
    expect(media).toHaveBeenCalledTimes(1);
    const text =
      JSON.stringify(await db.select().from(schema.placeSubmissions)) +
      JSON.stringify(await db.select().from(schema.placeMedia));
    expect(text).not.toContain(marker);
    expect(text).not.toContain(imageUrl);
    expect(text).not.toContain('test-key-never-persist');
  });
  it('concurrent first submits commit one claim before I/O; one prepare and zero discards', async () => {
    const id = seed();
    const original = photos.prepare.bind(photos);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const purchase = vi.spyOn(photos, 'prepare').mockImplementation(async (...args) => {
      started();
      await gate;
      return original(...args);
    });
    const discard = vi.spyOn(photos, 'discard');
    const first = requestSubmit(id);
    await entered;
    const second = await requestSubmit(id);
    expect(second.statusCode, second.body).toBe(201);
    const pending = (await db.select().from(schema.placeSubmissions))[0]!;
    expect(pending.providerPhotoAttempts).toBe(1);
    expect(pending.providerPhotoClaimId).toBeTruthy();
    release();
    const done = await first;
    expect(done.statusCode, done.body).toBe(201);
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
  });
  it.each(['provider', 'storage', 'claim', 'completion'] as const)(
    'submit stays successful on %s failure',
    async (failure) => {
      if (failure === 'provider') media.mockRejectedValue(new Error('private provider URL'));
      if (failure === 'storage') storage.failWrites = true;
      if (failure === 'claim')
        vi.spyOn(photos, 'claim').mockRejectedValue(new Error('claim failed'));
      if (failure === 'completion')
        vi.spyOn(photos, 'complete').mockRejectedValue(new Error('completion failed'));
      const c = await contribute();
      expect((await row(c.id)).status).toBe('pending');
      expect(c.response.json().photo).toBeUndefined();
    },
  );
  it('reject during fetch loses completion fence, discards bytes, leaves no queue row', async () => {
    const id = seed();
    const original = photos.prepare.bind(photos);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      started = r;
    });
    vi.spyOn(photos, 'prepare').mockImplementation(async (...args) => {
      const p = await original(...args);
      started();
      await gate;
      return p;
    });
    const pending = requestSubmit(id);
    await entered;
    const s = (await db.select().from(schema.placeSubmissions))[0]!;
    expect((await decide(s.id, 'rejected')).statusCode).toBe(201);
    release();
    expect((await pending).statusCode).toBe(201);
    expect((await row(s.id)).providerPhoto).toBeNull();
    expect(storage.objects.size).toBe(0);
    expect(await db.select().from(schema.mediaCleanupQueue)).toEqual([]);
  });
  it('approve reuses the exact submitted key and credits without another photo purchase', async () => {
    const c = await contribute();
    const key = (await row(c.id)).providerPhoto!.storageKey;
    const calls = media.mock.calls.length;
    const approved = await decide(c.id, 'approved');
    expect(approved.statusCode, approved.body).toBe(201);
    const saved = await db.select().from(schema.placeMedia);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      storageKey: key,
      sourceType: 'google_derived',
      isCover: true,
    });
    expect(media).toHaveBeenCalledTimes(calls);
    const history = await api().inject({
      method: 'GET',
      url: `/v1/me/place-submissions/${c.id}`,
      remoteAddress: ip(),
      headers: auth(userToken),
    });
    expect(history.json().photo).toMatchObject({
      source: 'google',
      authorAttributions: [{ displayName: 'Lan' }],
    });
    expect(history.json().photoUrl).toBeUndefined();
  });
  it.each([false, true])(
    'merge target with rejected cover=%s attaches or retires the submitted key',
    async (hasCover) => {
      const c = await contribute();
      const key = (await row(c.id)).providerPhoto!.storageKey;
      const placeId = await target(hasCover);
      const response = await decide(c.id, 'merged', { mergeIntoPlaceId: placeId });
      expect(response.statusCode, response.body).toBe(201);
      const saved = await db
        .select()
        .from(schema.placeMedia)
        .where(eq(schema.placeMedia.storageKey, key));
      expect(saved).toHaveLength(hasCover ? 0 : 1);
      if (hasCover) {
        expect(Date.parse((await row(c.id)).providerPhoto!.deleteAfter!)).toBeLessThanOrEqual(
          Date.now(),
        );
        await cleanup.runDue(100);
        expect(storage.objects.has(key)).toBe(false);
      } else expect((await row(c.id)).providerPhoto!.deleteAfter).toBeUndefined();
    },
  );
  it('reject replaces a maintenance intent, defers early worker, shows photo only inside seven days', async () => {
    const c = await contribute();
    const s = await row(c.id);
    const key = s.providerPhoto!.storageKey;
    await db
      .insert(schema.mediaCleanupQueue)
      .values({ bucket: 'public', objectKey: key, reason: 'header_rewrite_uncommitted' });
    const immediate = vi.spyOn(cleanup, 'attemptNow');
    const rejected = await decide(c.id, 'rejected');
    expect(rejected.statusCode, rejected.body).toBe(201);
    expect(immediate).not.toHaveBeenCalled();
    const retired = await row(c.id);
    const deadline = new Date(retired.decidedAt!.getTime() + 7 * 86400_000).toISOString();
    expect(retired.providerPhoto!.deleteAfter).toBe(deadline);
    const [job] = await db.select().from(schema.mediaCleanupQueue);
    expect(job).toMatchObject({
      reason: 'submission_provider_photo_rejected',
      attempts: 0,
      nextAttemptAt: new Date(deadline),
    });
    await cleanup.attemptNow([job!.id]);
    expect(storage.objects.has(key)).toBe(true);
    expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(1);
    const view = () =>
      api().inject({
        method: 'GET',
        url: `/v1/me/place-submissions/${c.id}`,
        remoteAddress: ip(),
        headers: auth(userToken),
      });
    expect((await view()).json()).toMatchObject({
      updateDeadline: deadline,
      photo: { source: 'google' },
    });
    const past = new Date(Date.now() - 8 * 86400_000);
    await db
      .update(schema.placeSubmissions)
      .set({
        decidedAt: past,
        providerPhoto: {
          ...retired.providerPhoto!,
          deleteAfter: new Date(Date.now() - 1000).toISOString(),
        },
      })
      .where(eq(schema.placeSubmissions.id, c.id));
    expect((await view()).json().photo).toBeUndefined();
    await db.delete(schema.mediaCleanupQueue);
    expect(await cleanup.reconcileRetirements()).toBe(1);
    const restored = await db.select().from(schema.mediaCleanupQueue);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      bucket: 'public',
      objectKey: key,
      attempts: 0,
      failedAt: null,
    });
    expect(await cleanup.reconcileRetirements()).toBe(0);
    const purge = vi.spyOn(app.get(CACHE_PURGE), 'purgeUrls');
    await cleanup.runDue(100);
    expect(purge).toHaveBeenCalledWith([`https://assets.gogo.test/${key}`]);
    expect(storage.objects.has(key)).toBe(false);
    expect((await row(c.id)).providerPhoto).toBeNull();
    expect(await cleanup.reconcileRetirements()).toBe(0);
  });
  it('keeps an exhausted retirement dead-lettered across reconciliation ticks (#825 F-02)', async () => {
    const c = await contribute();
    await decide(c.id, 'rejected');
    const retired = (await row(c.id)).providerPhoto!;
    const key = retired.storageKey;
    await db
      .update(schema.placeSubmissions)
      .set({
        providerPhoto: { ...retired, deleteAfter: new Date(Date.now() - 1000).toISOString() },
      })
      .where(eq(schema.placeSubmissions.id, c.id));
    const deletion = vi
      .spyOn(storage, 'deleteObject')
      .mockRejectedValue(new Error('storage unavailable'));
    for (let attempt = 1; attempt <= MEDIA_CLEANUP_MAX_ATTEMPTS; attempt++) {
      await db.update(schema.mediaCleanupQueue).set({ nextAttemptAt: new Date(0) });
      expect(await cleanup.runDue(100)).toMatchObject({
        attempted: 1,
        retried: attempt < MEDIA_CLEANUP_MAX_ATTEMPTS ? 1 : 0,
        deadLettered: attempt === MEDIA_CLEANUP_MAX_ATTEMPTS ? 1 : 0,
      });
    }
    const exhausted = await db.select().from(schema.mediaCleanupQueue);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({
      attempts: MEDIA_CLEANUP_MAX_ATTEMPTS,
      failedAt: expect.any(Date),
    });
    for (let tick = 0; tick < 2; tick++) {
      expect(await cleanup.reconcileRetirements()).toBe(0);
      expect(await cleanup.runDue(100)).toMatchObject({ attempted: 0 });
    }
    expect(await db.select().from(schema.mediaCleanupQueue)).toEqual(exhausted);
    expect((await row(c.id)).providerPhoto).toEqual({
      ...retired,
      deleteAfter: expect.any(String),
    });
    expect(storage.objects.has(key)).toBe(true);
    expect(deletion).toHaveBeenCalledTimes(MEDIA_CLEANUP_MAX_ATTEMPTS);
  });
  it('CMS final detach retires the submission reference and replaces an open rewrite intent', async () => {
    const c = await contribute();
    const approved = await decide(c.id, 'approved');
    const placeId = approved.json().placeId;
    const [m] = await db.select().from(schema.placeMedia);
    await db.insert(schema.mediaCleanupQueue).values({
      bucket: 'public',
      objectKey: m!.storageKey,
      reason: 'header_rewrite_uncommitted',
      nextAttemptAt: new Date(Date.now() + 3600_000),
    });
    const response = await api().inject({
      method: 'DELETE',
      url: `/v1/cms/places/${placeId}/media/${m!.id}`,
      remoteAddress: ip(),
      headers: auth(editorToken),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await row(c.id)).providerPhoto!.deleteAfter).toBeTruthy();
    const [job] = await db.select().from(schema.mediaCleanupQueue);
    expect(job!.reason).toBe('submission_provider_photo_detached');
    await cleanup.runDue(100);
    expect(storage.objects.has(m!.storageKey)).toBe(false);
  });
  it('approval purchases commit attempts before I/O, retain failures and proceed coverless at cap', async () => {
    await db.execute(
      sql`update feature_flags set enabled = false where key = 'place_provider_photo_acquire.enabled'`,
    );
    const c = await contribute();
    media.mockRejectedValue(new Error('provider unavailable'));
    for (const attempt of [1, 2]) {
      const failure = await decide(c.id, 'approved');
      expect(failure.statusCode, failure.body).toBe(503);
      expect(await row(c.id)).toMatchObject({
        status: 'pending',
        providerPhotoAttempts: attempt,
        providerPhotoClaimId: null,
      });
    }
    const approved = await decide(c.id, 'approved');
    expect(approved.statusCode, approved.body).toBe(201);
    expect((await row(c.id)).providerPhotoAttempts).toBe(2);
    expect(media).toHaveBeenCalledTimes(2);
  });
  it('approval transaction rollback discards purchase without rolling back the consumed attempt', async () => {
    await db.execute(
      sql`update feature_flags set enabled = false where key = 'place_provider_photo_acquire.enabled'`,
    );
    const c = await contribute();
    vi.spyOn(app.get(PlaceDedupService), 'assertGoogleIdentityOwner').mockRejectedValueOnce(
      new Error('forced rollback'),
    );
    const response = await decide(c.id, 'approved');
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await row(c.id)).toMatchObject({
      status: 'pending',
      providerPhotoAttempts: 1,
      providerPhotoClaimId: null,
    });
    expect(storage.objects.size).toBe(0);
  });
  it('CMS implicit create acquires once, replay never repeats and #797 skips the shared reservation after publish', async () => {
    const id = seed();
    const key = randomUUID();
    const created = await cmsCreate(id, key);
    expect(created.statusCode, created.body).toBe(201);
    const placeId = created.json().id;
    const calls = media.mock.calls.length;
    expect(calls).toBe(1);
    expect((await cmsCreate(id, key)).statusCode).toBe(201);
    expect(media).toHaveBeenCalledTimes(calls);
    const reservation = await db.execute(
      sql`select action, diff from audit_logs where resource_id = ${placeId} and action = ${PROVIDER_PHOTO_RESERVATION_ACTION}`,
    );
    expect(reservation.rows).toMatchObject([{ diff: { source: 'cms_create' } }]);
    await db
      .update(schema.places)
      .set({ status: 'published' })
      .where(eq(schema.places.id, placeId));
    const store = new DbPhotoBackfillStore(db, photos);
    expect((await store.scan(null, 100)).some((p) => p.id === placeId)).toBe(false);
  });
  it('concurrent CMS creates have one durable reservation even if photo purchase fails', async () => {
    const id = seed();
    const key = randomUUID();
    media.mockRejectedValue(new Error('provider down'));
    const responses = await Promise.all([cmsCreate(id, key), cmsCreate(id, key)]);
    expect(responses.some((r) => r.statusCode === 201)).toBe(true);
    expect(responses.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
    expect(
      (
        await db.execute(
          sql`select id from audit_logs where action = ${PROVIDER_PHOTO_RESERVATION_ACTION}`,
        )
      ).rows,
    ).toHaveLength(1);
    expect(media).toHaveBeenCalledTimes(1);
    const created = responses.find((r) => r.statusCode === 201)!.json().id;
    await db
      .update(schema.places)
      .set({ status: 'published' })
      .where(eq(schema.places.id, created));
    expect(
      await new DbPhotoBackfillStore(db, photos).claimIfEligible({ id: created, externalId: id }),
    ).toBe(false);
  });
  it('honours legacy #797 reservations and keeps its published-only eligibility', async () => {
    const created = await cmsCreate(seed());
    const placeId = created.json().id;
    await db.delete(schema.placeMedia).where(eq(schema.placeMedia.placeId, placeId));
    await db.execute(
      sql`delete from audit_logs where action = ${PROVIDER_PHOTO_RESERVATION_ACTION}`,
    );
    const store = new DbPhotoBackfillStore(db, photos);
    expect(await store.scan(null, 100)).toEqual([]); // still draft
    await db
      .update(schema.places)
      .set({ status: 'published' })
      .where(eq(schema.places.id, placeId));
    expect(await store.scan(null, 100)).toHaveLength(1);
    await db.insert(schema.auditLogs).values({
      actorType: 'system',
      action: 'place.provider_photo_backfill_attempt',
      resourceType: 'place',
      resourceId: placeId,
      diff: {},
    });
    expect(await store.scan(null, 100)).toEqual([]);
  });
  it('claim handles active, expired, cap and decided predicates on real Postgres', async () => {
    const [s] = await db
      .insert(schema.placeSubmissions)
      .values({ googlePlaceId: seed() })
      .returning();
    const mine = await photos.claim(s!.id);
    expect(mine).toBeTruthy();
    expect(await photos.claim(s!.id)).toBeUndefined();
    await db
      .update(schema.placeSubmissions)
      .set({ providerPhotoClaimedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(schema.placeSubmissions.id, s!.id));
    expect(await photos.claim(s!.id)).toBeTruthy();
    await photos.release(s!.id, (await row(s!.id)).providerPhotoClaimId!);
    expect(await photos.claim(s!.id)).toBeUndefined();
    expect((await row(s!.id)).providerPhotoAttempts).toBe(2);
    await db
      .update(schema.placeSubmissions)
      .set({ status: 'rejected', providerPhotoAttempts: 0 })
      .where(eq(schema.placeSubmissions.id, s!.id));
    expect(await photos.claim(s!.id)).toBeUndefined();
  });
});
