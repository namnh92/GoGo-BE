import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import argon2 from 'argon2';
import { schema } from '@gogo/database';

/**
 * SE-002..005 + SE-010 + BE-BFF-006 acceptance on the seeded corpus —
 * includes the SE-001 golden query set (see docs/search-relevance.md).
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

function api() {
  return app.getHttpAdapter().getInstance();
}

type Place = {
  name: string;
  lat: number;
  lng: number;
  rating: number;
  ratingCount: number;
  categories?: string[];
  suitability?: Record<string, number>;
  priceMin?: number;
  priceMax?: number;
  open?: number;
  close?: number;
  overnight?: boolean;
  isLodging?: boolean;
};

const CORPUS: Place[] = [
  {
    name: 'The Workshop Coffee',
    lat: 10.7743,
    lng: 106.7038,
    rating: 4.5,
    ratingCount: 2100,
    categories: ['cafe'],
    suitability: { couple: 0.9, group: 0.7 },
    priceMin: 60000,
    priceMax: 120000,
    open: 8 * 60,
    close: 21 * 60,
  },
  {
    name: 'Cà phê Đỗ Phủ',
    lat: 10.7889,
    lng: 106.6903,
    rating: 4.6,
    ratingCount: 980,
    categories: ['cafe'],
    suitability: { couple: 0.8 },
    priceMin: 45000,
    priceMax: 90000,
    open: 7 * 60,
    close: 20 * 60,
  },
  {
    name: 'Công viên Tao Đàn',
    lat: 10.7756,
    lng: 106.6917,
    rating: 4.4,
    ratingCount: 5200,
    categories: ['park'],
    suitability: { couple: 0.8, group: 0.8 },
    priceMin: 0,
    priceMax: 0,
    open: 5 * 60,
    close: 21 * 60,
  },
  {
    name: 'Saigon Rooftop Bar',
    lat: 10.7721,
    lng: 106.7042,
    rating: 4.2,
    ratingCount: 1700,
    categories: ['bar'],
    suitability: { couple: 0.9, group: 0.85 },
    priceMin: 200000,
    priceMax: 500000,
    open: 17 * 60,
    close: 4 * 60,
    overnight: true,
  },
  {
    name: 'Hồ Con Rùa Foodcourt',
    lat: 10.7827,
    lng: 106.6959,
    rating: 4.1,
    ratingCount: 4300,
    categories: ['restaurant'],
    suitability: { group: 0.95, couple: 0.3 },
    priceMin: 40000,
    priceMax: 120000,
    open: 15 * 60,
    close: 23 * 60,
  },
  {
    name: 'Khách sạn Ven Sông',
    lat: 10.78,
    lng: 106.71,
    rating: 4.0,
    ratingCount: 300,
    categories: ['lodging'],
    isLodging: true,
    priceMin: 800000,
    priceMax: 1500000,
    open: 0,
    close: 1439,
  },
];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_search_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const taxonomyIds = new Map<string, string>();
  for (const key of ['cafe', 'park', 'bar', 'restaurant', 'lodging']) {
    const [row] = await db.insert(schema.taxonomies).values({ kind: 'category', key }).returning();
    taxonomyIds.set(key, row!.id);
  }
  // SE-001 synonym: generic query "cà phê" expands to the cafe category.
  await db.insert(schema.taxonomySynonyms).values({
    taxonomyId: taxonomyIds.get('cafe')!,
    term: 'cà phê',
    locale: 'vi',
  });

  for (const p of CORPUS) {
    const [place] = await db
      .insert(schema.places)
      .values({
        name: p.name,
        nameNormalized: 'set-by-trigger',
        status: 'published',
        geom: { x: p.lng, y: p.lat },
        rating: p.rating.toFixed(2),
        ratingCount: p.ratingCount,
        suitability: p.suitability ?? null,
        isLodging: p.isLodging ?? false,
        confidence: '0.9',
        freshnessCheckedAt: new Date(),
      })
      .returning();
    for (const c of p.categories ?? []) {
      await db
        .insert(schema.placeTaxonomies)
        .values({ placeId: place!.id, taxonomyId: taxonomyIds.get(c)! });
    }
    if (p.priceMin !== undefined) {
      await db.insert(schema.placePrices).values({
        placeId: place!.id,
        priceMin: p.priceMin,
        priceMax: p.priceMax ?? p.priceMin,
        currency: 'VND',
        unit: 'per_person',
        confidence: '0.8',
        source: 'editor',
        verifiedAt: new Date(),
      });
    }
    for (let day = 0; day < 7; day++) {
      await db.insert(schema.placeHours).values({
        placeId: place!.id,
        dayOfWeek: day,
        openMinute: p.open ?? 0,
        closeMinute: p.close ?? 1439,
        isOvernight: p.overnight ?? false,
        source: 'editor',
      });
    }
  }

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

async function search(qs: string) {
  const res = await api().inject({ method: 'GET', url: `/v1/places/search?${qs}` });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    results: {
      name: string;
      reasonCodes: string[];
      open: { openNow: boolean; closesAtMinute?: number };
      pricePerPerson?: { min: number; max: number };
      isLodging: boolean;
    }[];
    nextCursor: string | null;
    meta: { weightsVersion: string };
  };
}

const names = (r: { results: { name: string }[] }) => r.results.map((x) => x.name);

describe('golden queries (SE-001/SE-008 baseline)', () => {
  it('G1: accented query matches', async () => {
    expect(names(await search('q=c%C3%A0%20ph%C3%AA')).slice(0, 3)).toContain(
      'The Workshop Coffee',
    );
  });

  it('G2: unaccented query matches accented names', async () => {
    const r = await search('q=ca%20phe');
    expect(names(r).slice(0, 3)).toContain('Cà phê Đỗ Phủ');
  });

  it('G3: basic typo tolerated via trigram', async () => {
    expect(names(await search('q=workshp'))).toContain('The Workshop Coffee');
  });

  it('G4: category + geo radius filter', async () => {
    const r = await search('categories=park&lat=10.776&lng=106.692&radiusM=2000');
    expect(names(r)).toContain('Công viên Tao Đàn');
    expect(names(r)).not.toContain('The Workshop Coffee');
  });

  it('G5: overnight open-at 03:00 returns only the rooftop bar', async () => {
    // 03:00 VN = 20:00 UTC previous day
    const r = await search('openAt=2026-08-27T03:00:00%2B07:00');
    expect(names(r)).toEqual(['Saigon Rooftop Bar']);
    expect(r.results[0]!.open.openNow).toBe(true);
  });

  it('G6: per-person price ceiling excludes expensive places', async () => {
    const r = await search('priceMaxPerPerson=50000');
    expect(names(r)).toContain('Công viên Tao Đàn');
    expect(names(r)).not.toContain('Saigon Rooftop Bar');
  });

  it('G7: suitedFor=couple filters group-only venues', async () => {
    const r = await search('suitedFor=couple');
    expect(names(r)).not.toContain('Hồ Con Rùa Foodcourt');
    expect(names(r)).toContain('The Workshop Coffee');
  });

  it('G8: zero result emits telemetry event without raw PII', async () => {
    const r = await search('q=zzzz-khong-ton-tai-9999');
    expect(r.results).toHaveLength(0);
    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(sql`${schema.outboxEvents.eventType} = 'search.zero_result'`);
    expect(events.length).toBeGreaterThan(0);
    const payload = events[0]!.payload as { queryNormalized: string };
    expect(payload.queryNormalized).toBe('zzzz-khong-ton-tai-9999');
  });
});

describe('SE-010 params + DTO facts', () => {
  it('lodging excluded by default, included via category', async () => {
    const plain = await search('');
    expect(names(plain)).not.toContain('Khách sạn Ven Sông');
    const withLodging = await search('categories=lodging');
    expect(names(withLodging)).toEqual(['Khách sạn Ven Sông']);
  });

  it('returns open state + per-person price facts, not composed copy', async () => {
    const r = await search('q=workshop&openAt=2026-08-27T10:00:00%2B07:00');
    const hit = r.results.find((x) => x.name === 'The Workshop Coffee')!;
    expect(hit.open.openNow).toBe(true);
    expect(hit.open.closesAtMinute).toBe(21 * 60);
    expect(hit.pricePerPerson).toMatchObject({ min: 60000, max: 120000 });
    expect(hit.reasonCodes).toContain('OPEN_NOW');
  });

  it('cursor pagination is stable without duplicates', async () => {
    const page1 = await search('limit=2');
    expect(page1.results).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await search(`limit=2&cursor=${page1.nextCursor}`);
    const all = [...names(page1), ...names(page2)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('distance sort requires coordinates', async () => {
    const res = await api().inject({ method: 'GET', url: '/v1/places/search?sort=distance' });
    expect(res.statusCode).toBe(400);
  });
});

describe('place detail (BE-BFF-006)', () => {
  it('aggregates hours/prices/taxonomies/sources with freshness', async () => {
    const list = await search('q=workshop');
    const id = (list.results[0] as unknown as { id: string }).id;
    const res = await api().inject({ method: 'GET', url: `/v1/places/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('The Workshop Coffee');
    expect(body.hours).toHaveLength(7);
    expect(body.prices.length).toBeGreaterThan(0);
    expect(body.taxonomies).toEqual([{ kind: 'category', key: 'cafe' }]);
  });

  it('404 for unknown place', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/places/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('place detail is a contract, not a SQL row (#169)', () => {
  it('sends numbers as numbers and timestamps as ISO-8601', async () => {
    const [place] = await db.select().from(schema.places).limit(1);
    const res = await api().inject({
      method: 'GET',
      url: `/v1/places/${place!.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // `numeric` arrives from Postgres as a string; a client calling .toFixed on
    // it crashed. TypeScript could not catch it — the generated type says number.
    if (body.rating !== undefined) expect(typeof body.rating).toBe('number');
    if (body.confidence !== undefined) expect(typeof body.confidence).toBe('number');
    if (body.freshnessCheckedAt) {
      expect(body.freshnessCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
  });

  it('uses the camelCase names the contract promises', async () => {
    const [place] = await db.select().from(schema.places).limit(1);
    const body = (await api().inject({ method: 'GET', url: `/v1/places/${place!.id}` })).json();

    expect(body).not.toHaveProperty('address_text');
    expect(body).not.toHaveProperty('rating_count');
    expect(body).not.toHaveProperty('freshness_checked_at');
    expect(body).toHaveProperty('ratingCount');
  });

  it('offers no photo rather than one that cannot load (#151)', async () => {
    const [place] = await db.select().from(schema.places).limit(1);
    const body = (await api().inject({ method: 'GET', url: `/v1/places/${place!.id}` })).json();

    // No media host configured in tests: the array is empty, so a client shows
    // its placeholder instead of a broken image.
    expect(Array.isArray(body.photos)).toBe(true);
    expect(body.photos).toHaveLength(0);
  });
});

/** Ops admin for the analytics read; the endpoint is ops-scoped. */
async function createOpsAdmin(email: string): Promise<string> {
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: 'ops', role: 'ops_admin' });
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: '10.55.0.1',
    payload: { email, password: 'admin-password-123' },
  });
  return res.json().accessToken as string;
}

/**
 * SE-006 (#36) — search analytics. The point is the denominator: zero-result
 * counts alone say nothing about whether search is working.
 */
describe('search analytics (SE-006, #36)', () => {
  it('counts every search, not only the empty ones', async () => {
    const before = await db.execute(
      sql`select coalesce(sum(searches), 0)::int as n from search_query_daily`,
    );
    const start = Number((before.rows[0] as { n: number }).n);

    await api().inject({ method: 'GET', url: '/v1/places/search?q=cafe&lat=10.77&lng=106.7' });
    await api().inject({
      method: 'GET',
      url: '/v1/places/search?q=khongcogiday&lat=10.77&lng=106.7',
    });

    const after = await db.execute(sql`
      select coalesce(sum(searches), 0)::int as searches,
             coalesce(sum(zero_results), 0)::int as zero_results
      from search_query_daily
    `);
    const row = after.rows[0] as { searches: number; zero_results: number };
    expect(Number(row.searches)).toBe(start + 2);
    expect(Number(row.zero_results)).toBeGreaterThanOrEqual(1);
  });

  it('stores no actor alongside a query', async () => {
    // The table has no actor column at all — the check is structural, because
    // a comment saying "we do not log the user" is not an assurance.
    const columns = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'search_query_daily'
    `);
    const names = (columns.rows as { column_name: string }[]).map((c) => c.column_name);
    expect(names).not.toContain('actor_id');
    expect(names.some((n) => n.includes('user') || n.includes('actor'))).toBe(false);
  });

  it('withholds a query term nobody else searched, but still counts it', async () => {
    const admin = await createOpsAdmin('se006@gogo.local');
    // One search of a unique term: below the visibility floor.
    await api().inject({
      method: 'GET',
      url: '/v1/places/search?q=chuoi%20rieng%20tu%20cua%20mot%20nguoi&lat=10.77&lng=106.7',
    });

    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/search-analytics?days=1',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const named = body.worstQueries.map((q: { query: string }) => q.query);
    expect(named.join(' ')).not.toContain('rieng tu');
    // Counted, though: hiding it entirely would understate the failure rate.
    expect(body.hiddenBelowFloor.searches).toBeGreaterThanOrEqual(1);
    expect(body.totals.searches).toBeGreaterThanOrEqual(1);
  });

  it('reports a zero-result rate, so a spike is something to alert on', async () => {
    const admin = await createOpsAdmin('se006-rate@gogo.local');
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/search-analytics?days=7',
      headers: { authorization: `Bearer ${admin}` },
    });
    const body = res.json();
    expect(body.totals.zeroResultRate).toBeGreaterThan(0);
    expect(body.totals.zeroResultRate).toBeLessThanOrEqual(1);
    expect(body.trend.length).toBeGreaterThanOrEqual(1);
    expect(body.totals.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
