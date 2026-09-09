import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { PLACE_PROVIDER } from '@gogo/providers';
import type { FakePlaceProvider } from '@gogo/providers';

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

let seq = 0;

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
  }> = {},
): Promise<{ submissionId: string; googlePlaceId: string }> {
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
    },
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return { submissionId: submitted.json().submissionId as string, googlePlaceId };
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

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

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
    website: 'https://ngocha.example',
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
    await decide(submissionId, { decision: 'rejected', reason: 'trùng địa điểm khác' });

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
        website: 'https://ngocha.example',
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
      phone: '024 3456 7890',
      website: 'https://ngocha.example',
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
    expect(byField.get('address_text')).toMatchObject({
      source_type: 'google_derived',
      source_reference: googlePlaceId,
    });
    expect(byField.get('geom')).toMatchObject({ source_type: 'google_derived' });
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

    const res = await decide(submissionId, { decision: 'rejected', reason: 'ngoài phạm vi' });
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
