import { describe, expect, it } from 'vitest';
import {
  SENTRY_API_BASE,
  SentryStatsClient,
  SentryStatsError,
  foldDayStats,
  foldProjects,
  sentryStatsFromEnv,
} from './sentry-stats.adapter';

/**
 * BE#696 — the adapter against `stats_v2` and `/projects/`. Fixtures are the
 * bodies the live API returned for gogo-vn on 2026-10-15 (ids numeric in
 * `by.project`, strings in `/projects/`, `by` key order varying). Nothing
 * here talks to Sentry.
 */

const TOKEN = 'sntrys_secret_token_value';
const DAY = '2026-10-14';

const STATS_DAY = {
  start: '2026-10-14T00:00:00Z',
  end: '2026-10-15T00:00:00Z',
  groups: [
    { by: { project: 4512252504178688, outcome: 'accepted' }, totals: { 'sum(quantity)': 8 } },
    { by: { outcome: 'accepted', project: 4512252504178689 }, totals: { 'sum(quantity)': 5 } },
    {
      by: { outcome: 'rate_limited', project: 4512252504178689 },
      totals: { 'sum(quantity)': 3 },
    },
  ],
};

const PROJECTS = [
  { id: '4512201628254209', slug: 'gogo-be', name: 'gogo-be' },
  { id: '4512252504178689', slug: 'gogo-cms', name: 'gogo-cms' },
  { id: '4512252504178688', slug: 'gogo-mobile', name: 'gogo-mobile' },
];

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
  new SentryStatsClient({ token: TOKEN, org: 'gogo-vn' }, fetchImpl);

async function caught(p: Promise<unknown>): Promise<SentryStatsError> {
  try {
    await p;
  } catch (err) {
    return err as SentryStatsError;
  }
  throw new Error('expected a rejection');
}

describe('foldDayStats', () => {
  it('folds groups by name, ids as strings, sorted', () => {
    expect(foldDayStats(DAY, STATS_DAY)).toEqual({
      day: DAY,
      totals: [
        { projectId: '4512252504178688', outcome: 'accepted', quantity: 8 },
        { projectId: '4512252504178689', outcome: 'accepted', quantity: 5 },
        { projectId: '4512252504178689', outcome: 'rate_limited', quantity: 3 },
      ],
    });
  });

  it('a body without groups, or with groups null, is BAD_RESPONSE — never a zero', () => {
    const { groups: _omitted, ...noGroups } = STATS_DAY;
    for (const body of [noGroups, { ...STATS_DAY, groups: null }]) {
      expect(() => foldDayStats(DAY, body)).toThrow(
        expect.objectContaining({ code: 'BAD_RESPONSE' }),
      );
    }
  });

  it('a 200 with no groups for the day is a measured zero', () => {
    expect(foldDayStats(DAY, { ...STATS_DAY, groups: [] })).toEqual({ day: DAY, totals: [] });
  });

  it('refuses a range that is not exactly the requested day', () => {
    for (const body of [
      { ...STATS_DAY, end: '2026-10-16T00:00:00Z' },
      { ...STATS_DAY, start: '2026-10-13T00:00:00Z' },
      { groups: [] },
    ]) {
      expect(() => foldDayStats(DAY, body)).toThrow(
        expect.objectContaining({ code: 'BAD_RESPONSE' }),
      );
    }
  });

  it('accepts an offset form of the same instants', () => {
    const body = { ...STATS_DAY, start: '2026-10-14T00:00:00+00:00' };
    expect(foldDayStats(DAY, body).totals).toHaveLength(3);
  });

  it('drops groups without a usable project, outcome or total', () => {
    const body = {
      ...STATS_DAY,
      groups: [
        { by: { outcome: 'accepted' }, totals: { 'sum(quantity)': 1 } },
        { by: { project: 1 }, totals: { 'sum(quantity)': 1 } },
        { by: { project: 1, outcome: 'accepted' }, totals: { 'sum(quantity)': 'x' } },
        { by: { project: 1, outcome: 'accepted' }, totals: { 'sum(quantity)': -1 } },
        null,
        { by: { project: 1, outcome: 'Accepted' }, totals: { 'sum(quantity)': 2 } },
      ],
    };
    expect(foldDayStats(DAY, body).totals).toEqual([
      { projectId: '1', outcome: 'accepted', quantity: 2 },
    ]);
  });

  it('refuses a body that is not an object or groups that are not a list', () => {
    expect(() => foldDayStats(DAY, [])).toThrow(SentryStatsError);
    expect(() => foldDayStats(DAY, { ...STATS_DAY, groups: {} })).toThrow(SentryStatsError);
  });
});

describe('foldProjects', () => {
  it('keeps id + slug, sorted by slug', () => {
    expect(foldProjects(PROJECTS)).toEqual([
      { id: '4512201628254209', slug: 'gogo-be' },
      { id: '4512252504178689', slug: 'gogo-cms' },
      { id: '4512252504178688', slug: 'gogo-mobile' },
    ]);
  });

  it('refuses a non-list body', () => {
    expect(() => foldProjects({ detail: 'x' })).toThrow(SentryStatsError);
  });
});

describe('SentryStatsClient', () => {
  it('asks stats_v2 for one UTC day, errors grouped by outcome and project, bearer only', async () => {
    const { fetchImpl, calls } = fetchWith(200, STATS_DAY);
    const stats = await client(fetchImpl).errorsForDay({ day: DAY });
    expect(stats.totals).toHaveLength(3);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${SENTRY_API_BASE}/api/0/organizations/gogo-vn/stats_v2/`,
    );
    expect(url.searchParams.get('field')).toBe('sum(quantity)');
    expect(url.searchParams.getAll('groupBy')).toEqual(['outcome', 'project']);
    expect(url.searchParams.get('category')).toBe('error');
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.get('start')).toBe('2026-10-14T00:00:00Z');
    expect(url.searchParams.get('end')).toBe('2026-10-14T23:59:59Z');
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('lists the org projects', async () => {
    const { fetchImpl, calls } = fetchWith(200, PROJECTS);
    expect(await client(fetchImpl).projects()).toHaveLength(3);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/0/organizations/gogo-vn/projects/');
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'HTTP_500'],
  ])('maps %i to %s without the token, URL or body in the error', async (status, code) => {
    const { fetchImpl } = fetchWith(status, { detail: `echo ${TOKEN}` });
    const err = await caught(client(fetchImpl).errorsForDay({ day: DAY }));
    expect(err).toBeInstanceOf(SentryStatsError);
    expect(err.code).toBe(code);
    const text = `${String(err)} ${err.message} ${JSON.stringify(err)} ${String(err.cause ?? '')}`;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('stats_v2/?');
    expect(text).not.toContain('echo');
    expect(err.cause).toBeUndefined();
  });

  it('a body that is not JSON is BAD_RESPONSE', async () => {
    const { fetchImpl } = fetchWith(200, '<html>');
    expect((await caught(client(fetchImpl).errorsForDay({ day: DAY }))).code).toBe('BAD_RESPONSE');
  });

  it('an unreachable host is BAD_RESPONSE and the raw error — which may echo URL and headers — is dropped', async () => {
    const leaky = (async (url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      throw new TypeError(`fetch failed ${String(url)} ${auth}`, {
        cause: new Error(`connect ECONNREFUSED ${auth}`),
      });
    }) as typeof fetch;
    const err = await caught(client(leaky).projects());
    expect(err).toBeInstanceOf(SentryStatsError);
    expect(err.code).toBe('BAD_RESPONSE');
    expect(err.cause).toBeUndefined();
    const text = `${String(err)} ${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('/api/0/');
  });

  it('forwards the caller’s signal to fetch, and an external abort is rethrown as is', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }) as typeof fetch;
    const running = caught(client(pending).errorsForDay({ day: DAY, signal: ac.signal }));
    ac.abort();
    const err = await running;
    expect(seen).toBe(ac.signal);
    expect(err).not.toBeInstanceOf(SentryStatsError);
    expect((err as unknown as DOMException).name).toBe('AbortError');
  });

  it('refuses a bad day, org or token before any call', async () => {
    const { fetchImpl, calls } = fetchWith(200, STATS_DAY);
    expect((await caught(client(fetchImpl).errorsForDay({ day: '2026-10-14T00' }))).code).toBe(
      'INVALID_ARGUMENT',
    );
    expect(calls).toHaveLength(0);
    expect(() => new SentryStatsClient({ token: TOKEN, org: 'Bad Org' }, fetchImpl)).toThrow(
      SentryStatsError,
    );
    expect(() => new SentryStatsClient({ token: 'a b', org: 'gogo-vn' }, fetchImpl)).toThrow(
      SentryStatsError,
    );
  });
});

describe('sentryStatsFromEnv', () => {
  it('is null without a token — the collector is then not registered', () => {
    expect(sentryStatsFromEnv({})).toBeNull();
    expect(sentryStatsFromEnv({ SENTRY_STATS_TOKEN: '  ', SENTRY_ORG: 'gogo-vn' })).toBeNull();
  });

  it('defaults the org to gogo-vn and honours SENTRY_ORG', async () => {
    const { fetchImpl, calls } = fetchWith(200, PROJECTS);
    await sentryStatsFromEnv({ SENTRY_STATS_TOKEN: TOKEN }, fetchImpl)!.projects();
    await sentryStatsFromEnv(
      { SENTRY_STATS_TOKEN: TOKEN, SENTRY_ORG: 'other-org' },
      fetchImpl,
    )!.projects();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/0/organizations/gogo-vn/projects/',
      '/api/0/organizations/other-org/projects/',
    ]);
  });
});
