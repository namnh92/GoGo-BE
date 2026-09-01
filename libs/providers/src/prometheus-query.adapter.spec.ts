import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrometheusQueryAdapter, promApiBase } from './prometheus-query.adapter';
import { MetricsQueryError } from './ports';
import { resetBreakers } from './resilience';

const CONFIG = {
  url: 'https://prometheus-prod-37-prod-ap-southeast-1.grafana.net/api/prom/push',
  username: '3553140',
  token: 'glc_ExampleReadTokenNotARealCredential0000',
};

function respond(
  status: number,
  body: unknown,
  capture?: { last?: RequestInit & { url?: string } },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (capture) capture.last = { ...init, url };
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }),
  );
}

describe('promApiBase', () => {
  it('derives the query API from the write endpoint stored in SSM', () => {
    // One parameter, so two cannot disagree.
    expect(promApiBase(CONFIG.url)).toBe(
      'https://prometheus-prod-37-prod-ap-southeast-1.grafana.net/api/prom',
    );
  });

  it('accepts the query URL too, so a pasted-wrong value still works', () => {
    expect(promApiBase('https://x.grafana.net/api/prom')).toBe('https://x.grafana.net/api/prom');
    expect(promApiBase('https://x.grafana.net/api/prom/')).toBe('https://x.grafana.net/api/prom');
    expect(promApiBase('https://x.grafana.net')).toBe('https://x.grafana.net/api/prom');
  });
});

describe('PrometheusQueryAdapter', () => {
  beforeEach(() => resetBreakers());
  afterEach(() => vi.unstubAllGlobals());

  it('reads an instant vector', async () => {
    respond(200, {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: { method: 'google.searchText' }, value: [1_756_000_000, '4'] }],
      },
    });
    const out = await new PrometheusQueryAdapter(CONFIG).query('up');
    expect(out).toEqual([{ labels: { method: 'google.searchText' }, value: 4 }]);
  });

  it('sends basic auth and the query in the body, not the URL', async () => {
    const capture: { last?: RequestInit & { url?: string } } = {};
    respond(200, { status: 'success', data: { result: [] } }, capture);
    await new PrometheusQueryAdapter(CONFIG).query('sum(up)');

    const headers = capture.last?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from(`${CONFIG.username}:${CONFIG.token}`).toString('base64')}`;
    expect(headers.authorization).toBe(expected);
    // A 30-day range query is long enough to meet a proxy's URL limit, and a
    // query in a URL is a query in an access log.
    expect(capture.last?.method).toBe('POST');
    expect(capture.last?.url).not.toContain('sum(up)');
    expect(String(capture.last?.body)).toContain('query=sum%28up%29');
  });

  it('drops a NaN point rather than charting a gap as zero', async () => {
    respond(200, {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [
          {
            metric: {},
            values: [
              [1_756_000_000, '1.5'],
              [1_756_000_060, 'NaN'],
              [1_756_000_120, '2.5'],
            ],
          },
        ],
      },
    });
    const out = await new PrometheusQueryAdapter(CONFIG).queryRange(
      'sum(rate(x[1m]))',
      new Date(1_756_000_000_000),
      new Date(1_756_000_120_000),
      60,
    );
    // Two points, not three with a zero in the middle — a gap is not a dip.
    expect(out[0]?.points.map((p) => p.v)).toEqual([1.5, 2.5]);
  });

  it('classifies a refused credential', async () => {
    respond(401, { error: 'authentication error: invalid scope requested' });
    await expect(new PrometheusQueryAdapter(CONFIG).query('up')).rejects.toMatchObject({
      name: 'MetricsQueryError',
      reason: 'unauthorized',
    });
  });

  it('classifies a rejected query', async () => {
    respond(400, { error: 'parse error' });
    await expect(new PrometheusQueryAdapter(CONFIG).query('up{')).rejects.toMatchObject({
      reason: 'bad_request',
    });
  });

  it('treats a 200 carrying status:error as unusable, not as empty', async () => {
    respond(200, { status: 'error', errorType: 'execution', error: 'query timed out' });
    // Reading this as success returns an empty dashboard that looks like "no
    // traffic", which is the worst available answer.
    //
    // `malformed` is transient — a query that timed out may not next time — so
    // unlike a refused credential it is worth backing off from, and
    // `withResilience` wraps it for the breaker. The classification survives
    // underneath, which is what the CMS layer reads.
    const err = await new PrometheusQueryAdapter(CONFIG).query('up').catch((e: unknown) => e);
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(MetricsQueryError);
    expect((err as { cause?: { reason?: string } }).cause?.reason).toBe('malformed');
  });

  it('treats an unparseable body as unusable', async () => {
    respond(200, '<html>gateway</html>');
    const err = await new PrometheusQueryAdapter(CONFIG).query('up').catch((e: unknown) => e);
    expect((err as { cause?: { reason?: string } }).cause?.reason).toBe('malformed');
  });

  it('does not back off from a permanent answer', async () => {
    // A refused credential and an unparseable query say the same thing on
    // every attempt (#273/#314's shape). Retrying spends time to be told the
    // same thing, and counting them would cycle the breaker — which flips the
    // operator-facing detail between two sentences while nothing changes.
    for (const [status, reason] of [
      [401, 'unauthorized'],
      [400, 'bad_request'],
    ] as const) {
      resetBreakers();
      respond(status, { error: 'nope' });
      await expect(new PrometheusQueryAdapter(CONFIG).query('up')).rejects.toMatchObject({
        name: 'MetricsQueryError',
        reason,
      });
    }
  });

  it('never carries the store its own error text or our token', async () => {
    respond(401, {
      error: 'token glc_ExampleReadTokenNotARealCredential0000 rejected for query sum(up)',
    });
    const err = await new PrometheusQueryAdapter(CONFIG).query('up').catch((e: unknown) => e);
    const rendered = `${(err as Error).message} ${JSON.stringify(err)}`;
    expect(rendered).not.toContain(CONFIG.token);
    expect(rendered).not.toContain('sum(up)');
    expect((err as Error).message).toBe('metrics query failed (unauthorized)');
  });

  it('does not retry — a slow dashboard must not become a retry storm', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    await new PrometheusQueryAdapter(CONFIG).query('up').catch(() => undefined);
    // One attempt. Ten operators refreshing against a struggling store is how
    // a slow monitoring backend becomes a down one.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
