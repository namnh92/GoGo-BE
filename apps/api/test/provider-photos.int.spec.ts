import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { createHmac } from 'node:crypto';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
} from '../../../libs/modules/identity/domain/actor';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  FakePlacePhotoDisplay,
  PLACE_PHOTO_DISPLAY,
  PLACE_PROVIDER,
  type FakePlaceProvider,
} from '@gogo/providers';
import { ProviderPhotosService } from '../../../libs/modules/search/application/provider-photos.service';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

/** ADR-0052: resolve-preview stays transient; the gallery route is gone. */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let fake: FakePlacePhotoDisplay;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.71.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
let seq = 0;

/** A marker that must never be found in the database after a request. */
const MARK = 'Zx509Mark';
const photoName = (placeId: string, n: number) => `places/${placeId}/photos/${MARK}${n}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

async function place(
  opts: { googleId?: string | null; status?: 'published' | 'draft' } = {},
): Promise<{ id: string; googleId: string | null }> {
  seq += 1;
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Quán ảnh ${seq}`,
      nameNormalized: 'set-by-trigger',
      status: opts.status ?? 'published',
      geom: { x: 106.7 + seq / 1000, y: 10.77 },
      confidence: '0.9',
    })
    .returning();
  const googleId = opts.googleId === undefined ? `ChIJ-photo-${seq}` : opts.googleId;
  if (googleId) {
    await db.execute(sql`
      insert into place_provider_sources (place_id, provider, external_id, attribution)
      values (${row!.id}, 'google_places', ${googleId}, '{"text":"Google Maps"}'::jsonb)
    `);
  }
  return { id: row!.id, googleId };
}

function seedPhotos(googleId: string, count: number) {
  fake.seed(
    googleId,
    Array.from({ length: count }, (_, i) => ({
      reference: photoName(googleId, i),
      widthPx: 4032,
      heightPx: 3024,
      authorAttributions: [
        {
          displayName: `Tác giả ${i}`,
          uri: `https://maps.google.com/maps/contrib/${MARK}${i}`,
          photoUri: `https://lh3.googleusercontent.com/a/${MARK}${i}`,
        },
      ],
      googleMapsUri: `https://www.google.com/maps/photo/${MARK}${i}`,
    })),
  );
  for (let i = 0; i < count; i++) {
    fake.seedMedia(photoName(googleId, i), { contentType: 'image/jpeg', bytes: JPEG });
  }
}

const read = (placeId: string) =>
  api().inject({
    method: 'GET',
    url: `/v1/places/google-provider-photo/${placeId}`,
    remoteAddress: ip(),
  });

async function setKillSwitch(enabled: boolean | null) {
  await db.execute(sql`delete from feature_flags where key = 'place_provider_photos.enabled'`);
  if (enabled === null) return;
  await db.execute(sql`
    insert into feature_flags (key, environment, platform, enabled)
    values ('place_provider_photos.enabled', 'all', 'all', ${enabled})
  `);
}

/** Every row of every table in `public`, searched as text for the marker. */
async function tablesContaining(needle: string): Promise<string[]> {
  const { rows } = await db.execute(sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  const hits: string[] = [];
  for (const { table_name } of rows as { table_name: string }[]) {
    const res = await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table_name)} t where t::text like ${`%${needle}%`}`,
    );
    if ((res.rows[0] as { n: number }).n > 0) hits.push(table_name);
  }
  return hits;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_provider_photos_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  // The budget: five billed photo calls per day, generous elsewhere.
  process.env.PLACE_DISPLAY_DAILY_MAX_CALLS = '100';
  process.env.PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD = '1';
  process.env.PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA = '5';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  fake = app.get(PLACE_PHOTO_DISPLAY);
  expect(fake).toBeInstanceOf(FakePlacePhotoDisplay);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  fake.failing = false;
  fake.hanging = false;
  fake.answerAs = null;
  fake.refCalls.length = 0;
  fake.mediaCalls.length = 0;
  fake.expired.clear();
  fake.callsAfterAbort = 0;
  // F-03: every case starts from an empty daily ledger — no case depends on
  // what an earlier one spent.
  await db.execute(sql`delete from provider_budget_daily where scope = 'google.places.display'`);
  await setKillSwitch(true);
});

describe('ADR-0052 resolve-preview photos', () => {
  it('keyed link resolve returns fresh photo credits without persisting a replay (#786 F-01)', async () => {
    const googleId = 'ChIJ-keyed-preview-786';
    const marker = 'KeyedPreviewCredits786';
    const clientIp = ip();
    app.get<FakePlaceProvider>(PLACE_PROVIDER).seed({
      providerPlaceId: googleId,
      name: 'Preview cafe',
      addressText: '12 Test, Hồ Chí Minh',
      lat: 10.7769,
      lng: 106.7009,
    });
    const request = () =>
      api().inject({
        method: 'POST',
        url: '/v1/places/resolve-google-maps-link',
        remoteAddress: clientIp,
        headers: { 'idempotency-key': 'keyed-resolve-preview-786' },
        payload: { url: `https://www.google.com/maps?place_id=${googleId}` },
      });
    const seed = (name: string) =>
      fake.seed(googleId, [
        {
          reference: `places/${googleId}/photos/${marker}`,
          widthPx: 100,
          heightPx: 100,
          authorAttributions: [{ displayName: name, uri: null, photoUri: null }],
          googleMapsUri: `https://www.google.com/maps/photo/${marker}`,
        },
      ]);
    seed(`${marker}-first`);
    const first = await request();
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json().candidate.photo.authorAttributions[0].displayName).toBe(`${marker}-first`);
    expect(await tablesContaining(marker)).toEqual([]);

    seed(`${marker}-second`);
    const second = await request();
    expect(second.statusCode).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    expect(second.json().candidate.photo.authorAttributions[0].displayName).toBe(
      `${marker}-second`,
    );
    expect(fake.mediaCalls).toHaveLength(0);
    expect(await tablesContaining(marker)).toEqual([]);
  });

  it('removes the transient place gallery route', async () => {
    const p = await place();
    const response = await api().inject({
      method: 'GET',
      url: `/v1/places/${p.id}/provider-photos`,
      remoteAddress: ip(),
    });
    expect(response.statusCode).toBe(404);
    expect(fake.mediaCalls).toHaveLength(0);
  });
  it('serves only one bounded preview without persisting a photo name or retrieval URL', async () => {
    const p = await place();
    seedPhotos(p.googleId!, 3);
    const response = await read(p.googleId!);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().photos).toHaveLength(1);
    expect(fake.mediaCalls).toHaveLength(1);
    expect(await tablesContaining(MARK)).toEqual([]);
  });
  it('returns no photo on budget refusal, provider failure or timeout', async () => {
    const p = await place();
    seedPhotos(p.googleId!, 1);
    fake.failing = true;
    expect((await read(p.googleId!)).json()).toMatchObject({ status: 'unavailable', photos: [] });
    fake.failing = false;
    fake.hanging = true;
    const service = app.get(ProviderPhotosService);
    const previous = service.deadlineMs;
    service.deadlineMs = 20;
    try {
      expect((await read(p.googleId!)).json()).toMatchObject({ status: 'unavailable', photos: [] });
    } finally {
      service.deadlineMs = previous;
      fake.hanging = false;
    }
    // Ref failures/timeouts buy no media, so there may be no ledger row to UPDATE.
    // The removed gallery's multi-photo purchases must not be a setup dependency.
    await db.execute(sql`insert into provider_budget_daily
      (day, scope, operation, reserved_calls, reserved_units, reserved_cost_micros)
      values ((now() at time zone 'UTC')::date, 'google.places.display', 'google.photoMedia', 5, 5, 35000)
      on conflict (day, scope, operation) do update set reserved_units = 5`);
    const callsBeforeRefusal = fake.mediaCalls.length;
    expect((await read(p.googleId!)).json()).toMatchObject({
      status: 'budget_exhausted',
      photos: [],
    });
    expect(fake.mediaCalls).toHaveLength(callsBeforeRefusal);
  });
});

describe.each(['candidatePhoto'] as const)('places.%s rate limit (#821)', (route) => {
  const photoUrl = (placeId: string) => `/v1/places/google-provider-photo/${placeId}`;

  async function register(email: string) {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email, password: 'Sufficiently-long-pw1!', displayName: 'Photo viewer' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().accessToken as string;
  }

  it('gives actors sharing an IP independent 120/min buckets, even across IP changes', async () => {
    const a = await register(`photo-limit-${route}-a@gogo.id.vn`);
    const b = await register(`photo-limit-${route}-b@gogo.id.vn`);
    const sharedIp = ip();
    const p = await place({ googleId: null });
    const request = (token: string, address = sharedIp) =>
      api().inject({
        method: 'GET',
        url: photoUrl(p.id),
        remoteAddress: address,
        headers: { authorization: `Bearer ${token}` },
      });
    for (let i = 0; i < 120; i++) {
      expect((await request(a)).statusCode).toBe(200);
      expect((await request(b)).statusCode).toBe(200);
    }
    expect((await request(a, ip())).statusCode).toBe(429);
    expect((await request(b)).statusCode).toBe(429);
    // Authenticated traffic did not consume the anonymous bucket on this IP.
    expect(
      (
        await api().inject({
          method: 'GET',
          url: photoUrl(p.id),
          remoteAddress: sharedIp,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('shares anonymous quota by IP and keeps other IPs independent', async () => {
    const sharedIp = ip();
    const p = await place({ googleId: null });
    const request = (address: string) =>
      api().inject({
        method: 'GET',
        url: photoUrl(p.id),
        remoteAddress: address,
      });
    for (let i = 0; i < 120; i++) expect((await request(sharedIp)).statusCode).toBe(200);
    expect((await request(sharedIp)).statusCode).toBe(429);
    expect((await request(ip())).statusCode).toBe(200);
  });

  it('shares the anonymous IP bucket for missing, invalid and expired credentials', async () => {
    const p = await place({ googleId: null });
    const sharedIp = ip();
    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'expired-user',
        sid: 'expired-session',
        act: 'user',
        exp: 1,
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', process.env.AUTH_JWT_SECRET!)
      .update(`${jwtHeader}.${payload}`)
      .digest('base64url');
    const expired = `${jwtHeader}.${payload}.${signature}`;
    const headers: Record<string, string>[] = [
      {},
      { authorization: 'Bearer invalid-private-token' },
      { authorization: `Bearer ${expired}` },
      { cookie: 'gogo_at=invalid-private-token' },
      { cookie: `gogo_at=${expired}` },
      { authorization: 'Basic invalid-private-token' },
    ];
    const request = (address: string, credentials: Record<string, string>) =>
      api().inject({
        method: 'GET',
        url: photoUrl(p.id),
        remoteAddress: address,
        headers: credentials,
      });
    for (let i = 0; i < 120; i++) {
      const res = await request(sharedIp, headers[i % headers.length]!);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('invalid-private-token');
      expect(res.body).not.toContain(expired);
    }
    for (const credentials of headers) {
      expect((await request(sharedIp, credentials)).statusCode).toBe(429);
      expect((await request(ip(), credentials)).statusCode).toBe(200);
    }
  });
});
