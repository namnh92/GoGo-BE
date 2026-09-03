import { describe, expect, it } from 'vitest';
import {
  NEON_API_BASE,
  NeonApiClient,
  NeonApiError,
  foldConsumptionHistory,
  foldProject,
  neonApiFromEnv,
} from './neon-api.adapter';

/**
 * COST-BE-026 (#385) — the adapter against the documented bodies
 * (api-docs.neon.tech, fetched 2026-09-03). Nothing here talks to Neon.
 */

const PROJECT = 'gogo-dev-123456';

const HISTORY = {
  projects: [
    {
      project_id: PROJECT,
      periods: [
        {
          period_id: '9c1b2f4e-0000-4000-8000-000000000001',
          period_plan: 'launch',
          period_start: '2026-09-01T00:00:00Z',
          consumption: [
            {
              timeframe_start: '2026-09-02T00:00:00Z',
              timeframe_end: '2026-09-03T00:00:00Z',
              active_time_seconds: 7_200,
              compute_time_seconds: 1_800,
              written_data_bytes: 250_000_000,
              synthetic_storage_size_bytes: 320_000_000,
            },
            {
              timeframe_start: '2026-09-03T00:00:00Z',
              timeframe_end: '2026-09-03T06:00:00Z',
              active_time_seconds: 3_600,
              compute_time_seconds: 900,
              written_data_bytes: 40_000_000,
              synthetic_storage_size_bytes: 330_000_000,
              data_storage_bytes_hour: 1_980_000_000,
            },
          ],
        },
      ],
    },
  ],
  pagination: { cursor: '' },
};

const PROJECT_BODY = {
  project: {
    id: PROJECT,
    name: 'gogo-dev',
    consumption_period_start: '2026-09-01T00:00:00Z',
    consumption_period_end: '2026-10-01T00:00:00Z',
    active_time_seconds: 100_000,
    compute_time_seconds: 25_000,
    written_data_bytes: 1_200_000_000,
    data_storage_bytes_hour: 500_000_000_000,
    data_transfer_bytes: 3_500_000_000,
    synthetic_storage_size: 330_000_000,
  },
};

type Call = { url: string; init: RequestInit };

function fetchWith(
  responses: { status: number; body: unknown }[] | { status: number; body: unknown },
  calls: Call[] = [],
): { fetchImpl: typeof fetch; calls: Call[] } {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch) =>
  new NeonApiClient({ apiKey: 'napi_secret', projectId: PROJECT }, fetchImpl);

const WINDOW = { from: new Date('2026-09-02T00:00:00Z'), to: new Date('2026-09-03T06:00:00Z') };

describe('foldConsumptionHistory (pure)', () => {
  it('folds the documented body to UTC days, in order, with absent fields null', () => {
    const days = foldConsumptionHistory(HISTORY, PROJECT);
    expect(days.map((d) => d.day)).toEqual(['2026-09-02', '2026-09-03']);
    expect(days[0]).toEqual({
      day: '2026-09-02',
      timeframeStart: new Date('2026-09-02T00:00:00Z'),
      timeframeEnd: new Date('2026-09-03T00:00:00Z'),
      periodPlan: 'launch',
      activeTimeSeconds: 7_200,
      computeTimeSeconds: 1_800,
      writtenDataBytes: 250_000_000,
      syntheticStorageSizeBytes: 320_000_000,
      dataStorageBytesHour: null,
      dataTransferBytes: null,
    });
    expect(days[1]).toMatchObject({ dataStorageBytesHour: 1_980_000_000, computeTimeSeconds: 900 });
  });

  it('ignores other projects, sums a day split across two periods, keeps the storage maximum', () => {
    const body = {
      projects: [
        {
          project_id: 'someone-else',
          periods: [{ consumption: [HISTORY.projects[0]!.periods[0]!.consumption[0]] }],
        },
        {
          project_id: PROJECT,
          periods: [
            {
              period_plan: 'free',
              consumption: [
                {
                  timeframe_start: '2026-09-03T00:00:00Z',
                  timeframe_end: '2026-09-03T10:00:00Z',
                  compute_time_seconds: 100,
                  written_data_bytes: 10,
                  synthetic_storage_size_bytes: 500,
                },
              ],
            },
            {
              period_plan: 'launch',
              consumption: [
                {
                  timeframe_start: '2026-09-03T10:00:00Z',
                  timeframe_end: '2026-09-04T00:00:00Z',
                  compute_time_seconds: 50,
                  written_data_bytes: 5,
                  synthetic_storage_size_bytes: 400,
                },
                { timeframe_start: 'not a time', compute_time_seconds: 9_999 },
              ],
            },
          ],
        },
      ],
    };
    expect(foldConsumptionHistory(body, PROJECT)).toEqual([
      {
        day: '2026-09-03',
        timeframeStart: new Date('2026-09-03T00:00:00Z'),
        timeframeEnd: new Date('2026-09-04T00:00:00Z'),
        periodPlan: 'launch',
        activeTimeSeconds: null,
        computeTimeSeconds: 150,
        writtenDataBytes: 15,
        syntheticStorageSizeBytes: 500,
        dataStorageBytesHour: null,
        dataTransferBytes: null,
      },
    ]);
  });

  it('treats an absent list as empty and refuses a non-list or a non-object', () => {
    expect(foldConsumptionHistory({}, PROJECT)).toEqual([]);
    expect(foldConsumptionHistory({ projects: [{ project_id: PROJECT }] }, PROJECT)).toEqual([]);
    expect(() => foldConsumptionHistory({ projects: 'x' }, PROJECT)).toThrow(NeonApiError);
    expect(() => foldConsumptionHistory([], PROJECT)).toThrow(/not an object/);
    expect(() =>
      foldConsumptionHistory({ projects: [{ project_id: PROJECT, periods: {} }] }, PROJECT),
    ).toThrow(/periods/);
  });
});

describe('foldProject (pure)', () => {
  it('reads the period-to-date counters and the live storage size', () => {
    expect(foldProject(PROJECT_BODY)).toEqual({
      projectId: PROJECT,
      consumptionPeriodStart: new Date('2026-09-01T00:00:00Z'),
      consumptionPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      activeTimeSeconds: 100_000,
      computeTimeSeconds: 25_000,
      writtenDataBytes: 1_200_000_000,
      dataStorageBytesHour: 500_000_000_000,
      dataTransferBytes: 3_500_000_000,
      syntheticStorageSizeBytes: 330_000_000,
    });
  });

  it('reports a missing counter as null — never 0 — and refuses a body without a project id', () => {
    expect(foldProject({ project: { id: PROJECT } })).toMatchObject({
      computeTimeSeconds: null,
      dataTransferBytes: null,
      syntheticStorageSizeBytes: null,
      consumptionPeriodStart: null,
    });
    expect(() => foldProject({ project: {} })).toThrow(/without an id/);
    expect(() => foldProject({})).toThrow(/project is not an object/);
  });
});

describe('NeonApiClient', () => {
  it('GETs the history endpoint with a Bearer key, daily granularity and the project filter', async () => {
    const { fetchImpl, calls } = fetchWith({ status: 200, body: HISTORY });
    const days = await client(fetchImpl).consumptionHistory(WINDOW);
    expect(days.map((d) => d.day)).toEqual(['2026-09-02', '2026-09-03']);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${NEON_API_BASE}/consumption_history/projects`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-09-02T00:00:00.000Z',
      to: '2026-09-03T06:00:00.000Z',
      granularity: 'daily',
      project_ids: PROJECT,
      limit: '100',
    });
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer napi_secret' });
  });

  it('follows the pagination cursor until it stops', async () => {
    const page1 = { ...HISTORY, pagination: { cursor: 'next-1' } };
    const page2 = {
      projects: [
        {
          project_id: PROJECT,
          periods: [
            {
              consumption: [{ timeframe_start: '2026-09-04T00:00:00Z', compute_time_seconds: 10 }],
            },
          ],
        },
      ],
      pagination: {},
    };
    const { fetchImpl, calls } = fetchWith([
      { status: 200, body: page1 },
      { status: 200, body: page2 },
    ]);
    const days = await client(fetchImpl).consumptionHistory({
      ...WINDOW,
      to: new Date('2026-09-04T06:00:00Z'),
    });
    expect(days.map((d) => d.day)).toEqual(['2026-09-02', '2026-09-03', '2026-09-04']);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('next-1');
  });

  it('GETs the project and folds it', async () => {
    const { fetchImpl, calls } = fetchWith({ status: 200, body: PROJECT_BODY });
    const snapshot = await client(fetchImpl).project();
    expect(snapshot.computeTimeSeconds).toBe(25_000);
    expect(calls[0]!.url).toBe(`${NEON_API_BASE}/projects/${PROJECT}`);
  });

  it('passes the abort signal through and lets an abort surface as itself', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    await expect(client(fetchImpl).project({ signal: controller.signal })).rejects.toThrow(
      'aborted',
    );
  });

  it('maps 403 on history to PLAN_NOT_SUPPORTED but on the project to AUTH_FAILED', async () => {
    const forbidden = fetchWith({ status: 403, body: { message: 'not available' } }).fetchImpl;
    await expect(client(forbidden).consumptionHistory(WINDOW)).rejects.toMatchObject({
      code: 'PLAN_NOT_SUPPORTED',
    });
    await expect(client(forbidden).project()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('maps 401 to AUTH_FAILED, 404 to NOT_FOUND, 406 to RANGE_REJECTED, 429 to RATE_LIMITED, others to HTTP_n', async () => {
    const codes: [number, string][] = [
      [401, 'AUTH_FAILED'],
      [404, 'NOT_FOUND'],
      [406, 'RANGE_REJECTED'],
      [429, 'RATE_LIMITED'],
      [500, 'HTTP_500'],
    ];
    for (const [status, code] of codes) {
      const { fetchImpl } = fetchWith({ status, body: { message: 'x' } });
      await expect(
        client(fetchImpl).consumptionHistory(WINDOW),
        String(status),
      ).rejects.toMatchObject({ code });
    }
  });

  it('refuses a body that is not JSON, and an unreachable host', async () => {
    const { fetchImpl } = fetchWith({ status: 200, body: 'not json' });
    await expect(client(fetchImpl).project()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(client(down).project()).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      message: 'neon api unreachable',
    });
  });

  it('refuses a bad project id or key, and an empty window, before any request is made', async () => {
    expect(() => new NeonApiClient({ apiKey: 'k', projectId: 'Not Valid!' })).toThrow(
      /bad project id/,
    );
    expect(() => new NeonApiClient({ apiKey: 'has space', projectId: PROJECT })).toThrow(
      /bad api key/,
    );
    expect(() => new NeonApiClient({ apiKey: '', projectId: PROJECT })).toThrow(NeonApiError);
    const { fetchImpl, calls } = fetchWith({ status: 200, body: HISTORY });
    await expect(
      client(fetchImpl).consumptionHistory({ from: WINDOW.to, to: WINDOW.from }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
  });
});

describe('neonApiFromEnv (INF-060 #114, INF-008 #8)', () => {
  it('returns null when either value is absent or blank — the caller then registers nothing', () => {
    expect(neonApiFromEnv({})).toBeNull();
    expect(neonApiFromEnv({ NEON_API_KEY: 'k' })).toBeNull();
    expect(neonApiFromEnv({ NEON_PROJECT_ID: PROJECT })).toBeNull();
    expect(neonApiFromEnv({ NEON_API_KEY: '  ', NEON_PROJECT_ID: PROJECT })).toBeNull();
    // The data-plane URL is not a substitute.
    expect(neonApiFromEnv({ DATABASE_URL: 'postgres://x', NEON_API_KEY: 'k' })).toBeNull();
  });

  it('builds a client from the two values', () => {
    expect(neonApiFromEnv({ NEON_API_KEY: ' k ', NEON_PROJECT_ID: ` ${PROJECT} ` })).toBeInstanceOf(
      NeonApiClient,
    );
  });
});
