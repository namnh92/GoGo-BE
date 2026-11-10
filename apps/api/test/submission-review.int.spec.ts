import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema, type SubmissionEnrichment } from '@gogo/database';
import {
  PLACE_PHOTO_DISPLAY,
  PUBLIC_STORAGE_PROVIDER,
  type FakePlacePhotoDisplay,
  type FakeStorage,
  PLACE_PROVIDER,
} from '@gogo/providers';
import { PlaceImportJobService } from '@gogo/modules';
import type { FakePlaceProvider } from '@gogo/providers';
import { cmsAccessHeaders } from './support/cms-access';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

/**
 * PI-BE-031 (#528) — reviewing a contribution, over real HTTP.
 *
 * The queue could approve, reject or merge and nothing else. A reviewer could
 * not see the place they were judging — the screen showed a Google Place ID —
 * and could not improve it before it became a catalogue row, so a contribution
 * arrived as an id and left as a place nobody had been able to touch.
 *
 * What these cases hold: the detail endpoint costs no provider request, the
 * preview costs exactly one and is counted apart, the reviewer's edits survive
 * approval and arrive on Place Detail with their own provenance, and none of
 * the three decisions gained a way to corrupt anything.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: FakePlaceProvider;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.64.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const tokens: Record<'moderator' | 'editor', string> = { moderator: '', editor: '' };

async function createAdmin(role: 'moderator' | 'editor') {
  const email = `review-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db.insert(schema.adminUsers).values({ email, passwordHash, displayName: role, role });
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    headers: cmsAccessHeaders(email),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'Sufficiently-long-pw1!', displayName: 'U' },
  });
  return res.json().accessToken as string;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

let seq = 0;

/** GoGo-BE#280 — the evidence a reviewer's contact value must carry. */
const EVIDENCE = {
  sourceType: 'editorial',
  sourceReference: 'Gọi điện chủ quán 2026-09-30',
  collectedAt: '2026-09-30T02:00:00Z',
};

/**
 * A contribution as it really arrives: the app resolves a link, the person
 * submits what it named, and it lands in the queue as `pending`.
 */
async function contribute(
  over: Partial<{
    name: string;
    category: string;
    estimatedPrice: { min: number; max: number; unit: string };
    note: string;
    vibes: string[];
    enrichment: SubmissionEnrichment;
  }> = {},
): Promise<{ submissionId: string; googlePlaceId: string; token: string }> {
  seq += 1;
  const googlePlaceId = `fake-review-${seq}`;
  places.seed({
    providerPlaceId: googlePlaceId,
    name: over.name ?? `Quán Google ${seq}`,
    addressText: `${seq} Đường Google, Hà Nội`,
    lat: 21.02 + seq / 1000,
    lng: 105.84 + seq / 1000,
    rating: 4.3,
    ratingCount: 812,
    googleMapsUri: `https://maps.google.com/?cid=${1000000000000000000 + seq}`,
  });

  const token = await register(`review-contrib-${seq}@gogo.id.vn`);
  const submitted = await api().inject({
    method: 'POST',
    url: '/v1/place-submissions',
    remoteAddress: ip(),
    headers: auth(token),
    payload: {
      googlePlaceId,
      ...(over.category ? { category: over.category } : {}),
      ...(over.estimatedPrice ? { estimatedPrice: over.estimatedPrice } : {}),
      ...(over.note ? { note: over.note } : {}),
      ...(over.vibes ? { vibes: over.vibes } : {}),
      ...(over.enrichment ? { enrichment: over.enrichment } : {}),
    },
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return { submissionId: submitted.json().submissionId as string, googlePlaceId, token };
}

const detail = (id: string, role: 'moderator' | 'editor' = 'moderator') =>
  api().inject({
    method: 'GET',
    url: `/v1/cms/place-submissions/${id}`,
    remoteAddress: ip(),
    headers: auth(tokens[role]),
  });

const saveReview = (
  id: string,
  body: Record<string, unknown>,
  role: 'moderator' | 'editor' = 'moderator',
) =>
  api().inject({
    method: 'PUT',
    url: `/v1/cms/place-submissions/${id}/review`,
    remoteAddress: ip(),
    headers: auth(tokens[role]),
    payload: body,
  });

const decide = (
  id: string,
  payload: Record<string, unknown>,
  role: 'moderator' | 'editor' = 'moderator',
) =>
  api().inject({
    method: 'POST',
    url: `/v1/cms/place-submissions/${id}/decide`,
    remoteAddress: ip(),
    headers: auth(tokens[role]),
    payload,
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_submission_review_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://assets.gogo.test';
  process.env.PLACE_DISPLAY_DAILY_MAX_CALLS = '100';
  process.env.PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD = '1';
  process.env.PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA = '100';
  // These moderation/preview tests exercise approval fallback, not submit acquisition.
  process.env.FLAG_PLACE_PROVIDER_PHOTO_ACQUIRE = 'false';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  // The import path derives a category from Google's type and checks it
  // against the live taxonomy, so the vocabulary has to exist here too.
  for (const key of ['cafe', 'restaurant']) {
    await db.insert(schema.taxonomies).values({ kind: 'category', key });
  }
  for (const key of ['chill']) {
    await db.insert(schema.taxonomies).values({ kind: 'mood', key });
  }

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

describe('what a reviewer can see (#528)', () => {
  it('shows the contribution, the identity and the history without asking Google', async () => {
    const { submissionId, googlePlaceId } = await contribute({
      category: 'cafe',
      estimatedPrice: { min: 50_000, max: 120_000, unit: 'per_person' },
      note: 'Quán mới mở, view hồ',
      vibes: ['chill'],
    });
    places.tiersRequested.length = 0;

    const res = await detail(submissionId);

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.googlePlaceId).toBe(googlePlaceId);
    // The canonical link, built from the id GoGo stores — not a provider field.
    expect(body.googleMapsUrl).toBe(
      `https://www.google.com/maps/place/?q=place_id:${googlePlaceId}`,
    );
    // What the contributor actually sent, kept whole and kept separate.
    expect(body.contribution).toMatchObject({
      categoryKey: 'cafe',
      estimatedPrice: { min: 50_000, max: 120_000, unit: 'per_person' },
      note: 'Quán mới mở, view hồ',
      vibeKeys: ['chill'],
    });
    expect(body.review).toBeUndefined();
    // Opening a submission bills nobody.
    expect(places.tiersRequested).toEqual([]);
  });

  it('costs exactly one quality Details to ask Google, and only when asked', async () => {
    const { submissionId } = await contribute();
    places.tiersRequested.length = 0;

    await detail(submissionId);
    expect(places.tiersRequested).toEqual([]);

    const preview = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${submissionId}/provider-preview`,
      remoteAddress: ip(),
      headers: auth(tokens.moderator),
    });

    expect(preview.statusCode, preview.body).toBe(201);
    expect(preview.json().candidate).toMatchObject({
      googleRating: 4.3,
      googleRatingCount: 812,
      source: 'google_places',
    });
    expect(preview.json().candidate.openingHours.length).toBeGreaterThan(0);
    expect(places.tiersRequested).toEqual(['quality']);
  });

  it('names the catalogue place when this Google record is already in it', async () => {
    const { submissionId } = await contribute();
    // Approve it, then look again: the duplicate indicator and the result are
    // the same question and answer from the same field.
    const approved = await decide(submissionId, { decision: 'approved', reason: 'hợp lệ' });
    expect(approved.statusCode, approved.body).toBe(201);

    const again = await detail(submissionId);
    expect(again.json().existingPlace.id).toBe(approved.json().placeId);

    const queue = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?status=approved',
      remoteAddress: ip(),
      headers: auth(tokens.moderator),
    });
    const row = queue.json().items.find((i: { id: string }) => i.id === submissionId);
    expect(row.linkedPlaceId).toBe(approved.json().placeId);
    expect(row.displayNameSource).toBe('catalogue');
  });

  it('says plainly that a fresh proposal has no name, rather than inventing one', async () => {
    await contribute();
    places.tiersRequested.length = 0;
    const queue = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?status=pending',
      remoteAddress: ip(),
      headers: auth(tokens.moderator),
    });
    const [row] = queue.json().items;
    expect(row.displayName).toBeUndefined();
    expect(row.hasReview).toBe(false);
    // And no Details was spent filling the column.
    expect(places.tiersRequested).toEqual([]);
  });
});

describe('supplementing before the decision (#528)', () => {
  const draft = {
    name: 'Cà phê Ngọc Hà',
    description: 'Quán nhỏ, sân vườn, hợp nhóm bạn.',
    phone: '024 3456 7890',
    website: 'https://ngocha.vn',
    provenance: { phone: EVIDENCE, website: EVIDENCE },
    avgVisitMinutes: 75,
    suitability: { couple: 0.9, friends: 0.8 },
    priceMin: 60_000,
    priceMax: 150_000,
    priceUnit: 'per_person' as const,
  };

  it('saves without deciding and without creating anything', async () => {
    const { submissionId } = await contribute();

    const saved = await saveReview(submissionId, { draft });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().draft).toMatchObject({ name: 'Cà phê Ngọc Hà' });

    const [row] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submissionId));
    expect(row!.status).toBe('pending');
    expect(row!.resultPlaceId).toBeNull();
    const [count] = await rows<{ n: number }>(sql`select count(*)::int as n from places`);
    expect(count!.n).toBe(0);
  });

  it('keeps the contributor’s own input beside it, never over it', async () => {
    const { submissionId } = await contribute({
      category: 'cafe',
      estimatedPrice: { min: 30_000, max: 60_000, unit: 'per_person' },
      note: 'Giá sinh viên',
    });

    await saveReview(submissionId, { draft });

    const body = (await detail(submissionId)).json();
    // The reviewer proposed a different price; the suggestion survives.
    expect(body.contribution.estimatedPrice).toMatchObject({ min: 30_000, max: 60_000 });
    expect(body.contribution.note).toBe('Giá sinh viên');
    expect(body.review.draft.priceMin).toBe(60_000);
  });

  it('records who supplemented, in the audit log', async () => {
    const { submissionId } = await contribute();
    await saveReview(submissionId, { draft });

    const entries = await rows<{ action: string; actor_id: string }>(sql`
      select action, actor_id from audit_logs
      where resource_type = 'place_submission' and resource_id = ${submissionId}
    `);
    expect(entries.map((e) => e.action)).toContain('place_submission.reviewed');

    const body = (await detail(submissionId)).json();
    expect(
      body.history.some((h: { action: string }) => h.action === 'place_submission.reviewed'),
    ).toBe(true);
  });

  it('refuses a stale edit instead of letting it win', async () => {
    const { submissionId } = await contribute();
    const first = await saveReview(submissionId, { draft });
    const staleStamp = (await detail(submissionId)).json().createdAt;

    const clash = await saveReview(submissionId, {
      draft: { name: 'Tên khác' },
      expectedUpdatedAt: staleStamp,
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe('SUBMISSION_MODIFIED');

    // The fresh stamp the first save returned still works.
    const ok = await saveReview(submissionId, {
      draft: { name: 'Tên khác' },
      expectedUpdatedAt: first.json().updatedAt,
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('holds the reviewer to the same field rules the place editor uses', async () => {
    const { submissionId } = await contribute();
    // `avgVisitMinutes` is 10..720 on a place; a draft that accepted 0 would
    // save here and be rejected at approval, after the reviewer had left.
    const tooShort = await saveReview(submissionId, { draft: { avgVisitMinutes: 0 } });
    expect(tooShort.statusCode).toBe(400);

    const tooLong = await saveReview(submissionId, {
      draft: { addressText: 'x'.repeat(401) },
    });
    expect(tooLong.statusCode).toBe(400);

    // And a rating is not a field a person can type at all.
    const notYours = await saveReview(submissionId, {
      draft: { rating: 5 } as unknown as Record<string, unknown>,
    });
    expect(notYours.statusCode).toBe(400);

    const ok = await saveReview(submissionId, { draft: { avgVisitMinutes: 60 } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('refuses a taxonomy id the catalogue does not carry, at save', async () => {
    const { submissionId } = await contribute();
    const res = await saveReview(submissionId, {
      draft: { taxonomyIds: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0].field).toBe('taxonomyIds');
  });

  it('refuses a review on a submission that is already decided', async () => {
    const { submissionId } = await contribute();
    await decide(submissionId, {
      decision: 'rejected',
      rejectionReason: 'duplicate_place',
      reason: 'trùng địa điểm khác',
    });

    const res = await saveReview(submissionId, { draft });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_DECIDED');
  });

  it('is closed to somebody who is not on the queue', async () => {
    const { submissionId } = await contribute();
    const res = await api().inject({
      method: 'PUT',
      url: `/v1/cms/place-submissions/${submissionId}/review`,
      remoteAddress: ip(),
      payload: { draft },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('the decision applies what the reviewer wrote (#528)', () => {
  it('creates the place from the draft, and Place Detail shows it', async () => {
    const { submissionId, googlePlaceId } = await contribute({ name: 'Google Name Only' });
    await saveReview(submissionId, {
      draft: {
        name: 'Cà phê Ngọc Hà',
        description: 'Sân vườn, hợp nhóm bạn.',
        addressText: '12 Ngọc Hà, Ba Đình, Hà Nội',
        phone: '024 3456 7890',
        website: 'https://ngocha.vn',
        provenance: { addressText: EVIDENCE, phone: EVIDENCE, website: EVIDENCE },
        avgVisitMinutes: 75,
        suitability: { couple: 0.9 },
        priceMin: 60_000,
        priceMax: 150_000,
        priceUnit: 'per_person',
      },
    });

    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ thông tin' });
    expect(approved.statusCode, approved.body).toBe(201);
    const placeId = approved.json().placeId as string;

    const place = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${placeId}`,
      remoteAddress: ip(),
      headers: auth(tokens.editor),
    });
    expect(place.statusCode, place.body).toBe(200);
    expect(place.json()).toMatchObject({
      name: 'Cà phê Ngọc Hà',
      description: 'Sân vườn, hợp nhóm bạn.',
      addressText: '12 Ngọc Hà, Ba Đình, Hà Nội',
      // GoGo-BE#280 — stored normalized, the way the editor would have.
      phone: '+842434567890',
      website: 'https://ngocha.vn/',
      avgVisitMinutes: 75,
    });
    expect(place.json().suitability).toMatchObject({ couple: 0.9 });
    expect(place.json().prices[0]).toMatchObject({
      priceMin: 60_000,
      priceMax: 150_000,
      unit: 'per_person',
    });
    // The Google identity still travels with it.
    const [source] = await rows<{ external_id: string }>(sql`
      select external_id from place_provider_sources where place_id = ${placeId}::uuid
    `);
    expect(source!.external_id).toBe(googlePlaceId);
  });

  it('marks what the reviewer typed editorial and what Google answered derived', async () => {
    const { submissionId, googlePlaceId } = await contribute();
    await saveReview(submissionId, { draft: { name: 'Tên biên tập viên đặt' } });
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });
    const placeId = approved.json().placeId as string;

    const provenance = await rows<{
      field: string;
      source_type: string;
      source_reference: string | null;
    }>(sql`
      select field, source_type, source_reference from place_field_provenance
      where place_id = ${placeId}::uuid order by field
    `);
    const byField = new Map(provenance.map((p) => [p.field, p]));

    // Typed by a person: theirs, and a later provider refresh has no claim.
    expect(byField.get('name')).toMatchObject({ source_type: 'editorial' });
    // Left as Google answered it: derived, and it says which record from.
    expect(byField.get('geom')).toMatchObject({
      source_type: 'google_derived',
      source_reference: googlePlaceId,
    });
    // GoGo-BE#280 — the address is GoGo-owned: never Google's, so a place
    // whose reviewer gave none has neither an address nor a claim on one.
    expect(byField.has('address_text')).toBe(false);
  });

  it('keeps the provider’s figures the provider’s', async () => {
    const { submissionId } = await contribute();
    await saveReview(submissionId, { draft: { name: 'Tên khác hẳn' } });
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });
    const placeId = approved.json().placeId as string;

    const place = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${placeId}`,
      remoteAddress: ip(),
      headers: auth(tokens.editor),
    });
    // The rating is Google's and arrives from the approval fetch, not the form.
    expect(place.json().ratings.provider).toMatchObject({ rating: 4.3, count: 812 });
    // Hours came from the provider and say so.
    const hours = await rows<{ source: string }>(sql`
      select distinct source from place_hours where place_id = ${placeId}::uuid
    `);
    expect(hours.map((h) => h.source)).toEqual(['provider']);
  });

  it('falls back to the provider for every field the reviewer left alone', async () => {
    const { submissionId } = await contribute({ name: 'Quán Tên Google' });
    await saveReview(submissionId, { draft: { description: 'Chỉ thêm mô tả.' } });
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });

    const place = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${approved.json().placeId}`,
      remoteAddress: ip(),
      headers: auth(tokens.editor),
    });
    expect(place.json().name).toBe('Quán Tên Google');
    expect(place.json().description).toBe('Chỉ thêm mô tả.');
  });

  it('uses the contributor’s price when no reviewer proposed one', async () => {
    const { submissionId } = await contribute({
      estimatedPrice: { min: 30_000, max: 60_000, unit: 'per_person' },
    });
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });
    const prices = await rows<{ price_min: string; confidence: string }>(sql`
      select price_min, confidence from place_prices
      where place_id = ${approved.json().placeId}::uuid
    `);
    expect(Number(prices[0]!.price_min)).toBe(30_000);
    // A user's estimate, at a user's confidence.
    expect(Number(prices[0]!.confidence)).toBeCloseTo(0.3, 2);
  });

  it('reject creates nothing at all', async () => {
    const { submissionId } = await contribute();
    await saveReview(submissionId, { draft: { name: 'Sẽ không được dùng' } });

    const res = await decide(submissionId, {
      decision: 'rejected',
      rejectionReason: 'not_public_place',
      reason: 'ngoài phạm vi',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().placeId).toBeUndefined();

    const [count] = await rows<{ n: number }>(sql`select count(*)::int as n from places`);
    expect(count!.n).toBe(0);
    // The draft is kept: rejecting is a decision about the proposal, not a
    // reason to destroy the work somebody did on it.
    const [row] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submissionId));
    expect(row!.reviewDraft).toMatchObject({ name: 'Sẽ không được dùng' });
  });

  it('merge points at the chosen place and creates no second one', async () => {
    const first = await contribute({ name: 'Quán Gốc' });
    const approved = await decide(first.submissionId, {
      decision: 'approved',
      reason: 'đủ điều kiện',
    });
    const targetId = approved.json().placeId as string;

    const second = await contribute();
    const merged = await decide(second.submissionId, {
      decision: 'merged',
      reason: 'cùng một quán',
      mergeIntoPlaceId: targetId,
    });

    expect(merged.statusCode, merged.body).toBe(201);
    expect(merged.json().placeId).toBe(targetId);
    const [count] = await rows<{ n: number }>(sql`select count(*)::int as n from places`);
    expect(count!.n).toBe(1);
    // Merging records where the proposal went; it writes nothing to the target.
    const target = await db.select().from(schema.places).where(eq(schema.places.id, targetId));
    expect(target[0]!.name).toBe('Quán Gốc');
  });

  it('refuses a merge target that does not exist, and says which problem it is', async () => {
    const { submissionId } = await contribute();
    const res = await decide(submissionId, {
      decision: 'merged',
      reason: 'gộp vào chỗ khác',
      mergeIntoPlaceId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('MERGE_TARGET_NOT_FOUND');

    const [row] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submissionId));
    expect(row!.status).toBe('pending');
  });

  it('cannot be decided twice', async () => {
    const { submissionId } = await contribute();
    const first = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });
    expect(first.statusCode).toBe(201);

    const second = await decide(submissionId, {
      decision: 'approved',
      reason: 'duyệt lại lần nữa',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('ALREADY_DECIDED');

    const [count] = await rows<{ n: number }>(sql`select count(*)::int as n from places`);
    expect(count!.n).toBe(1);
  });

  it('approval is still not publication', async () => {
    const { submissionId } = await contribute();
    await saveReview(submissionId, { draft: { name: 'Đã bổ sung' } });
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });

    const place = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, approved.json().placeId as string));
    expect(place[0]!.status).toBe('community_submitted');
    // #525 — the mapping is the resolver's answer, never a certification.
    expect(place[0]!.administrativeMappingStatus).not.toBe('VERIFIED');
    expect(place[0]!.administrativeMappedBy).toBeNull();
  });
});

/**
 * PI-BE-031 (#528) — a reviewer's edit survives the refresh that follows it.
 *
 * "Reviewer edits must survive approval and appear on the resulting Place. A
 * subsequent provider fetch must not silently overwrite them." The first half
 * is asserted above; this is the second, and it needs a refresh path that can
 * actually write the fields in question. The scheduled liveness refresh cannot
 * — it asks for `id` and `movedPlaceId` and writes neither a name nor an
 * address — so proving anything with it would prove nothing.
 *
 * `update_existing` is that path. It re-fetches the place at `quality` and
 * writes the provider's answer over the row, which is right for a shop that
 * was renamed and wrong for a name a person chose. It found the reviewer's
 * name and replaced it; `place_field_provenance` is what now stops it.
 */
describe('a reviewer’s edit outlives the next provider fetch (#528)', () => {
  const CSV_HEADER =
    'source_row_id,name,city,district,google_maps_url,category,price_min,price_max,price_unit';

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

  /** Re-import the same Google id in `update_existing`, end to end. */
  async function refreshFromProvider(googlePlaceId: string): Promise<void> {
    const content = Buffer.from(
      [CSV_HEADER, `R-1,,Hà Nội,,https://www.google.com/maps?place_id=${googlePlaceId},,,,`].join(
        '\n',
      ),
      'utf8',
    );
    const body = multipart(
      { mode: 'update_existing' },
      { name: `refresh-${googlePlaceId}.csv`, content },
    );
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-imports',
      remoteAddress: ip(),
      headers: { ...auth(tokens.editor), ...body.headers },
      payload: body.payload,
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().id as string;
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/start`,
      remoteAddress: ip(),
      headers: auth(tokens.editor),
    });
    await app.get(PlaceImportJobService).processJob(jobId);
    // The refresh must actually have happened — an assertion about a value
    // that was never written proves nothing.
    const rowsRes = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-imports/${jobId}/rows`,
      remoteAddress: ip(),
      headers: auth(tokens.editor),
    });
    const [row] = rowsRes.json().items as { status: string; errors: unknown[] }[];
    expect(row!.status, JSON.stringify(row!.errors)).toBe('imported');
  }

  it('keeps the name and address a reviewer wrote, and takes Google’s new rating', async () => {
    const { submissionId, googlePlaceId } = await contribute({ name: 'Tên Google Ban Đầu' });
    await saveReview(submissionId, {
      draft: {
        name: 'Cà phê Ngọc Hà',
        addressText: '12 Ngọc Hà, Ba Đình, Hà Nội',
        provenance: { addressText: EVIDENCE },
      },
    });
    const approved = await decide(submissionId, {
      decision: 'approved',
      reason: 'đủ thông tin',
    });
    const placeId = approved.json().placeId as string;

    // Google's answer moves on: a new name, a new address, a new rating.
    places.seed({
      providerPlaceId: googlePlaceId,
      name: 'Tên Google Đã Đổi',
      addressText: 'Địa chỉ Google đã đổi',
      lat: 21.02,
      lng: 105.84,
      rating: 4.9,
      ratingCount: 2_000,
      googleMapsUri: `https://maps.google.com/?cid=${1000000000000000000 + seq}`,
    });

    await refreshFromProvider(googlePlaceId);

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, placeId));
    // The reviewer's values are still there.
    expect(after!.name).toBe('Cà phê Ngọc Hà');
    expect(after!.addressText).toBe('12 Ngọc Hà, Ba Đình, Hà Nội');
    // …and the provider's own figures did move, still attributed to it.
    expect(Number(after!.rating)).toBeCloseTo(4.9, 2);
    expect(after!.ratingCount).toBe(2_000);
  });

  it('lets the provider write a field nobody claimed', async () => {
    const { submissionId, googlePlaceId } = await contribute({ name: 'Quán Chưa Ai Sửa' });
    // Only the description is supplemented; the name is left as Google's.
    await saveReview(submissionId, { draft: { description: 'Chỉ thêm mô tả.' } });
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });
    const placeId = approved.json().placeId as string;

    // A rename, not a change of business: enough shared tokens and a rising
    // review count, so the identity-change detector correctly stays quiet and
    // the refresh reaches the write this case is about.
    places.seed({
      providerPlaceId: googlePlaceId,
      name: 'Quán Chưa Ai Sửa - Cơ Sở 2',
      addressText: 'Địa chỉ mới',
      lat: 21.02,
      lng: 105.84,
      rating: 4.5,
      ratingCount: 1_200,
      googleMapsUri: `https://maps.google.com/?cid=${2000000000000000000 + seq}`,
    });

    await refreshFromProvider(googlePlaceId);

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, placeId));
    // Nobody claimed the name, so a rename is the provider's to report.
    expect(after!.name).toBe('Quán Chưa Ai Sửa - Cơ Sở 2');
    // The reviewer's description is theirs and stays.
    expect(after!.description).toBe('Chỉ thêm mô tả.');
  });

  it('records the provenance the refresh reads, on the place itself', async () => {
    const { submissionId } = await contribute();
    await saveReview(submissionId, { draft: { name: 'Tên biên tập viên' } });
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });

    const provenance = await rows<{ field: string; source_type: string }>(sql`
      select field, source_type from place_field_provenance
      where place_id = ${approved.json().placeId as string}::uuid
    `);
    const byField = new Map(provenance.map((p) => [p.field, p.source_type]));
    // This row is the whole mechanism: without it the refresh has no way to
    // tell a name a person chose from one it fetched last month.
    expect(byField.get('name')).toBe('editorial');
    // GoGo-BE#280 — no Google address, so no `google_derived` claim on one.
    expect(byField.has('address_text')).toBe(false);
  });
});

/**
 * What the whole journey costs, stage by stage (#505/#528).
 *
 * Not a performance test — a spend one. The two `quality` Details a moderator
 * sees (preview, approval) are the CMS half and were being quoted as if they
 * were the whole thing; the app pays for the resolution before either of them,
 * and a link that carries an identity pays differently from one that does not.
 *
 * These are fixture call counts against `FakePlaceProvider`, not live Google
 * measurements: they pin *how many* requests of *which* kind each stage makes,
 * which is what a price is multiplied by. The prices themselves are in
 * `pricing-rules.ts` and were read off Google's own page.
 */
describe('provider spend, per stage of the journey (#505/#528)', () => {
  const spend = () => ({
    freeSearches: places.searches.length,
    identitySearches: places.identitySearches.length,
    details: [...places.tiersRequested],
  });

  const reset = () => {
    places.searches.length = 0;
    places.identitySearches.length = 0;
    places.tiersRequested.length = 0;
  };

  it('costs one Pro search and one Enterprise Details to resolve a link with an identity', async () => {
    seq += 1;
    const googlePlaceId = `fake-journey-${seq}`;
    places.seed({
      providerPlaceId: googlePlaceId,
      name: 'Quán Hành Trình',
      lat: 21.0495428,
      lng: 105.8138058,
      googleMapsUri: 'https://maps.google.com/?cid=4982135578400680163',
    });
    reset();

    const resolved = await api().inject({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      remoteAddress: ip(),
      payload: {
        url:
          'https://www.google.com/maps/place/Qu%C3%A1n+H%C3%A0nh+Tr%C3%ACnh/' +
          '@21.0533,105.8159,16z/data=!4m6!3m5!1s0x3135ab85ff36dd35:0x452419e97d6868e3' +
          '!8m2!3d21.0495428!4d105.8138058',
      },
    });

    expect(resolved.statusCode, resolved.body).toBe(201);
    expect(resolved.json().candidate.googlePlaceId).toBe(googlePlaceId);
    // One Text Search Pro (the identity), no free search, one Details.
    expect(spend()).toEqual({ freeSearches: 0, identitySearches: 1, details: ['quality'] });
  });

  it('costs one free search and up to three Details when the link states none', async () => {
    seq += 1;
    places.seed({
      providerPlaceId: `fake-journey-noid-${seq}`,
      name: 'Quán Không Định Danh',
      lat: 21.02,
      lng: 105.84,
    });
    reset();

    await api().inject({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      remoteAddress: ip(),
      payload: { url: 'https://maps.google.com/?q=Qu%C3%A1n+Kh%C3%B4ng+%C4%90%E1%BB%8Bnh+Danh' },
    });

    // Nothing to compare a CID against, so nothing buys the Pro SKU.
    expect(spend().identitySearches).toBe(0);
    expect(spend().freeSearches).toBe(1);
    expect(spend().details.every((tier) => tier === 'quality')).toBe(true);
    expect(spend().details.length).toBeLessThanOrEqual(3);
  });

  it('costs one Pro Details to submit, one Enterprise each to preview and to approve', async () => {
    const { submissionId } = await contribute();
    // `contribute` already submitted: that is the `core` fetch, Place Details
    // Pro, and it is the app's cost rather than the console's.
    expect(places.tiersRequested).toEqual(['core']);

    reset();
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${submissionId}/provider-preview`,
      remoteAddress: ip(),
      headers: auth(tokens.moderator),
    });
    expect(spend()).toEqual({ freeSearches: 0, identitySearches: 0, details: ['quality'] });

    reset();
    const approved = await decide(submissionId, { decision: 'approved', reason: 'đủ điều kiện' });
    expect(approved.statusCode, approved.body).toBe(201);
    expect(spend()).toEqual({ freeSearches: 0, identitySearches: 0, details: ['quality'] });
  });

  it('opening the queue and a submission costs nothing at all', async () => {
    const { submissionId } = await contribute();
    reset();

    await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?status=pending',
      remoteAddress: ip(),
      headers: auth(tokens.moderator),
    });
    await detail(submissionId);

    expect(spend()).toEqual({ freeSearches: 0, identitySearches: 0, details: [] });
  });
});

async function enablePhotos() {
  await db.execute(sql`delete from feature_flags where key = 'place_provider_photos.enabled'`);
  await db.execute(
    sql`insert into feature_flags (key, environment, platform, enabled) values ('place_provider_photos.enabled', 'all', 'all', true)`,
  );
}
function seedPhoto(id: string) {
  const fake = app.get(PLACE_PHOTO_DISPLAY) as FakePlacePhotoDisplay;
  fake.seed(
    id,
    [0, 1].map((n) => ({
      reference: `places/${id}/photos/private-photo-${n}`,
      widthPx: 1600,
      heightPx: 900,
      authorAttributions: [
        { displayName: 'Lan', uri: 'https://maps.google.com/contrib/lan', photoUri: null },
      ],
      googleMapsUri: 'https://www.google.com/maps/photo/one',
    })),
  );
  for (const n of [0, 1])
    fake.seedMedia(`places/${id}/photos/private-photo-${n}`, {
      contentType: 'image/jpeg',
      bytes: new Uint8Array([255, 216, 255, 1]),
    });
  return fake;
}

describe('#786 approved submission provider photo', () => {
  it('resolve/preview/pending store no photo, approve retains exactly one attributed provider image', async () => {
    await enablePhotos();
    const { submissionId, googlePlaceId } = await contribute();
    const fake = seedPhoto(googlePlaceId);
    const storage = app.get(PUBLIC_STORAGE_PROVIDER) as FakeStorage;
    const initialObjects = storage.objects.size;
    const initialMediaCalls = fake.mediaCalls.length;
    const resolved = await api().inject({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      remoteAddress: ip(),
      payload: {
        url: `https://www.google.com/maps?place_id=${googlePlaceId}`,
      },
    });
    expect(resolved.statusCode, resolved.body).toBe(201);
    const reference = resolved.json().candidate.photo;
    expect(reference).toMatchObject({ provider: 'google', attribution: 'Google Maps' });
    expect(resolved.headers['cache-control']).toBe('private, no-store');
    expect(fake.mediaCalls.length).toBe(initialMediaCalls);
    const preview = await api().inject({ method: 'GET', url: reference.url, remoteAddress: ip() });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().photos).toHaveLength(1);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(storage.objects.size).toBe(initialObjects);
    expect(await db.select().from(schema.placeMedia)).toEqual([]);
    const [pending] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submissionId));
    expect(JSON.stringify(pending)).not.toContain('private-photo');
    expect(JSON.stringify(pending)).not.toContain('authorAttributions');
    const approved = await decide(submissionId, { decision: 'approved', reason: 'Reviewed venue' });
    expect(approved.statusCode, approved.body).toBe(201);
    const placeId = approved.json().placeId;
    const media = await db
      .select()
      .from(schema.placeMedia)
      .where(eq(schema.placeMedia.placeId, placeId));
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      moderation: 'approved',
      sourceType: 'google_derived',
      attribution: 'Google Maps',
      providerPhoto: {
        sourceReference: googlePlaceId,
        authorAttributions: [{ displayName: 'Lan' }],
      },
    });
    expect(storage.objects.size).toBe(initialObjects + 1);
    expect(await db.select().from(schema.mediaCleanupQueue)).toEqual([]);
    const detail = await api().inject({
      method: 'GET',
      url: `/v1/places/${placeId}`,
      remoteAddress: ip(),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().photos).toMatchObject([
      {
        source: 'google',
        attribution: 'Google Maps',
        authorAttributions: [{ displayName: 'Lan' }],
        googleMapsUri: 'https://www.google.com/maps/photo/one',
      },
    ]);
    const immutable = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${placeId}/media/${media[0]!.id}`,
      remoteAddress: ip(),
      headers: auth(tokens.editor),
      payload: { attribution: null },
    });
    expect(immutable.statusCode, immutable.body).toBe(400);
    expect(immutable.json().code).toBe('PROVIDER_ATTRIBUTION_IMMUTABLE');
    const again = await decide(submissionId, { decision: 'approved', reason: 'Retry approval' });
    expect(again.statusCode).toBe(409);
    expect(storage.objects.size).toBe(initialObjects + 1);
  });

  it('rejection never fetches or persists a provider image', async () => {
    await enablePhotos();
    const { submissionId, googlePlaceId } = await contribute();
    const fake = seedPhoto(googlePlaceId);
    const calls = fake.mediaCalls.length;
    expect(
      (
        await decide(submissionId, {
          decision: 'rejected',
          rejectionReason: 'other',
          reason: 'Not acceptable',
        })
      ).statusCode,
    ).toBe(201);
    expect(fake.mediaCalls.length).toBe(calls);
    expect(await db.select().from(schema.placeMedia)).toEqual([]);
  });

  it('provider failure keeps submission pending so approval can retry with its photo', async () => {
    await enablePhotos();
    const { submissionId, googlePlaceId } = await contribute();
    const fake = seedPhoto(googlePlaceId);
    fake.failing = true;
    try {
      const approved = await decide(submissionId, {
        decision: 'approved',
        reason: 'Reviewed venue',
      });
      expect(approved.statusCode, approved.body).toBe(503);
      expect(approved.json().code).toBe('SUBMISSION_PHOTO_UNAVAILABLE');
      const [pending] = await db
        .select()
        .from(schema.placeSubmissions)
        .where(eq(schema.placeSubmissions.id, submissionId));
      expect(pending?.status).toBe('pending');
      expect(await db.select().from(schema.placeMedia)).toEqual([]);
    } finally {
      fake.failing = false;
    }
  });
});

describe('public rejection keys (#787)', () => {
  const keys = [
    'duplicate_place',
    'incorrect_location',
    'permanently_closed',
    'not_public_place',
    'inappropriate_content',
    'other',
  ];
  const poll = (id: string, token: string) =>
    api().inject({
      method: 'GET',
      url: `/v1/place-submissions/${id}`,
      remoteAddress: ip(),
      headers: auth(token),
    });

  it.each(keys)('persists %s and returns only the key to its owner', async (key) => {
    const { submissionId, token } = await contribute();
    const pending = await poll(submissionId, token);
    expect(pending.json().rejectionReason).toBeUndefined();
    const rejected = await decide(submissionId, {
      decision: 'rejected',
      rejectionReason: key,
      reason: 'PRIVATE reviewer note',
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    const result = await poll(submissionId, token);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ status: 'rejected', rejectionReason: key });
    expect(Object.keys(result.json()).sort()).toEqual(
      [
        'id',
        'status',
        'rejectionReason',
        'googlePlaceId',
        'submissionCount',
        'createdAt',
        'decidedAt',
      ].sort(),
    );
    expect(result.body).not.toContain('PRIVATE');
    const [stored] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submissionId));
    expect(stored).toMatchObject({ rejectionReason: key, decisionReason: 'PRIVATE reviewer note' });
    expect((await detail(submissionId)).json().rejectionReason).toBe(key);
    const queue = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?status=rejected',
      remoteAddress: ip(),
      headers: auth(tokens.moderator),
    });
    expect(
      queue.json().items.find((item: { id: string }) => item.id === submissionId).rejectionReason,
    ).toBe(key);
    const [audit] = await rows<{ diff: { rejectionReason: string } }>(sql`
      select diff from audit_logs where resource_id = ${submissionId} and action = 'place_submission.decided'
    `);
    expect(audit!.diff.rejectionReason).toBe(key);
    const outsider = await register(`outsider-${seq}@gogo.id.vn`);
    expect((await poll(submissionId, outsider)).statusCode).toBe(403);
  });

  it.each([undefined, null, '', 'duplicate', 'PRIVATE note', 'DUPLICATE_PLACE', 12])(
    'rejects missing/invalid key %s without recording a decision',
    async (key) => {
      const { submissionId, token } = await contribute();
      const res = await decide(submissionId, {
        decision: 'rejected',
        reason: 'PRIVATE note',
        ...(key === undefined ? {} : { rejectionReason: key }),
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'VALIDATION_FAILED',
        field_errors: [expect.objectContaining({ field: 'rejectionReason' })],
      });
      expect((await poll(submissionId, token)).json().status).toBe('pending');
      const audit = await rows(
        sql`select id from audit_logs where resource_id = ${submissionId} and action = 'place_submission.decided'`,
      );
      expect(audit).toHaveLength(0);
    },
  );

  it('requires no internal note for rejection', async () => {
    const { submissionId, token } = await contribute();
    const res = await decide(submissionId, { decision: 'rejected', rejectionReason: 'other' });
    expect(res.statusCode, res.body).toBe(201);
    expect((await poll(submissionId, token)).json().rejectionReason).toBe('other');
  });

  it('omits the key and internal note for historical rejections', async () => {
    const { submissionId, token } = await contribute();
    await db
      .update(schema.placeSubmissions)
      .set({ status: 'rejected', decisionReason: 'PRIVATE legacy' })
      .where(eq(schema.placeSubmissions.id, submissionId));
    const res = await poll(submissionId, token);
    expect(res.json().status).toBe('rejected');
    expect(res.json().rejectionReason).toBeUndefined();
    expect(res.body).not.toContain('PRIVATE');
  });

  it('approval keeps its note requirement and never exposes a rejection key', async () => {
    await enablePhotos();
    const { submissionId, googlePlaceId, token } = await contribute();
    seedPhoto(googlePlaceId);
    expect((await decide(submissionId, { decision: 'approved' })).statusCode).toBe(400);
    const res = await decide(submissionId, { decision: 'approved', reason: 'PRIVATE approved' });
    expect(res.statusCode, res.body).toBe(201);
    const result = await poll(submissionId, token);
    expect(result.json().status).toBe('approved');
    expect(result.json().rejectionReason).toBeUndefined();
    expect(result.body).not.toContain('PRIVATE');
  });
});

describe('wizard claims through real HTTP approval (#796)', () => {
  it('shows unverified claims to CMS, grants only on approval and never promotes enrichment automatically', async () => {
    const enrichment: SubmissionEnrichment = {
      price: { min: 12345, max: 98765, currency: 'VND', unit: 'per_group' },
      purposeKeys: ['work_reading'],
      vibeKeys: ['chill'],
      amenities: { open_after_23: true, car_parking: false },
      service: { rating: 5, chipKeys: ['service_friendly'] },
      space: { rating: 4, chipKeys: ['space_quiet'] },
      visitTips: 'PRIVATE WIZARD TIP',
    };
    await enablePhotos();
    const { submissionId, token, googlePlaceId } = await contribute({ enrichment });
    seedPhoto(googlePlaceId);
    const before = await rows(
      sql`select delta from assistant_credit_ledger where submission_id=${submissionId}::uuid`,
    );
    expect(before).toEqual([]);
    const review = await detail(submissionId);
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json().contribution).toMatchObject({
      enrichment,
      verificationStatus: 'unverified',
    });
    const approved = await decide(submissionId, {
      decision: 'approved',
      reason: 'Verified identity only',
    });
    expect(approved.statusCode, approved.body).toBe(201);
    const placeId = approved.json().placeId;
    expect(await rows(sql`select * from place_prices where place_id=${placeId}::uuid`)).toEqual([]);
    expect(
      await rows(
        sql`select t.key from place_taxonomies pt join taxonomies t on t.id=pt.taxonomy_id where pt.place_id=${placeId}::uuid and t.key in ('open_after_23','car_parking','chill','work_reading','service_friendly','space_quiet')`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        sql`select delta from assistant_credit_ledger where submission_id=${submissionId}::uuid`,
      ),
    ).toEqual([{ delta: 50 }]);
    const again = await decide(submissionId, { decision: 'approved', reason: 'Retry' });
    expect(again.statusCode).toBe(409);
    expect(
      await rows(
        sql`select delta from assistant_credit_ledger where submission_id=${submissionId}::uuid`,
      ),
    ).toEqual([{ delta: 50 }]);
    const own = await api().inject({
      method: 'GET',
      url: `/v1/place-submissions/${submissionId}`,
      headers: auth(token),
    });
    expect(own.json()).toMatchObject({ enrichment, verificationStatus: 'unverified' });
    expect(own.body).not.toContain('Verified identity only');
  });
  it('enforces authentication and ownership through draft HTTP endpoints', async () => {
    const token = await register(`wizard-draft-${++seq}@gogo.id.vn`);
    const outsider = await register(`wizard-other-${++seq}@gogo.id.vn`);
    const id = 'd9796d97-9679-4967-8967-967996799679';
    const url = `/v1/place-contribution-drafts/${id}`;
    const payload = {
      googlePlaceId: 'wizard-http-provider',
      expectedVersion: 0,
      enrichment: { visitTips: 'PRIVATE DRAFT TIP' },
    };
    const anonymous = await api().inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);
    const admin = await api().inject({ method: 'PUT', url, headers: auth(tokens.editor), payload });
    expect(admin.statusCode).toBe(403);
    const saved = await api().inject({ method: 'PUT', url, headers: auth(token), payload });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, enrichment: payload.enrichment });
    const own = await api().inject({ method: 'GET', url, headers: auth(token) });
    expect(own.headers['cache-control']).toBe('private, no-store');
    const forbidden = await api().inject({ method: 'GET', url, headers: auth(outsider) });
    expect(forbidden.statusCode).toBe(404);
    const removed = await api().inject({
      method: 'DELETE',
      url: `${url}?version=1`,
      headers: auth(token),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await api().inject({ method: 'GET', url, headers: auth(token) })).statusCode).toBe(404);
  });
});
