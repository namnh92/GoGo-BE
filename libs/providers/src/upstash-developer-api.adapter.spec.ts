import { describe, expect, it } from 'vitest';
import {
  UPSTASH_API_BASE,
  UpstashDeveloperApiClient,
  UpstashDeveloperApiError,
  foldPoints,
  foldStats,
  parseUpstashTime,
  upstashDeveloperApiFromEnv,
} from './upstash-developer-api.adapter';

/**
 * COST-BE-025 (#384) — the adapter against the documented stats body. The
 * fixture is the docs' own example (fetched 2026-09-03), Go timestamps and
 * all; nothing here talks to Upstash.
 */

const T = (day: string, time = '15:12:52.76649148') => `${day} ${time} +0000 UTC`;

const FIXTURE = {
  daily_net_commands: 7,
  dailyrequests: [
    { x: T('2025-08-31', '15:12:52.799480932'), y: 0 },
    { x: T('2025-09-04'), y: 7 },
  ],
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
  bandwidths: [
    { x: T('2025-08-31', '15:12:52.799480932'), y: 0 },
    { x: T('2025-09-04'), y: 7 },
  ],
  diskusage: [{ x: T('2025-08-31', '15:12:52.799480932'), y: 0 }],
  keyspace: [{ x: T('2025-08-31', '15:12:52.799480932'), y: 0 }],
  dailybilling: [
    { x: T('2025-08-31', '15:12:52.799480932'), y: 0 },
    { x: T('2025-09-04'), y: 1.333 },
  ],
  throughput: [{ x: T('2025-08-31', '15:12:52.799480932'), y: 0 }],
  dailybandwidth: 50_444_740_913,
  current_storage: 0,
  total_monthly_storage: 0,
  total_monthly_requests: 7,
};

const DB_ID = '0d2f3c1e-5b7a-4c9d-8e1f-2a3b4c5d6e7f';

type Call = { url: string; init: RequestInit };

function fetchWith(
  status: number,
  body: unknown,
  calls: Call[] = [],
): { fetchImpl: typeof fetch; calls: Call[] } {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch) =>
  new UpstashDeveloperApiClient(
    { email: 'ops@example.com', apiKey: 'secret-key', databaseId: DB_ID },
    fetchImpl,
  );

describe('parseUpstashTime', () => {
  it('reads Go time.String() with nanoseconds and a UTC offset', () => {
    expect(parseUpstashTime('2025-09-04 15:12:52.76649148 +0000 UTC')?.toISOString()).toBe(
      '2025-09-04T15:12:52.766Z',
    );
    expect(parseUpstashTime('2025-08-31 15:12:52.799480932 +0000 UTC')?.toISOString()).toBe(
      '2025-08-31T15:12:52.799Z',
    );
    expect(parseUpstashTime('2025-09-04 15:12:52 +0000 UTC')?.toISOString()).toBe(
      '2025-09-04T15:12:52.000Z',
    );
  });

  it('applies a non-UTC offset so the day is the UTC day', () => {
    // 01:30 in +07:00 is the previous UTC day.
    expect(parseUpstashTime('2025-09-05 01:30:00 +0700 +07')?.toISOString()).toBe(
      '2025-09-04T18:30:00.000Z',
    );
    expect(parseUpstashTime('2025-09-04 23:30:00 -0100 X')?.toISOString()).toBe(
      '2025-09-05T00:30:00.000Z',
    );
  });

  it('accepts a bare day and ISO-8601, and refuses the rest', () => {
    expect(parseUpstashTime('2025-09-04')?.toISOString()).toBe('2025-09-04T00:00:00.000Z');
    expect(parseUpstashTime('2025-09-04T10:00:00Z')?.toISOString()).toBe(
      '2025-09-04T10:00:00.000Z',
    );
    expect(parseUpstashTime('yesterday')).toBeNull();
    expect(parseUpstashTime(1_725_000_000)).toBeNull();
    expect(parseUpstashTime(undefined)).toBeNull();
  });
});

describe('foldPoints / foldStats (pure)', () => {
  it('normalises a chart to UTC days, sorted, dropping what cannot be placed', () => {
    const points = foldPoints(
      [
        { x: T('2025-09-04'), y: '7' },
        { x: T('2025-08-31'), y: 0 },
        { x: 'not a time', y: 5 },
        { x: T('2025-09-01'), y: 'NaN' },
        null,
        { y: 1 },
      ],
      'dailyrequests',
    );
    expect(points.map((p) => [p.day, p.value])).toEqual([
      ['2025-08-31', 0],
      ['2025-09-04', 7],
    ]);
    expect(points[1]!.at.toISOString()).toBe('2025-09-04T15:12:52.766Z');
  });

  it('treats an absent chart as empty and a non-list as a bad response', () => {
    expect(foldPoints(undefined, 'x')).toEqual([]);
    expect(foldPoints(null, 'x')).toEqual([]);
    expect(() => foldPoints('nope', 'diskusage')).toThrow(UpstashDeveloperApiError);
  });

  it('folds the documented example body', () => {
    const stats = foldStats(FIXTURE);
    expect(stats).toMatchObject({
      dailyNetCommands: 7,
      dailyBandwidthBytes: 50_444_740_913,
      currentStorageBytes: 0,
      totalMonthlyRequests: 7,
      totalMonthlyBandwidthBytes: null,
      totalMonthlyStorageBytes: 0,
      windowDays: 5,
    });
    expect(stats.dailyRequests.map((p) => [p.day, p.value])).toEqual([
      ['2025-08-31', 0],
      ['2025-09-04', 7],
    ]);
    expect(stats.dailyBandwidth.map((p) => [p.day, p.value])).toEqual([
      ['2025-08-31', 0],
      ['2025-09-04', 7],
    ]);
    expect(stats.diskUsage.map((p) => [p.day, p.value])).toEqual([['2025-08-31', 0]]);
  });

  it('reports a missing field as null — never 0 — and refuses a non-object body', () => {
    const stats = foldStats({});
    expect(stats).toEqual({
      dailyNetCommands: null,
      dailyBandwidthBytes: null,
      currentStorageBytes: null,
      totalMonthlyRequests: null,
      totalMonthlyBandwidthBytes: null,
      totalMonthlyStorageBytes: null,
      dailyRequests: [],
      dailyBandwidth: [],
      diskUsage: [],
      windowDays: null,
    });
    expect(() => foldStats([])).toThrow(UpstashDeveloperApiError);
    expect(() => foldStats('7')).toThrow(UpstashDeveloperApiError);
  });
});

describe('UpstashDeveloperApiClient', () => {
  it('GETs the stats endpoint with Basic email:key and folds the answer', async () => {
    const { fetchImpl, calls } = fetchWith(200, FIXTURE);
    const stats = await client(fetchImpl).stats();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${UPSTASH_API_BASE}/redis/stats/${DB_ID}`);
    expect(calls[0]!.init.method).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('ops@example.com:secret-key').toString('base64')}`,
    );
    expect(headers.Accept).toBe('application/json');
    expect(stats.dailyNetCommands).toBe(7);
    expect(stats.windowDays).toBe(5);
  });

  it('passes the abort signal through and lets an abort surface as itself', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    await expect(client(fetchImpl).stats({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('maps 401/403 to AUTH_FAILED, 404 to NOT_FOUND, 429 to RATE_LIMITED, others to HTTP_n', async () => {
    await expect(client(fetchWith(401, {}).fetchImpl).stats()).rejects.toMatchObject({
      name: 'UpstashDeveloperApiError',
      code: 'AUTH_FAILED',
    });
    await expect(client(fetchWith(403, {}).fetchImpl).stats()).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    await expect(client(fetchWith(404, {}).fetchImpl).stats()).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(client(fetchWith(429, {}).fetchImpl).stats()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(client(fetchWith(502, 'bad gateway').fetchImpl).stats()).rejects.toMatchObject({
      code: 'HTTP_502',
    });
  });

  it('refuses a body that is not JSON or not an object, and an unreachable host', async () => {
    await expect(client(fetchWith(200, 'not json at all').fetchImpl).stats()).rejects.toMatchObject(
      { code: 'BAD_RESPONSE' },
    );
    await expect(client(fetchWith(200, [1, 2]).fetchImpl).stats()).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(client(down).stats()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('refuses a bad database id, email or key before any request is made', () => {
    expect(
      () => new UpstashDeveloperApiClient({ email: 'a@b.c', apiKey: 'k', databaseId: 'no spaces' }),
    ).toThrow(UpstashDeveloperApiError);
    expect(
      () => new UpstashDeveloperApiClient({ email: 'a:b@c.d', apiKey: 'k', databaseId: DB_ID }),
    ).toThrow(UpstashDeveloperApiError);
    expect(
      () => new UpstashDeveloperApiClient({ email: 'a@b.c', apiKey: '', databaseId: DB_ID }),
    ).toThrow(UpstashDeveloperApiError);
  });
});

describe('upstashDeveloperApiFromEnv (INF-060 #114)', () => {
  const full = {
    UPSTASH_API_EMAIL: 'ops@example.com',
    UPSTASH_API_KEY: 'secret-key',
    UPSTASH_DATABASE_ID: DB_ID,
  };

  it('returns null when any of the three is absent or blank — the caller then registers nothing', () => {
    expect(upstashDeveloperApiFromEnv({})).toBeNull();
    expect(upstashDeveloperApiFromEnv({ ...full, UPSTASH_API_EMAIL: undefined })).toBeNull();
    expect(upstashDeveloperApiFromEnv({ ...full, UPSTASH_API_KEY: '  ' })).toBeNull();
    expect(upstashDeveloperApiFromEnv({ ...full, UPSTASH_DATABASE_ID: '' })).toBeNull();
    // The data-plane URL is not a Developer API credential.
    expect(upstashDeveloperApiFromEnv({ REDIS_URL: 'rediss://default:pw@host:6379' })).toBeNull();
  });

  it('builds a client from the three values', () => {
    expect(upstashDeveloperApiFromEnv(full)).toBeInstanceOf(UpstashDeveloperApiClient);
  });
});
