import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrometheusQueryAdapter,
  promApiBase,
  resolveMetricsQueryConfig,
} from './prometheus-query.adapter';
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
  });

  it('accepts a self-hosted Prometheus endpoint', () => {
    expect(promApiBase('http://host.docker.internal:9090/api/v1/write')).toBe(
      'http://host.docker.internal:9090',
    );
    expect(promApiBase('http://prometheus:9090')).toBe('http://prometheus:9090');
    expect(promApiBase('http://192.168.68.168:9090/api/v1/write')).toBe(
      'http://192.168.68.168:9090',
    );
  });

  it('reads the URL shape, never the hostname', () => {
    // ADR-0007 / BE-SRE-P8: the previous version appended `/api/prom` to any
    // host that did not contain `.grafana.net`, which is a vendor's domain
    // deciding behaviour in shared code. The suffix is the whole signal now,
    // so the same path resolves the same way whoever is hosting it.
    expect(promApiBase('https://metrics.example.test/api/prom/push')).toBe(
      'https://metrics.example.test/api/prom',
    );
    expect(promApiBase('https://x.grafana.net/api/v1/write')).toBe('https://x.grafana.net');
    // A bare host is already a query root. It is no longer guessed at: an
    // operator who means Mimir's `/api/prom` writes it.
    expect(promApiBase('https://x.grafana.net')).toBe('https://x.grafana.net');
  });
});

describe('resolveMetricsQueryConfig', () => {
  const CLOUD = {
    GRAFANA_PROM_URL: CONFIG.url,
    GRAFANA_PROM_USER: CONFIG.username,
    GRAFANA_READ_TOKEN: CONFIG.token,
  };

  it('reads where the collector writes, so the two cannot drift apart', () => {
    // ADR-0007 §E7: this is the whole point. Setting the write endpoint moves
    // the read path with it, in one action.
    expect(
      resolveMetricsQueryConfig({ PROMETHEUS_REMOTE_WRITE_URL: 'http://192.168.68.168:9090' }),
    ).toEqual({ url: 'http://192.168.68.168:9090', username: undefined, token: undefined });
  });

  it('will not silently keep reading Grafana Cloud once the collector has moved', () => {
    // The forbidden state: Alloy writing to the LAN Prometheus while the API
    // still answers from Cloud. The screen would report healthy and show
    // nothing — `unknown != zero`, quietly violated.
    const resolved = resolveMetricsQueryConfig({
      ...CLOUD,
      PROMETHEUS_REMOTE_WRITE_URL: 'http://192.168.68.168:9090/api/v1/write',
    });
    expect(resolved?.url).toBe('http://192.168.68.168:9090/api/v1/write');
    expect(resolved?.token).toBeUndefined();
  });

  it('keeps the legacy Cloud path working for the rollback window', () => {
    expect(resolveMetricsQueryConfig(CLOUD)).toEqual({
      url: CONFIG.url,
      username: CONFIG.username,
      token: CONFIG.token,
    });
  });

  it('refuses a half-configured Cloud path rather than binding a certain 401', () => {
    expect(resolveMetricsQueryConfig({ GRAFANA_PROM_URL: CONFIG.url })).toBeNull();
    expect(
      resolveMetricsQueryConfig({ GRAFANA_PROM_URL: CONFIG.url, GRAFANA_PROM_USER: 'u' }),
    ).toBeNull();
  });

  it("reads with the collector's credential, since it is the same store", () => {
    // Prometheus basic auth admits or refuses a user; it cannot scope a reader
    // away from writing. A second credential would be another name for the
    // same access, so the read path presents the one the store has.
    expect(
      resolveMetricsQueryConfig({
        PROMETHEUS_REMOTE_WRITE_URL: 'http://192.168.68.168:9090/api/v1/write',
        PROMETHEUS_BASIC_AUTH_USER: 'gogo-obs',
        PROMETHEUS_BASIC_AUTH_PASSWORD: 'not-a-real-value',
      }),
    ).toEqual({
      url: 'http://192.168.68.168:9090/api/v1/write',
      username: 'gogo-obs',
      token: 'not-a-real-value',
    });
  });

  it('lets METRICS_QUERY_* override the collector credential', () => {
    // For a deployment that *can* scope a reader apart — a proxy in front, a
    // different store. The override is explicit, never inferred.
    expect(
      resolveMetricsQueryConfig({
        PROMETHEUS_REMOTE_WRITE_URL: 'http://192.168.68.168:9090',
        PROMETHEUS_BASIC_AUTH_USER: 'writer',
        PROMETHEUS_BASIC_AUTH_PASSWORD: 'writer-secret',
        METRICS_QUERY_USERNAME: 'reader',
        METRICS_QUERY_TOKEN: 'reader-secret',
      })?.username,
    ).toBe('reader');
  });

  it('lets an explicit query URL override both, credentials optional', () => {
    expect(
      resolveMetricsQueryConfig({
        ...CLOUD,
        PROMETHEUS_REMOTE_WRITE_URL: 'http://192.168.68.168:9090',
        METRICS_QUERY_URL: 'http://replica:9090',
        METRICS_QUERY_USERNAME: 'reader',
        METRICS_QUERY_TOKEN: 'secret',
      }),
    ).toEqual({ url: 'http://replica:9090', username: 'reader', token: 'secret' });
  });

  it('binds nothing when nothing is configured', () => {
    // Never a fake. A fake answers a dashboard with invented traffic.
    expect(resolveMetricsQueryConfig({})).toBeNull();
    expect(resolveMetricsQueryConfig({ GRAFANA_PROM_URL: '', METRICS_QUERY_URL: '' })).toBeNull();
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

  it('sends no authorization header at all when the store has no credentials', async () => {
    // A LAN Prometheus restricted to one source address has no basic auth.
    // Sending `Basic OjA=` — an empty user and an empty password — is not
    // "no attempt"; it is a malformed one, and a server is entitled to answer
    // 401 to it. The header is absent or it is real.
    const capture: { last?: RequestInit & { url?: string } } = {};
    respond(200, { status: 'success', data: { result: [] } }, capture);
    await new PrometheusQueryAdapter({ url: 'http://192.168.68.168:9090' }).query('up');
    const headers = capture.last?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(capture.last?.url).toBe('http://192.168.68.168:9090/api/v1/query');
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
