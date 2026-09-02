import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { MetricsRegistry } from '@gogo/observability';
import { resetBreakers } from '@gogo/providers';
import { PlaceResolverService, ProviderContentService } from '@gogo/modules';

/**
 * #341 (PR8) — the ephemeral provider-content boundary, end to end
 * (ADR-0006 §9.7): a moderator asks what Google says now, the API asks Google
 * at exactly the tier named, renders the answer, and **stores none of it**.
 *
 * Real Postgres, real Nest app, real Google adapter with only `fetch` stubbed —
 * the same shape as `place-refresh.int.spec.ts`, and for the same reason: the
 * properties under test are what a request carries (the field mask), what a
 * row looks like after the call (unchanged), and what an audit row holds (ids).
 * A fake provider proves none of them.
 *
 * Every catalogue-touching test takes a snapshot of the place's rows before the
 * call and asserts it byte-for-byte after. That assertion is the PR.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const ENV = 'dev';

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.41.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createAdmin(
  email: string,
  role: 'editor' | 'moderator' | 'ops_admin' | 'super_admin',
): Promise<{ id: string; token: string }> {
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

// ------------------------------------------------------------- Google stub

type Stub = { status: number; body?: unknown };
let queued: Stub[] = [];
let requests: { url: string; fieldMask: string | null }[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const next = queued.shift() ?? { status: 500, body: { error: { status: 'INTERNAL' } } };
      requests.push({
        url: String(input),
        fieldMask: init?.headers?.['X-Goog-FieldMask'] ?? null,
      });
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        url: String(input),
        headers: { get: () => null },
        json: async () => next.body ?? {},
        text: async () => JSON.stringify(next.body ?? {}),
      };
    }),
  );
}

/** What Google answers about a described place. Everything here is invented. */
function googlePlace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ChIJ_GOGOTEST_preview_1',
    displayName: { text: 'Quán Google Nói Vậy' },
    formattedAddress: '99 Đường Google, Quận 1',
    location: { latitude: 10.78, longitude: 106.71 },
    businessStatus: 'OPERATIONAL',
    primaryType: 'cafe',
    types: ['cafe', 'food'],
    googleMapsUri: 'https://maps.google.com/?cid=42',
    rating: 4.6,
    userRatingCount: 321,
    regularOpeningHours: {
      periods: [
        { open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } },
        { open: { day: 5, hour: 20, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
      ],
    },
    priceLevel: 'PRICE_LEVEL_MODERATE',
    ...overrides,
  };
}

const outage = (): Stub[] =>
  Array.from({ length: 3 }, () => ({ status: 503, body: { error: { status: 'UNAVAILABLE' } } }));

// ------------------------------------------------------------- fixtures

let seq = 0;

async function seedPlace(): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `GoGo Nói Vậy ${seq}`,
      nameNormalized: 'set-by-trigger',
      status: 'published',
      geom: { x: 106.7 + seq / 1000, y: 10.77 },
      addressText: '1 Đường GoGo',
      rating: '4.10',
      ratingCount: 50,
      priceLevel: 1,
      confidence: '0.9',
    })
    .returning();
  await db.insert(schema.placeHours).values({
    placeId: row!.id,
    dayOfWeek: 1,
    openMinute: 540,
    closeMinute: 1260,
    isOvernight: false,
    source: 'provider',
    verifiedAt: new Date(),
  });
  return row!.id;
}

async function seedSource(placeId: string, externalId: string): Promise<string> {
  const [row] = await db
    .insert(schema.placeProviderSources)
    .values({
      placeId,
      provider: 'google_places',
      externalId,
      rating: '4.10',
      ratingCount: 50,
      derivedScore: '70.00',
      priceLevel: 1,
      primaryType: 'restaurant',
      refreshAfter: new Date('2026-10-01T00:00:00.000Z'),
      refreshPriority: 0,
      refreshAttempts: 0,
      attribution: { text: 'Google Maps' },
      sourceStatus: 'active',
      fetchTier: 'quality',
    })
    .returning();
  return row!.id;
}

async function seedKnownPlace(externalId = `ChIJ_GOGOTEST_stored_${++seq}`) {
  const placeId = await seedPlace();
  const sourceId = await seedSource(placeId, externalId);
  return { placeId, sourceId, externalId };
}

/** Everything the catalogue holds about one place, as JSON, for a before/after diff. */
async function snapshot(placeId: string): Promise<string> {
  const [places, sources, hours, prices] = await Promise.all([
    db.execute(sql`
      select name, status, address_text, ST_AsText(geom) as geom, rating, rating_count,
             price_level, confidence, freshness_checked_at, updated_at
      from places where id = ${placeId}::uuid`),
    db.execute(sql`
      select external_id, provider_uri, rating, rating_count, derived_score, price_level,
             primary_type, fetched_at, refresh_after, attribution, source_status, fetch_tier,
             refresh_priority, refresh_attempts, transient_failures, last_refresh_attempt_at,
             last_refresh_error_code, moved_to_external_id
      from place_provider_sources where place_id = ${placeId}::uuid order by external_id`),
    db.execute(sql`
      select day_of_week, open_minute, close_minute, is_overnight, source
      from place_hours where place_id = ${placeId}::uuid order by day_of_week, open_minute`),
    db.execute(sql`
      select price_min, price_max, unit, source from place_prices
      where place_id = ${placeId}::uuid order by created_at`),
  ]);
  return JSON.stringify({
    places: places.rows,
    sources: sources.rows,
    hours: hours.rows,
    prices: prices.rows,
  });
}

async function audits(placeId: string): Promise<{ action: string; diff: unknown }[]> {
  const { rows } = await db.execute(sql`
    select action, diff from audit_logs where resource_id = ${placeId}
    order by created_at asc`);
  return rows as unknown as { action: string; diff: unknown }[];
}

async function budgetRows(): Promise<
  { scope: string; operation: string; reserved_calls: number }[]
> {
  const { rows } = await db.execute(sql`
    select scope, operation, reserved_calls from provider_budget_daily order by scope, operation`);
  return rows as unknown as { scope: string; operation: string; reserved_calls: number }[];
}

async function setFlag(enabled: boolean) {
  await db.execute(sql`delete from feature_flags where key = 'place_provider_preview.enabled'`);
  await db.execute(sql`
    insert into feature_flags (key, environment, platform, enabled, payload)
    values ('place_provider_preview.enabled', ${ENV}, 'all', ${enabled}, null)`);
}

let editor: { id: string; token: string };
let moderator: { id: string; token: string };

async function preview(placeId: string, body: Record<string, unknown>, token = editor.token) {
  return api().inject({
    method: 'POST',
    url: `/v1/cms/places/${placeId}/provider-preview`,
    headers: auth(token),
    remoteAddress: ip(),
    payload: body,
  });
}

// ------------------------------------------------------------- lifecycle

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_preview_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.APP_ENV = ENV;
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  // The real adapter with a stub key: the mask on the wire is under test.
  process.env.PLACE_PROVIDER_MODE = 'google';
  process.env.GOOGLE_PLACES_API_KEY = 'preview-stub-key-not-a-credential';
  // Ceilings for the preview scope, wide enough that only the case under
  // test can refuse. The refresh scope is deliberately left unset: a preview
  // must never be able to spend it, and this proves it never needed to.
  process.env.PLACE_CMS_PREVIEW_DAILY_MAX_CALLS = '100';
  process.env.PLACE_CMS_PREVIEW_DAILY_MAX_LIST_COST_USD = '5';
  process.env.PLACE_CMS_PREVIEW_DAILY_MAX_UNITS_GOOGLE_DETAILS_CORE = '100';
  process.env.PLACE_CMS_PREVIEW_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY = '100';
  delete process.env.PLACE_REFRESH_DAILY_MAX_CALLS;

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  moderator = await createAdmin('moderator-preview@gogo.local', 'moderator');
}, 240_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await pool?.end();
  await container?.stop();
});

let editorSeq = 0;

beforeEach(async () => {
  queued = [];
  requests = [];
  resetBreakers();
  stubFetch();
  await setFlag(true);
  // A fresh actor per test: the preview route is rate-limited per actor
  // (burst 6/min), and one editor clicking through this whole file would be
  // refused for the right reason in the wrong test.
  editor = await createAdmin(`editor-preview-${++editorSeq}@gogo.local`, 'editor');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------- tests

describe('POST /v1/cms/places/:id/provider-preview (#341)', () => {
  it('is refused while the kill switch is off, and asks Google nothing', async () => {
    await setFlag(false);
    const { placeId } = await seedKnownPlace();
    const before = await snapshot(placeId);

    const res = await preview(placeId, { tier: 'core' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PROVIDER_PREVIEW_DISABLED', retryable: false });
    expect(requests).toHaveLength(0);
    expect(await snapshot(placeId)).toBe(before);
  });

  it("core: buys Pro, renders Google's answer beside nothing it stored, and stores none of it", async () => {
    const { placeId, externalId } = await seedKnownPlace();
    queued = [{ status: 200, body: googlePlace({ id: externalId }) }];
    const before = await snapshot(placeId);

    const res = await preview(placeId, { tier: 'core' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      outcome: 'found',
      tier: 'core',
      requestedGooglePlaceId: externalId,
      attribution: 'Google Maps',
      ephemeral: true,
      provider: {
        googlePlaceId: externalId,
        moved: false,
        name: 'Quán Google Nói Vậy',
        addressText: '99 Đường Google, Quận 1',
        location: { lat: 10.78, lng: 106.71 },
        businessStatus: 'OPERATIONAL',
        primaryType: 'cafe',
        types: ['cafe', 'food'],
        // Not fetched under core — and not zero either.
        quality: null,
      },
    });
    expect(body.provider.photos).toBeUndefined();
    expect(body.provider.raw).toBeUndefined();

    // The request that went out.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain(`/v1/places/${externalId}`);
    expect(requests[0]!.fieldMask).toContain('displayName');
    expect(requests[0]!.fieldMask).not.toContain('rating');

    // The catalogue, byte for byte.
    expect(await snapshot(placeId)).toBe(before);

    // The audit row: ids and the outcome, nothing Google said.
    const trail = await audits(placeId);
    expect(trail).toEqual([
      {
        action: 'place.provider_previewed',
        diff: {
          tier: 'core',
          outcome: 'found',
          googlePlaceId: externalId,
          answeredGooglePlaceId: externalId,
        },
      },
    ]);
    const serialized = JSON.stringify(trail);
    for (const leak of ['Quán Google', 'Đường Google', '4.6', '321', 'OPERATIONAL']) {
      expect(serialized).not.toContain(leak);
    }

    // The reservation, under its own scope.
    expect(await budgetRows()).toEqual([
      { scope: 'google.places.cms_preview', operation: 'google.details.core', reserved_calls: 1 },
    ]);
  });

  it('quality: buys Enterprise and carries the quality block, still storing nothing', async () => {
    const { placeId, externalId } = await seedKnownPlace();
    queued = [{ status: 200, body: googlePlace({ id: externalId }) }];
    const before = await snapshot(placeId);

    const res = await preview(placeId, { tier: 'quality' });

    expect(res.statusCode).toBe(201);
    expect(res.json().provider.quality).toEqual({
      rating: 4.6,
      ratingCount: 321,
      hours: [
        { dayOfWeek: 1, openMinute: 480, closeMinute: 1320, isOvernight: false },
        { dayOfWeek: 5, openMinute: 1200, closeMinute: 120, isOvernight: true },
      ],
      priceLevel: 2,
    });
    expect(requests[0]!.fieldMask).toContain('rating');
    expect(requests[0]!.fieldMask).not.toContain('reviews');
    expect(await snapshot(placeId)).toBe(before);
    // The stored provider row still says what it said: 4.10 / 50, not 4.6 / 321.
    const [row] = (
      await db.execute(sql`
        select rating, rating_count from place_provider_sources where place_id = ${placeId}::uuid`)
    ).rows as { rating: string; rating_count: number }[];
    expect(row).toEqual({ rating: '4.10', rating_count: 50 });
  });

  it('refuses the detail tier at the door — no click may buy reviews', async () => {
    const { placeId } = await seedKnownPlace();
    const res = await preview(placeId, { tier: 'detail' });
    expect(res.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
    expect((await preview(placeId, {})).statusCode).toBe(400);
  });

  it('passes FUTURE_OPENING through as an answer and leaves source_status alone', async () => {
    const { placeId, externalId } = await seedKnownPlace();
    queued = [
      { status: 200, body: googlePlace({ id: externalId, businessStatus: 'FUTURE_OPENING' }) },
    ];
    const before = await snapshot(placeId);

    const res = await preview(placeId, { tier: 'core' });

    expect(res.statusCode).toBe(201);
    expect(res.json().provider.businessStatus).toBe('FUTURE_OPENING');
    expect(await snapshot(placeId)).toBe(before);
    expect(before).toContain('"source_status":"active"');
  });

  it('reports a move when Google answers under another id, and repoints nothing', async () => {
    const { placeId, externalId } = await seedKnownPlace();
    queued = [{ status: 200, body: googlePlace({ id: 'ChIJ_GOGOTEST_successor' }) }];
    const before = await snapshot(placeId);

    const res = await preview(placeId, { tier: 'core' });

    expect(res.statusCode).toBe(201);
    expect(res.json().provider).toMatchObject({
      moved: true,
      googlePlaceId: 'ChIJ_GOGOTEST_successor',
    });
    expect(res.json().requestedGooglePlaceId).toBe(externalId);
    // Only PR7's liveness path may write `moved` / `moved_to_external_id`.
    expect(await snapshot(placeId)).toBe(before);
    expect(before).toContain('"moved_to_external_id":null');
    expect((await audits(placeId))[0]!.diff).toMatchObject({
      googlePlaceId: externalId,
      answeredGooglePlaceId: 'ChIJ_GOGOTEST_successor',
    });
  });

  it('Google NOT_FOUND is an answer, not an error, and not a status write', async () => {
    const { placeId, externalId } = await seedKnownPlace();
    queued = [{ status: 404, body: { error: { status: 'NOT_FOUND' } } }];
    const before = await snapshot(placeId);

    const res = await preview(placeId, { tier: 'core' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      outcome: 'not_found',
      tier: 'core',
      requestedGooglePlaceId: externalId,
      ephemeral: true,
      provider: null,
    });
    expect(await snapshot(placeId)).toBe(before);
    expect((await audits(placeId))[0]).toMatchObject({
      action: 'place.provider_previewed',
      diff: { outcome: 'not_found', answeredGooglePlaceId: null },
    });
  });

  it('Google INVALID_ARGUMENT is reported as an invalid id', async () => {
    const { placeId } = await seedKnownPlace();
    queued = [{ status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } }];
    const res = await preview(placeId, { tier: 'core' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ outcome: 'invalid_id', provider: null });
  });

  it('a provider outage is 503 retryable, mutates nothing, and is still audited as an attempt', async () => {
    const { placeId, externalId } = await seedKnownPlace();
    queued = outage();
    const before = await snapshot(placeId);

    const res = await preview(placeId, { tier: 'quality' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PLACE_PROVIDER_UNAVAILABLE', retryable: true });
    expect(await snapshot(placeId)).toBe(before);
    expect(await audits(placeId)).toEqual([
      {
        action: 'place.provider_previewed',
        diff: {
          tier: 'quality',
          outcome: 'provider_unavailable',
          googlePlaceId: externalId,
          answeredGooglePlaceId: null,
        },
      },
    ]);
  });

  it('quota exhaustion is the same 503, never NOT_FOUND', async () => {
    const { placeId } = await seedKnownPlace();
    queued = [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }];
    const before = await snapshot(placeId);
    const res = await preview(placeId, { tier: 'core' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('PLACE_PROVIDER_UNAVAILABLE');
    expect(await snapshot(placeId)).toBe(before);
  });

  it('a place with no Google identity is 409; an unknown place is 404', async () => {
    const orphan = await seedPlace();
    const res = await preview(orphan, { tier: 'core' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_NO_PROVIDER_SOURCE');
    const missing = await preview('00000000-0000-4000-8000-000000000000', { tier: 'core' });
    expect(missing.statusCode).toBe(404);
    expect(requests).toHaveLength(0);
  });

  it('a moderator cannot preview (editor-only write), and asks Google nothing', async () => {
    const { placeId } = await seedKnownPlace();
    const res = await preview(placeId, { tier: 'core' }, moderator.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ROLE_DENIED');
    expect(requests).toHaveLength(0);
  });

  it('is rate-limited per actor: the burst window refuses the seventh click', async () => {
    const burster = await createAdmin('burst-preview@gogo.local', 'editor');
    const { placeId, externalId } = await seedKnownPlace();
    queued = Array.from({ length: 7 }, () => ({
      status: 200,
      body: googlePlace({ id: externalId }),
    }));
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await preview(placeId, { tier: 'core' }, burster.token)).statusCode);
    }
    expect(codes.slice(0, 6)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(codes[6]).toBe(429);
    expect(requests).toHaveLength(6);
  });
});

describe('ProviderContentService budget semantics (#341)', () => {
  function boundary(env: Record<string, string>) {
    return new ProviderContentService(
      app.get(PlaceResolverService),
      db as never,
      { APP_ENV: ENV, ...env } as never,
      new MetricsRegistry(),
    );
  }

  it('refuses when no ceiling is configured — default deny, no fetch', async () => {
    const { externalId } = await seedKnownPlace();
    await expect(
      boundary({}).fetch({
        googlePlaceId: externalId,
        tier: 'core',
        scope: 'google.places.cms_preview',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_BUDGET_NOT_CONFIGURED', httpStatus: 503 });
    expect(requests).toHaveLength(0);
  });

  it('refuses past the ceiling, and the refused call never reaches Google', async () => {
    const { externalId } = await seedKnownPlace();
    const service = boundary({
      PLACE_CMS_PREVIEW_DAILY_MAX_CALLS: '1000',
      PLACE_CMS_PREVIEW_DAILY_MAX_LIST_COST_USD: '5',
      // One Enterprise unit for the day, and nothing for core.
      PLACE_CMS_PREVIEW_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY: '1',
    });
    const request = { googlePlaceId: externalId, scope: 'google.places.cms_preview' as const };
    queued = [{ status: 200, body: googlePlace({ id: externalId }) }];

    // Earlier tests already reserved quality units today; the ceiling here is
    // absolute for the day, so the first call may already be over it. Either
    // way the second must be refused and the wire must show no extra request.
    const sent = requests.length;
    const first = await service.fetch({ ...request, tier: 'quality' }).catch((e: unknown) => e);
    const second = await service.fetch({ ...request, tier: 'quality' }).catch((e: unknown) => e);
    expect(second).toMatchObject({
      code: 'PROVIDER_BUDGET_EXHAUSTED',
      httpStatus: 503,
      options: { retryable: false },
    });
    expect(requests.length - sent).toBeLessThanOrEqual(1);
    if (!(first instanceof Error)) expect(first).toMatchObject({ outcome: 'found' });

    await expect(service.fetch({ ...request, tier: 'core' })).rejects.toMatchObject({
      code: 'PROVIDER_BUDGET_NOT_CONFIGURED',
    });
  });

  it('never reserves under the refresh scope', async () => {
    const rows = await budgetRows();
    expect(rows.every((r) => r.scope === 'google.places.cms_preview')).toBe(true);
    expect(rows.some((r) => r.scope === 'google.places.refresh')).toBe(false);
  });
});

describe('POST /v1/cms/places/:id/refresh (#341, CMS#98)', () => {
  it('moves only the refresh clock and priority, calls no provider, and is audited', async () => {
    const { placeId, sourceId } = await seedKnownPlace();
    const before = await snapshot(placeId);

    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${placeId}/refresh`,
      headers: auth(editor.token),
      remoteAddress: ip(),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ requested: true });
    expect(requests).toHaveLength(0);

    const [row] = (
      await db.execute(sql`
        select refresh_after, refresh_priority, refresh_attempts, source_status, rating, fetched_at
        from place_provider_sources where id = ${sourceId}`)
    ).rows as {
      refresh_after: Date;
      refresh_priority: number;
      refresh_attempts: number;
      source_status: string;
      rating: string;
      fetched_at: Date | null;
    }[];
    expect(row!.refresh_priority).toBe(1);
    expect(new Date(row!.refresh_after).getTime()).toBeLessThanOrEqual(Date.now());
    expect(row!.refresh_attempts).toBe(0);
    expect(row!.source_status).toBe('active');
    expect(row!.rating).toBe('4.10');

    // Everything except the two scheduling columns is what it was.
    const after = JSON.parse(await snapshot(placeId));
    const was = JSON.parse(before);
    for (const src of after.sources) {
      delete src.refresh_after;
      delete src.refresh_priority;
    }
    for (const src of was.sources) {
      delete src.refresh_after;
      delete src.refresh_priority;
    }
    expect(after).toEqual(was);

    expect(await audits(placeId)).toEqual([
      { action: 'place.refresh_requested', diff: { refreshPriority: 1 } },
    ]);
  });

  it('is 409 without a Google identity and 404 for an unknown place', async () => {
    const orphan = await seedPlace();
    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${orphan}/refresh`,
      headers: auth(editor.token),
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_NO_PROVIDER_SOURCE');
    const missing = await api().inject({
      method: 'POST',
      url: '/v1/cms/places/00000000-0000-4000-8000-000000000000/refresh',
      headers: auth(editor.token),
      remoteAddress: ip(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('GET /v1/cms/places/:id carries the refresh bookkeeping (#341)', () => {
  it('exposes source_status, refresh_after, last error, successor id and tier per source', async () => {
    const { placeId, externalId } = await seedKnownPlace();
    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${placeId}`,
      headers: auth(editor.token),
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toEqual([
      expect.objectContaining({
        provider: 'google',
        externalId,
        sourceStatus: 'active',
        refreshAfter: '2026-10-01T00:00:00.000Z',
        lastRefreshErrorCode: null,
        movedToExternalId: null,
        fetchTier: 'quality',
      }),
    ]);
  });
});
