import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { FakePlacePhotoDisplay, PLACE_PHOTO_DISPLAY } from '@gogo/providers';
import { ProviderPhotosService } from '../../../libs/modules/search/application/provider-photos.service';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

/**
 * GoGo-BE#509 — transient Google photos on Place Detail, over real HTTP and a
 * real Postgres, with the provider faked (never a real Google call).
 *
 * Owner decision 2026-10-02 (ADR-0029): display only. What these cases hold:
 * - nothing about a photo — its name, a URL, its bytes — lands in **any** table;
 * - the response is `private, no-store`;
 * - the kill switch is off by default and a `feature_flags` row flips it;
 * - the daily budget is default-deny and bounds billed media calls per photo;
 * - a provider failure, timeout or moved place answers 200 with no photos,
 *   and Place Detail itself is untouched;
 * - no Google price range is exposed anywhere (core rule 13).
 */

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
    url: `/v1/places/${placeId}/provider-photos`,
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

describe('GET /v1/places/:id/provider-photos', () => {
  it('the no-persistence probe can see a marker when one is stored (control)', async () => {
    const p = await place();
    await db.execute(sql`update places set description = ${`ctl-${MARK}`} where id = ${p.id}`);
    expect(await tablesContaining(`ctl-${MARK}`)).toEqual(['places']);
    await db.execute(sql`update places set description = null where id = ${p.id}`);
  });

  it('is off by default: no row, no Google call, and never cacheable', async () => {
    await setKillSwitch(null);
    const p = await place();
    seedPhotos(p.googleId!, 1);

    const res = await read(p.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({
      status: 'disabled',
      provider: 'google',
      attribution: 'Google Maps',
      photos: [],
    });
    expect(fake.refCalls).toEqual([]);
  });

  it('404s a place Place Detail would not show', async () => {
    const draft = await place({ status: 'draft' });
    expect((await read(draft.id)).statusCode).toBe(404);
    expect((await read('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('says not_linked for a place with no Google Place ID, without calling Google', async () => {
    const p = await place({ googleId: null });
    const res = await read(p.id);
    expect(res.json()).toMatchObject({ status: 'not_linked', photos: [] });
    expect(fake.refCalls).toEqual([]);
  });

  it('serves at most three photos, each with its credit, and stores none of it', async () => {
    const p = await place();
    seedPhotos(p.googleId!, 5);

    const res = await read(p.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.attribution).toBe('Google Maps');
    expect(body.photos).toHaveLength(3);
    expect(fake.mediaCalls).toHaveLength(3);
    expect(body.photos[0]).toEqual({
      contentType: 'image/jpeg',
      dataBase64: Buffer.from(JPEG).toString('base64'),
      widthPx: 4032,
      heightPx: 3024,
      authorAttributions: [
        {
          displayName: 'Tác giả 0',
          uri: `https://maps.google.com/maps/contrib/${MARK}0`,
          photoUri: `https://lh3.googleusercontent.com/a/${MARK}0`,
        },
      ],
      googleMapsUri: `https://www.google.com/maps/photo/${MARK}0`,
    });
    // Core rule 13: nothing price-shaped from Google, here or anywhere.
    expect(JSON.stringify(body)).not.toMatch(/price/i);

    // No persistence: neither the photo name, its links nor its bytes are in
    // any table. Only counts (provider_budget_daily) were written.
    expect(await tablesContaining(MARK)).toEqual([]);
    expect(await tablesContaining(Buffer.from(JPEG).toString('base64'))).toEqual([]);
    const budget = await db.execute(sql`
      select scope, operation, reserved_calls, reserved_units
      from provider_budget_daily where scope = 'google.places.display'
    `);
    expect(
      (budget.rows as { operation: string; reserved_units: unknown }[]).map((r) => ({
        operation: r.operation,
        units: Number(r.reserved_units),
      })),
    ).toEqual([{ operation: 'google.photoMedia', units: 3 }]);
  });

  it('stops at the daily budget: 3 → 2 → none, inside one case', async () => {
    // Five billed photo calls a day (beforeAll). Three, then the two left.
    const p = await place();
    seedPhotos(p.googleId!, 3);
    expect((await read(p.id)).json().photos).toHaveLength(3);

    const partial = (await read(p.id)).json();
    expect(partial).toMatchObject({ status: 'ok' });
    expect(partial.photos).toHaveLength(2);

    const none = (await read(p.id)).json();
    expect(none).toEqual({
      status: 'budget_exhausted',
      provider: 'google',
      attribution: 'Google Maps',
      photos: [],
    });
    expect(fake.mediaCalls).toHaveLength(5);
  });

  it('refetches an expired photo name once and serves the fresh one', async () => {
    const p = await place();
    seedPhotos(p.googleId!, 1);
    fake.expired.add(photoName(p.googleId!, 0));
    // The fresh lookup names the same photo anew.
    const original = fake.photos.get(p.googleId!)!;
    let lookups = 0;
    const photoRefs = fake.photoRefs.bind(fake);
    fake.photoRefs = async (id, options) => {
      lookups += 1;
      if (lookups === 2) {
        const freshName = `places/${id}/photos/${MARK}fresh`;
        fake.seed(id, [{ ...original[0]!, reference: freshName }]);
        fake.seedMedia(freshName, { contentType: 'image/jpeg', bytes: JPEG });
      }
      return photoRefs(id, options);
    };
    try {
      const body = (await read(p.id)).json();
      expect(body.status).toBe('ok');
      expect(body.photos).toHaveLength(1);
      expect(lookups).toBe(2);
      expect(fake.mediaCalls).toHaveLength(2);
    } finally {
      fake.photoRefs = photoRefs;
    }
  });

  it('a provider outage answers 200 with no photos; Place Detail is untouched', async () => {
    const p = await place();
    seedPhotos(p.googleId!, 1);
    fake.failing = true;
    const res = await read(p.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unavailable', photos: [] });

    const detail = await api().inject({
      method: 'GET',
      url: `/v1/places/${p.id}`,
      remoteAddress: ip(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).not.toHaveProperty('priceRange');
    expect(detail.json().photos).toEqual([]);
  });

  it('a provider that hangs is cut off by the deadline, not waited on', async () => {
    const p = await place();
    seedPhotos(p.googleId!, 1);
    fake.hanging = true;
    const started = Date.now();
    const res = await read(p.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unavailable', photos: [] });
    expect(Date.now() - started).toBeLessThan(9_000);
    // F-01: the deadline aborted the call; nothing ran after it.
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.mediaCalls).toEqual([]);
    expect(fake.callsAfterAbort).toBe(0);
  }, 20_000);

  it("refuses a moved place's photos — the successor is not this place", async () => {
    const p = await place();
    seedPhotos(p.googleId!, 1);
    fake.answerAs = 'ChIJ-successor';
    const res = await read(p.id);
    expect(res.json()).toMatchObject({ status: 'unavailable', photos: [] });
    expect(fake.mediaCalls).toEqual([]);
  });

  it('F-10 (SA): reads Google identity through the provenance reader and its rollback switch', async () => {
    // Canonical row and a legacy import row disagree about the Google id.
    const p = await place({ googleId: 'ChIJ-canonical-f10' });
    await db.execute(sql`
      insert into place_sources (place_id, provider, external_id)
      values (${p.id}, 'google', 'ChIJ-legacy-f10')
    `);
    seedPhotos('ChIJ-canonical-f10', 1);
    seedPhotos('ChIJ-legacy-f10', 1);
    const config = {
      APP_ENV: 'dev' as const,
      FLAG_PLACE_PROVIDER_PHOTOS: true,
      PLACE_DISPLAY_DAILY_MAX_CALLS: 100,
      PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD: 1,
      PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA: 5,
    };
    const unified = new ProviderPhotosService(db as never, fake, config);
    const rolledBack = new ProviderPhotosService(db as never, fake, {
      ...config,
      PROVENANCE_UNIFIED_READS: false,
    });

    await unified.photos(p.id);
    expect(fake.refCalls.at(-1)).toBe('ChIJ-canonical-f10');
    // #334 rollback: Place Detail reads `place_sources` alone — so does this.
    await rolledBack.photos(p.id);
    expect(fake.refCalls.at(-1)).toBe('ChIJ-legacy-f10');
  });

  it('F-10 (SA): a canonical row the place moved away from is not asked about', async () => {
    const p = await place({ googleId: 'ChIJ-moved-f10' });
    await db.execute(sql`
      update place_provider_sources set source_status = 'moved' where place_id = ${p.id}
    `);
    const res = await read(p.id);
    expect(res.json()).toMatchObject({ status: 'not_linked', photos: [] });
    expect(fake.refCalls).toEqual([]);
  });

  it('the kill switch row turns it off on the next request', async () => {
    const p = await place();
    seedPhotos(p.googleId!, 1);
    await setKillSwitch(false);
    expect((await read(p.id)).json()).toMatchObject({ status: 'disabled' });
    expect(fake.refCalls).toEqual([]);
  });
});
