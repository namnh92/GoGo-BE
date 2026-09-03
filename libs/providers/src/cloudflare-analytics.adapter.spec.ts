import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_GRAPHQL_ENDPOINT,
  CloudflareAnalyticsClient,
  CloudflareAnalyticsError,
  classifyR2Action,
  cloudflareAnalyticsFromEnv,
  foldR2,
  foldWorkers,
  r2Query,
  workersQuery,
} from './cloudflare-analytics.adapter';

/**
 * COST-BE-024 (#383) — the adapter against GraphQL fixtures. The shapes are
 * the documented datasets (`r2OperationsAdaptiveGroups`,
 * `r2StorageAdaptiveGroups`, `workersInvocationsAdaptive`); nothing here
 * talks to Cloudflare.
 */

const ACCOUNT = '0123456789abcdef0123456789abcdef';

const R2_FIXTURE = {
  data: {
    viewer: {
      accounts: [
        {
          ops: [
            {
              dimensions: { bucketName: 'gogo-dev-assets', actionType: 'PutObject' },
              sum: { requests: 120 },
            },
            {
              dimensions: { bucketName: 'gogo-dev-assets', actionType: 'GetObject' },
              sum: { requests: 4_300 },
            },
            {
              dimensions: { bucketName: 'gogo-dev-assets', actionType: 'HeadObject' },
              sum: { requests: 700 },
            },
            {
              dimensions: { bucketName: 'gogo-dev-assets', actionType: 'ListObjects' },
              sum: { requests: 5 },
            },
            {
              dimensions: { bucketName: 'gogo-dev-assets', actionType: 'FrobnicateObject' },
              sum: { requests: 3 },
            },
            {
              dimensions: { bucketName: 'gogo-dev-public', actionType: 'GetObject' },
              sum: { requests: '9000' },
            },
          ],
          storage: [
            {
              dimensions: { bucketName: 'gogo-dev-assets' },
              max: { payloadSize: 1_500_000_000, metadataSize: 2_000_000, objectCount: 1_234 },
            },
            {
              dimensions: { bucketName: 'gogo-dev-public' },
              max: { payloadSize: '250000000', metadataSize: 0, objectCount: 40 },
            },
          ],
        },
      ],
    },
  },
};

const WORKERS_FIXTURE = {
  data: {
    viewer: {
      accounts: [
        {
          invocations: [
            {
              dimensions: { scriptName: 'gogo-dev-share-link' },
              sum: { requests: 3_210, errors: 4, subrequests: 3_300 },
            },
          ],
        },
      ],
    },
  },
};

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
  new CloudflareAnalyticsClient({ accountId: ACCOUNT, token: 'secret-token' }, fetchImpl);

describe('R2 action classes (pricing page, fetched 2026-09-03)', () => {
  it('folds each documented action into its class and leaves the rest unclassified', () => {
    expect(classifyR2Action('PutObject')).toBe('A');
    expect(classifyR2Action('CompleteMultipartUpload')).toBe('A');
    expect(classifyR2Action('ListObjects')).toBe('A');
    expect(classifyR2Action('GetObject')).toBe('B');
    expect(classifyR2Action('HeadBucket')).toBe('B');
    expect(classifyR2Action('UsageSummary')).toBe('B');
    expect(classifyR2Action('FrobnicateObject')).toBeNull();
    expect(classifyR2Action('')).toBeNull();
  });
});

describe('foldR2 / foldWorkers (pure)', () => {
  it('sums per bucket, keeps the raw breakdown, and counts unknown actions apart', () => {
    const account = R2_FIXTURE.data.viewer.accounts[0]!;
    const folded = foldR2(account.ops, account.storage);
    expect(folded.map((b) => b.bucketName)).toEqual(['gogo-dev-assets', 'gogo-dev-public']);
    expect(folded[0]).toMatchObject({
      classA: 125,
      classB: 5_000,
      unclassified: 3,
      peakBytes: 1_502_000_000,
      peakObjects: 1_234,
    });
    expect(folded[0]!.byAction).toEqual({
      PutObject: 120,
      GetObject: 4_300,
      HeadObject: 700,
      ListObjects: 5,
      FrobnicateObject: 3,
    });
    // Strings from the API are numbers to us; a bucket with ops and no storage row is still a bucket.
    expect(folded[1]).toMatchObject({ classA: 0, classB: 9_000, peakBytes: 250_000_000 });
  });

  it('drops groups with no bucket or action rather than inventing a name', () => {
    expect(foldR2([{ sum: { requests: 5 } }], [{ max: { payloadSize: 1 } }])).toEqual([]);
  });

  it('sums Workers per script', () => {
    const folded = foldWorkers([
      { dimensions: { scriptName: 'b' }, sum: { requests: 1, errors: 0, subrequests: 0 } },
      { dimensions: { scriptName: 'a' }, sum: { requests: 2, errors: 1, subrequests: 3 } },
      { dimensions: { scriptName: 'a' }, sum: { requests: 2, errors: 0, subrequests: 0 } },
    ]);
    expect(folded).toEqual([
      { scriptName: 'a', requests: 4, errors: 1, subrequests: 3 },
      { scriptName: 'b', requests: 1, errors: 0, subrequests: 0 },
    ]);
  });
});

describe('query text', () => {
  it('inlines the day and account as literals and filters buckets only when asked', () => {
    const plain = r2Query(ACCOUNT, '2026-09-03', undefined);
    expect(plain).toContain(`accountTag: "${ACCOUNT}"`);
    expect(plain).toContain('date: "2026-09-03"');
    expect(plain).not.toContain('bucketName_in');
    expect(plain).toContain('r2OperationsAdaptiveGroups');
    expect(plain).toContain('r2StorageAdaptiveGroups');
    const filtered = r2Query(ACCOUNT, '2026-09-03', ['gogo-dev-assets', 'gogo-dev-public']);
    expect(filtered).toContain('bucketName_in: ["gogo-dev-assets", "gogo-dev-public"]');
  });

  it('bounds Workers by a half-open UTC day', () => {
    const q = workersQuery(ACCOUNT, '2026-09-30', ['gogo-dev-share-link']);
    expect(q).toContain('datetime_geq: "2026-09-30T00:00:00Z"');
    expect(q).toContain('datetime_lt: "2026-10-01T00:00:00Z"');
    expect(q).toContain('scriptName_in: ["gogo-dev-share-link"]');
    expect(q).toContain('sum { requests errors subrequests }');
  });
});

describe('CloudflareAnalyticsClient', () => {
  it('POSTs the query with the bearer token and folds the R2 answer', async () => {
    const { fetchImpl, calls } = fetchWith(200, R2_FIXTURE);
    const usage = await client(fetchImpl).r2Usage({
      day: '2026-09-03',
      buckets: ['gogo-dev-assets'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(CLOUDFLARE_GRAPHQL_ENDPOINT);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-token',
    );
    const body = JSON.parse(calls[0]!.init.body as string) as { query: string };
    expect(body.query).toContain('bucketName_in: ["gogo-dev-assets"]');
    expect(usage.map((b) => b.bucketName)).toEqual(['gogo-dev-assets', 'gogo-dev-public']);
    expect(usage[0]).toMatchObject({ classA: 125, classB: 5_000, unclassified: 3 });
  });

  it('folds the Workers answer', async () => {
    const { fetchImpl } = fetchWith(200, WORKERS_FIXTURE);
    const usage = await client(fetchImpl).workersUsage({ day: '2026-09-03' });
    expect(usage).toEqual([
      { scriptName: 'gogo-dev-share-link', requests: 3_210, errors: 4, subrequests: 3_300 },
    ]);
  });

  it('an empty dataset is a measured zero, not an error', async () => {
    const { fetchImpl } = fetchWith(200, {
      data: { viewer: { accounts: [{ ops: [], storage: [] }] } },
    });
    expect(await client(fetchImpl).r2Usage({ day: '2026-09-03' })).toEqual([]);
  });

  it('maps 401/403 and an invisible account to AUTH_FAILED, 429 to RATE_LIMITED', async () => {
    await expect(
      client(fetchWith(403, {}).fetchImpl).r2Usage({ day: '2026-09-03' }),
    ).rejects.toMatchObject({
      name: 'CloudflareAnalyticsError',
      code: 'AUTH_FAILED',
    });
    await expect(
      client(fetchWith(200, { data: { viewer: { accounts: [] } } }).fetchImpl).r2Usage({
        day: '2026-09-03',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(
      client(fetchWith(429, {}).fetchImpl).workersUsage({ day: '2026-09-03' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(
      client(fetchWith(502, 'bad gateway').fetchImpl).r2Usage({ day: '2026-09-03' }),
    ).rejects.toMatchObject({ code: 'HTTP_502' });
  });

  it('surfaces GraphQL errors by code and refuses a malformed body', async () => {
    await expect(
      client(
        fetchWith(200, { data: null, errors: [{ message: 'unknown field frobnicate' }] }).fetchImpl,
      ).r2Usage({ day: '2026-09-03' }),
    ).rejects.toMatchObject({ code: 'GRAPHQL_ERROR' });
    await expect(
      client(
        fetchWith(200, {
          data: null,
          errors: [{ message: 'authentication error', extensions: { code: 'authError' } }],
        }).fetchImpl,
      ).r2Usage({ day: '2026-09-03' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(
      client(fetchWith(200, 'not json at all').fetchImpl).r2Usage({ day: '2026-09-03' }),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    await expect(
      client(
        fetchWith(200, { data: { viewer: { accounts: [{ ops: 'nope' }] } } }).fetchImpl,
      ).r2Usage({
        day: '2026-09-03',
      }),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('refuses a bad day or identifier before any request is made', async () => {
    const { fetchImpl, calls } = fetchWith(200, R2_FIXTURE);
    await expect(client(fetchImpl).r2Usage({ day: '3 Sep 2026' })).rejects.toBeInstanceOf(
      CloudflareAnalyticsError,
    );
    await expect(
      client(fetchImpl).r2Usage({ day: '2026-09-03', buckets: ['a"b'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(calls).toHaveLength(0);
    expect(() => new CloudflareAnalyticsClient({ accountId: 'no spaces', token: 't' })).toThrow(
      CloudflareAnalyticsError,
    );
  });
});

describe('cloudflareAnalyticsFromEnv (INF-060 #114)', () => {
  it('returns null when either credential is absent — the caller then registers nothing', () => {
    expect(cloudflareAnalyticsFromEnv({})).toBeNull();
    expect(cloudflareAnalyticsFromEnv({ CLOUDFLARE_ANALYTICS_TOKEN: 't' })).toBeNull();
    expect(cloudflareAnalyticsFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toBeNull();
    expect(
      cloudflareAnalyticsFromEnv({
        CLOUDFLARE_ANALYTICS_TOKEN: '  ',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      }),
    ).toBeNull();
  });

  it('builds a client from the token and account id, accepting R2_ACCOUNT_ID for the account', () => {
    expect(
      cloudflareAnalyticsFromEnv({
        CLOUDFLARE_ANALYTICS_TOKEN: 't',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      }),
    ).toBeInstanceOf(CloudflareAnalyticsClient);
    expect(
      cloudflareAnalyticsFromEnv({ CLOUDFLARE_ANALYTICS_TOKEN: 't', R2_ACCOUNT_ID: ACCOUNT }),
    ).toBeInstanceOf(CloudflareAnalyticsClient);
  });
});
