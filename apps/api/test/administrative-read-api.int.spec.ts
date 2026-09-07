import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import {
  ADMINISTRATIVE_DATASET,
  AdministrativeImportService,
  type InProcessAdministrativeDatasetCache,
} from '@gogo/modules';

/**
 * ADM-003 (#456) — the six endpoints, over the real pinned dataset.
 *
 * The dataset is imported and then published by hand, because the publish
 * endpoint is #458's work. That is deliberate: these tests must prove the read
 * side serves *only* the published version, and the cleanest way to prove it is
 * to have a staged version sitting beside the published one throughout.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
const get = (url: string, headers: Record<string, string> = {}) =>
  api().inject({ method: 'GET', url, headers });

let publishedVersion: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_read_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  publishedVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date() })
    .where(eq(schema.administrativeDatasetVersions.id, report.datasetVersionId));

  // A second, STAGED dataset sits beside the published one for the whole run.
  // Every assertion below is therefore also an assertion that staging is not
  // served — the failure mode this endpoint set most needs to not have.
  await new AdministrativeImportService(db).importPinnedSnapshot({ overrideRevision: 1 });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('GET /v1/administrative/version', () => {
  it('reports the published version and its record counts', async () => {
    const res = await get('/v1/administrative/version');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      datasetVersion: publishedVersion,
      counts: {
        provinces: 34,
        communes: 3321,
        legacyDistricts: 696,
        legacyCommunes: 10035,
        changes: 9569,
      },
    });
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('serves the published version, never the staged one', async () => {
    // Two datasets exist; exactly one is PUBLISHED, and it is the older.
    const staged = await db
      .select({ v: schema.administrativeDatasetVersions.combinedDatasetVersion })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'STAGED'));
    expect(staged).toHaveLength(1);
    expect(staged[0]!.v).not.toBe(publishedVersion);

    const res = await get('/v1/administrative/version');
    expect(res.json().datasetVersion).toBe(publishedVersion);
  });
});

describe('GET /v1/administrative/provinces', () => {
  it('returns the 34 current provinces ordered by code, with datasetVersion', async () => {
    const res = await get('/v1/administrative/provinces?limit=200');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.datasetVersion).toBe(publishedVersion);
    expect(body.total).toBe(34);
    expect(body.items).toHaveLength(34);
    expect(body.nextCursor).toBeNull();

    const codes = body.items.map((u: { code: string }) => u.code);
    expect(codes).toEqual([...codes].sort());
    expect(body.items[0]).toMatchObject({
      code: '01',
      name: 'Hà Nội',
      fullName: 'Thành phố Hà Nội',
      unitType: 'MUNICIPALITY',
      level: 'PROVINCE',
      isCurrent: true,
      parentCode: null,
    });
  });

  it('never returns a legacy district, even though 696 are stored', async () => {
    const res = await get('/v1/administrative/provinces?limit=200');
    const levels = new Set(res.json().items.map((u: { level: string }) => u.level));
    expect([...levels]).toEqual(['PROVINCE']);
  });

  it('pages deterministically through a stable order', async () => {
    const first = await get('/v1/administrative/provinces?limit=10');
    const page1 = first.json();
    expect(page1.items).toHaveLength(10);
    expect(page1.nextCursor).toBeTruthy();

    const second = await get(
      `/v1/administrative/provinces?limit=10&cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    const page2 = second.json();
    expect(page2.items).toHaveLength(10);
    // No overlap and no gap: page 2 continues strictly after page 1.
    expect(page2.items[0].code > page1.items[9].code).toBe(true);

    // The same request twice gives the same page — the property a cursor needs.
    const again = await get('/v1/administrative/provinces?limit=10');
    expect(again.json().items).toEqual(page1.items);
  });

  it('refuses a cursor it did not issue', async () => {
    const res = await get('/v1/administrative/provinces?cursor=bm90LWEtY3Vyc29y');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CURSOR');
  });
});

describe('GET /v1/administrative/provinces/{provinceCode}/communes', () => {
  it('returns the communes of one province, ordered and parented to it', async () => {
    const res = await get('/v1/administrative/provinces/01/communes?limit=200');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThan(100);
    expect(body.items.every((u: { parentCode: string }) => u.parentCode === '01')).toBe(true);
    expect(body.items.every((u: { level: string }) => u.level === 'COMMUNE')).toBe(true);
    expect(body.items.every((u: { isCurrent: boolean }) => u.isCurrent)).toBe(true);

    const codes = body.items.map((u: { code: string }) => u.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('sums to 3,321 across every province — hierarchy is complete', async () => {
    // Read from the snapshot the endpoint itself serves, rather than making 34
    // HTTP calls: the anonymous baseline is 120 requests a minute and spending
    // a third of it to re-derive one number would only make the suite fragile.
    // Three provinces are still checked over HTTP below, so the endpoint's own
    // mapping from snapshot to response stays covered.
    const cache = app.get<InProcessAdministrativeDatasetCache>(ADMINISTRATIVE_DATASET);
    const snapshot = await cache.active();
    const total = [...snapshot.communesByProvince.values()].reduce((n, l) => n + l.length, 0);
    expect(total).toBe(3321);
    expect(snapshot.communesByProvince.size).toBe(34);

    for (const code of ['01', '79', '48']) {
      const res = await get(`/v1/administrative/provinces/${code}/communes?limit=1`);
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(snapshot.communesByProvince.get(code)!.length);
    }
  });

  it('answers 404 for a code that names no current province, not an empty page', async () => {
    // "No communes" and "no such province" are different answers, and a client
    // that cannot tell them apart renders the wrong screen.
    const res = await get('/v1/administrative/provinces/99/communes');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('PROVINCE_NOT_FOUND');
  });

  it('answers 404 for a legacy province code, which is not current', async () => {
    // 45 was Quảng Trị before the merger and is not a current province.
    const res = await get('/v1/administrative/provinces/45/communes');
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/administrative/search', () => {
  it('matches accented, unaccented and mixed-case input alike', async () => {
    const results = await Promise.all(
      ['Ba Đình', 'ba dinh', 'BA DINH', 'phuong ba dinh', 'Phường Ba Đình'].map((q) =>
        get(`/v1/administrative/search?query=${encodeURIComponent(q)}&provinceCode=01`),
      ),
    );
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      const codes = res.json().items.map((u: { code: string }) => u.code);
      expect(codes).toContain('00004');
    }
  });

  it('excludes legacy units by default and includes them on request', async () => {
    const current = await get('/v1/administrative/search?query=Tr%C3%BAc%20B%E1%BA%A1ch');
    expect(current.json().items).toHaveLength(0);

    const withLegacy = await get(
      '/v1/administrative/search?query=Tr%C3%BAc%20B%E1%BA%A1ch&includeLegacy=true',
    );
    const items = withLegacy.json().items as { code: string; isCurrent: boolean }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((u) => !u.isCurrent)).toBe(true);
  });

  it('validates the province filter against the hierarchy', async () => {
    const res = await get('/v1/administrative/search?query=ba&provinceCode=99');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('PROVINCE_NOT_FOUND');
  });

  it('restricts results to the filtered province', async () => {
    const res = await get('/v1/administrative/search?query=an&provinceCode=01&limit=200');
    const items = res.json().items as { code: string; level: string; parentCode: string | null }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((u) => (u.level === 'PROVINCE' ? u.code : u.parentCode) === '01')).toBe(
      true,
    );
  });

  it('bounds the page and keeps ordering stable across identical calls', async () => {
    const a = await get('/v1/administrative/search?query=an&limit=25');
    const b = await get('/v1/administrative/search?query=an&limit=25');
    expect(a.json().items).toHaveLength(25);
    expect(a.json().items).toEqual(b.json().items);
  });

  it('refuses a limit above the maximum rather than silently clamping it', async () => {
    const res = await get('/v1/administrative/search?query=an&limit=5000');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/administrative/units/{code}', () => {
  it('returns only the current period by default', async () => {
    const res = await get('/v1/administrative/units/00004');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current).toMatchObject({ fullName: 'Phường Ba Đình', isCurrent: true });
    expect(body.periods).toHaveLength(1);
  });

  it('shows the code’s whole history when asked, because reuse is real', async () => {
    const res = await get('/v1/administrative/units/00004?includeLegacy=true');
    const body = res.json();
    expect(body.periods).toHaveLength(2);
    expect(body.periods.map((p: { fullName: string }) => p.fullName)).toEqual([
      'Phường Trúc Bạch',
      'Phường Ba Đình',
    ]);
    expect(body.current.fullName).toBe('Phường Ba Đình');
  });

  it('answers 404 for a code that names no current unit unless history is asked for', async () => {
    // 001 was Quận Ba Đình: a dissolved district, present in the data but not
    // current, so the default answer is "not found" rather than a legacy row.
    const plain = await get('/v1/administrative/units/001');
    expect(plain.statusCode).toBe(404);
    expect(plain.json().code).toBe('UNIT_NOT_CURRENT');

    const legacy = await get('/v1/administrative/units/001?includeLegacy=true');
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().current).toBeNull();
    expect(legacy.json().periods[0]).toMatchObject({
      level: 'LEGACY_DISTRICT',
      unitType: 'LEGACY_DISTRICT',
      effectiveTo: '2025-06-30',
    });
  });

  it('rejects a malformed code at the edge', async () => {
    expect((await get('/v1/administrative/units/abc')).statusCode).toBe(400);
  });
});

describe('GET /v1/administrative/resolve', () => {
  it('resolves a code to its current unit without a date', async () => {
    const res = await get('/v1/administrative/resolve?code=00004');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      requested: { code: '00004', at: null },
      unit: { fullName: 'Phường Ba Đình', isCurrent: true },
      successors: [],
      unresolved: false,
    });
  });

  it('resolves the same code to a different unit at an earlier date', async () => {
    // The whole reason a code alone is not an identity.
    const res = await get('/v1/administrative/resolve?code=00004&at=2020-01-01');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unit).toMatchObject({ fullName: 'Phường Trúc Bạch', isCurrent: false });
    expect(body.unit.effectiveTo).toBe('2025-06-30');
  });

  it('reports a canonical successor for a merged commune', async () => {
    // 00001 (Phường Phúc Xá) merged; the mapping resolves cleanly, so the
    // successor is a fact GoGo holds rather than a guess.
    const res = await get('/v1/administrative/resolve?code=00001&at=2020-01-01');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unresolved).toBe(false);
    expect(body.successors.length).toBeGreaterThan(0);
    expect(body.successors[0]).toMatchObject({
      changeType: expect.stringMatching(/MERGED|RENAMED/),
    });
  });

  it('never presents a quarantined split as a resolved successor', async () => {
    // 00007 (Phường Cống Vị) was divided across several current communes. The
    // source names a default; ADR-0019 forbids trusting it, so resolve reports
    // the unit with no successor and says so in a field.
    const res = await get('/v1/administrative/resolve?code=00007&at=2020-01-01');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unit.fullName).toBe('Phường Cống Vị');
    expect(body.successors).toEqual([]);
    expect(body.unresolved).toBe(true);
  });

  it('answers 404 when a code named nothing on the date asked for', async () => {
    const res = await get('/v1/administrative/resolve?code=00004&at=1800-01-01');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('UNIT_NOT_EFFECTIVE');
  });

  it('rejects a malformed date', async () => {
    expect((await get('/v1/administrative/resolve?code=00004&at=07-09-2026')).statusCode).toBe(400);
  });
});

describe('ETag and 304', () => {
  it('returns 304 with no body when the client already has the entity', async () => {
    const first = await get('/v1/administrative/provinces?limit=5');
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;

    const second = await get('/v1/administrative/provinces?limit=5', { 'if-none-match': etag });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('is stable across calls and carries a revalidating Cache-Control', async () => {
    const a = await get('/v1/administrative/provinces?limit=5');
    const b = await get('/v1/administrative/provinces?limit=5');
    expect(a.headers.etag).toBe(b.headers.etag);
    expect(a.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
  });

  it('gives different tags to every query variant that changes the body', async () => {
    const urls = [
      '/v1/administrative/provinces?limit=5',
      '/v1/administrative/provinces?limit=6',
      '/v1/administrative/version',
      '/v1/administrative/search?query=an',
      '/v1/administrative/search?query=an&includeLegacy=true',
      '/v1/administrative/search?query=an&provinceCode=01',
      '/v1/administrative/units/00004',
      '/v1/administrative/units/00004?includeLegacy=true',
      '/v1/administrative/resolve?code=00004',
      '/v1/administrative/resolve?code=00004&at=2020-01-01',
    ];
    const tags = await Promise.all(urls.map(async (u) => (await get(u)).headers.etag));
    expect(new Set(tags).size).toBe(urls.length);
  });

  it('does not serve a 304 to a client holding another query’s tag', async () => {
    const other = (await get('/v1/administrative/provinces?limit=5')).headers.etag as string;
    const res = await get('/v1/administrative/units/00004', { 'if-none-match': other });
    expect(res.statusCode).toBe(200);
  });
});

describe('the cache, from the outside', () => {
  it('answers repeated requests without reloading or re-asking the version', async () => {
    const cache = app.get<InProcessAdministrativeDatasetCache>(ADMINISTRATIVE_DATASET);
    const before = cache.statistics();

    for (let i = 0; i < 15; i += 1) await get('/v1/administrative/provinces?limit=5');

    const after = cache.statistics();
    expect(after.loads).toBe(before.loads);
    // Inside one 60s TTL window, fifteen requests ask PostgreSQL nothing.
    expect(after.versionChecks).toBe(before.versionChecks);
    expect(after.retained).toBeLessThanOrEqual(2);
  });

  it('holds one snapshot of ~14k units, not one per request', async () => {
    const cache = app.get<InProcessAdministrativeDatasetCache>(ADMINISTRATIVE_DATASET);
    const snapshot = await cache.active();
    const units = snapshot.counts;
    expect(units.provinces + units.communes + units.legacyDistricts + units.legacyCommunes).toBe(
      34 + 3321 + 696 + 10035,
    );
    expect(cache.statistics().retained).toBe(1);
  });

  it('issues no Redis command for any administrative read', async () => {
    // The cache is in-process by decision (ADR-0019 §8), and Upstash bills per
    // command. `provider_requests_total` is where a Redis call would show up.
    const before = await metricCount('upstash');
    for (const url of [
      '/v1/administrative/version',
      '/v1/administrative/provinces',
      '/v1/administrative/provinces/01/communes',
      '/v1/administrative/search?query=ba',
      '/v1/administrative/units/00004',
      '/v1/administrative/resolve?code=00004',
    ]) {
      expect((await get(url)).statusCode).toBe(200);
    }
    expect(await metricCount('upstash')).toBe(before);
  });
});

/** Sums `provider_requests_total` samples whose labels mention a provider. */
async function metricCount(provider: string): Promise<number> {
  // `/v1/metrics`, not `/metrics`: the app sets a global `v1` prefix, and an
  // earlier version of this helper asked for the unprefixed path, got a 404 and
  // returned 0 — so every "the provider counter did not move" assertion built
  // on it was comparing zero to zero. It throws now rather than answering 0,
  // because a scrape that cannot be read is not evidence of anything.
  const metrics = await api().inject({
    method: 'GET',
    url: '/v1/metrics',
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN ?? ''}` },
  });
  if (metrics.statusCode !== 200) {
    throw new Error(
      `metrics scrape failed with ${metrics.statusCode}; the assertion would be vacuous`,
    );
  }
  return metrics.body
    .split('\n')
    .filter((line) => line.startsWith('provider_requests_total') && line.includes(provider))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}
