import { describe, expect, it } from 'vitest';
import {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GitHubBillingClient,
  GitHubBillingError,
  foldUsageReport,
  githubBillingFromEnv,
} from './github-billing.adapter';

/**
 * COST-BE-027 (#386) — the adapter against the enhanced billing platform's
 * usage report (docs.github.com/en/rest/billing/usage, fetched 2026-09-03).
 * The endpoint the issue names, `/settings/billing/actions`, was shut down on
 * 2025-09-26; nothing here talks to GitHub.
 */

const ACCOUNT = 'namnh92';

const REPORT = {
  usageItems: [
    {
      date: '2026-09-02',
      product: 'Actions',
      sku: 'Actions Linux',
      quantity: 380,
      unitType: 'Minutes',
      pricePerUnit: 0.006,
      grossAmount: 2.28,
      discountAmount: 2.28,
      netAmount: 0,
      repositoryName: 'namnh92/GoGo-BE',
    },
    {
      date: '2026-09-02',
      product: 'Actions',
      sku: 'Actions macOS',
      quantity: 12,
      unitType: 'minutes',
      pricePerUnit: 0.062,
      grossAmount: 0.744,
      discountAmount: 0,
      netAmount: 0.744,
      repositoryName: 'namnh92/GoGo-MobileApp',
    },
    {
      date: '2026-09-02',
      product: 'Packages',
      sku: 'Packages storage',
      quantity: 3,
      unitType: 'GigabyteHours',
      pricePerUnit: 0.008,
      grossAmount: 0.024,
      discountAmount: 0.024,
      netAmount: 0,
      repositoryName: 'namnh92/GoGo-BE',
    },
  ],
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

const client = (fetchImpl: typeof fetch, kind?: 'user' | 'organization') =>
  new GitHubBillingClient(
    { token: 'ghp_secret', account: ACCOUNT, ...(kind ? { accountKind: kind } : {}) },
    fetchImpl,
  );

describe('foldUsageReport (pure)', () => {
  it('normalises the documented body: product and unit lower-cased, sorted by day then sku', () => {
    const items = foldUsageReport(REPORT);
    expect(items.map((i) => [i.day, i.product, i.sku, i.quantity, i.unitType])).toEqual([
      ['2026-09-02', 'actions', 'Actions Linux', 380, 'minutes'],
      ['2026-09-02', 'actions', 'Actions macOS', 12, 'minutes'],
      ['2026-09-02', 'packages', 'Packages storage', 3, 'gigabytehours'],
    ]);
    expect(items[0]).toEqual({
      day: '2026-09-02',
      product: 'actions',
      sku: 'Actions Linux',
      quantity: 380,
      unitType: 'minutes',
      pricePerUnit: 0.006,
      grossAmount: 2.28,
      discountAmount: 2.28,
      netAmount: 0,
      repositoryName: 'namnh92/GoGo-BE',
      organizationName: null,
    });
  });

  it('drops a line that cannot be placed on a day, a product or a quantity', () => {
    const body = {
      usageItems: [
        { date: 'nope', product: 'Actions', quantity: 1 },
        { date: '2026-09-02', quantity: 1 },
        { date: '2026-09-02', product: 'Actions' },
        { date: '2026-09-02T00:00:00Z', product: 'Actions', quantity: '25' },
      ],
    };
    const items = foldUsageReport(body);
    // The timestamped date is truncated to its day; a numeric string is a number.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ day: '2026-09-02', quantity: 25, sku: '', unitType: null });
  });

  it('treats an absent list as empty and refuses a bad shape', () => {
    expect(foldUsageReport({})).toEqual([]);
    expect(foldUsageReport({ usageItems: [] })).toEqual([]);
    expect(() => foldUsageReport({ usageItems: 'x' })).toThrow(/not a list/);
    expect(() => foldUsageReport([])).toThrow(/not an object/);
  });

  it('reports a missing money field as null, never 0', () => {
    const items = foldUsageReport({
      usageItems: [{ date: '2026-09-02', product: 'Actions', quantity: 5 }],
    });
    expect(items[0]).toMatchObject({
      pricePerUnit: null,
      grossAmount: null,
      discountAmount: null,
      netAmount: null,
    });
  });
});

describe('GitHubBillingClient', () => {
  it('GETs the user usage report with the API version header and the year/month filter', async () => {
    const { fetchImpl, calls } = fetchWith(200, REPORT);
    const items = await client(fetchImpl).usage({ year: 2026, month: 9 });
    expect(items).toHaveLength(3);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${GITHUB_API_BASE}/users/${ACCOUNT}/settings/billing/usage`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({ year: '2026', month: '9' });
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer ghp_secret',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    });
  });

  it('uses the organizations path when the account is an org, and sends day when given', async () => {
    const { fetchImpl, calls } = fetchWith(200, REPORT);
    await client(fetchImpl, 'organization').usage({ year: 2026, month: 9, day: 2 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/organizations/${ACCOUNT}/settings/billing/usage`);
    expect(url.searchParams.get('day')).toBe('2');
  });

  it('maps 401 to AUTH_FAILED, 403 to FORBIDDEN, 404 to NOT_FOUND, 429 to RATE_LIMITED, others to HTTP_n', async () => {
    const cases: [number, string][] = [
      [401, 'AUTH_FAILED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'HTTP_500'],
    ];
    for (const [status, code] of cases) {
      const { fetchImpl } = fetchWith(status, { message: 'x' });
      await expect(client(fetchImpl).usage({ year: 2026 }), String(status)).rejects.toMatchObject({
        code,
      });
    }
  });

  it('refuses a non-JSON body and an unreachable host', async () => {
    const { fetchImpl } = fetchWith(200, 'not json');
    await expect(client(fetchImpl).usage({ year: 2026 })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(client(down).usage({ year: 2026 })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      message: 'github billing unreachable',
    });
  });

  it('passes the abort signal through and lets an abort surface as itself', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    await expect(
      client(fetchImpl).usage({ year: 2026, signal: controller.signal }),
    ).rejects.toThrow('aborted');
  });

  it('refuses a bad account, token or period before any request is made', async () => {
    expect(() => new GitHubBillingClient({ token: 't', account: 'not a login!' })).toThrow(
      /bad github account/,
    );
    expect(() => new GitHubBillingClient({ token: 'has space', account: ACCOUNT })).toThrow(
      /bad github token/,
    );
    expect(() => new GitHubBillingClient({ token: '', account: ACCOUNT })).toThrow(
      GitHubBillingError,
    );
    const { fetchImpl, calls } = fetchWith(200, REPORT);
    for (const bad of [{ year: 1900 }, { year: 2026, month: 13 }, { year: 2026, day: 0 }]) {
      await expect(client(fetchImpl).usage(bad)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
    expect(calls).toEqual([]);
  });
});

describe('githubBillingFromEnv (INF-060 #114)', () => {
  it('returns null when the token or the account is absent', () => {
    expect(githubBillingFromEnv({})).toBeNull();
    expect(githubBillingFromEnv({ GITHUB_BILLING_TOKEN: 't' })).toBeNull();
    expect(githubBillingFromEnv({ GITHUB_BILLING_ACCOUNT: ACCOUNT })).toBeNull();
    expect(githubBillingFromEnv({ GITHUB_BILLING_TOKEN: ' ', GITHUB_OWNER: ACCOUNT })).toBeNull();
  });

  it('falls back to GITHUB_OWNER for the account and defaults the kind to user', async () => {
    const { fetchImpl, calls } = fetchWith(200, REPORT);
    const c = githubBillingFromEnv(
      { GITHUB_BILLING_TOKEN: 't', GITHUB_OWNER: ACCOUNT },
      fetchImpl,
    )!;
    expect(c).toBeInstanceOf(GitHubBillingClient);
    await c.usage({ year: 2026 });
    expect(new URL(calls[0]!.url).pathname).toBe(`/users/${ACCOUNT}/settings/billing/usage`);
  });

  it('honours an organization account kind, however it is spelled', async () => {
    for (const kind of ['organization', 'ORG', 'Org']) {
      const { fetchImpl, calls } = fetchWith(200, REPORT);
      const c = githubBillingFromEnv(
        {
          GITHUB_BILLING_TOKEN: 't',
          GITHUB_BILLING_ACCOUNT: 'gogo-team',
          GITHUB_BILLING_ACCOUNT_KIND: kind,
        },
        fetchImpl,
      )!;
      await c.usage({ year: 2026 });
      expect(new URL(calls[0]!.url).pathname, kind).toBe(
        '/organizations/gogo-team/settings/billing/usage',
      );
    }
  });
});
