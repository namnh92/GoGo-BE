import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VietmapClient,
  parseRetryAfterMs,
  redactVietmapUrl,
  VIETMAP_MAX_RETRY_AFTER_MS,
} from './vietmap.client';
import { GeoProviderError } from './ports';
import { resetBreakers } from './resilience';

const KEY = 'vm-example-not-a-real-credential-0000';

function client(overrides: Partial<ConstructorParameters<typeof VietmapClient>[0]> = {}) {
  return new VietmapClient({ apiKey: KEY, timeoutMs: 200, ...overrides });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{"message":"nope"}', { status, headers });
}

const NO_THROW = Symbol('no-throw');

/** The rejection, typed — `await expect(...).rejects` cannot hand one back. */
async function failure(p: Promise<unknown>): Promise<GeoProviderError> {
  const outcome = await p.then(
    () => NO_THROW,
    (e: unknown) => e,
  );
  if (outcome === NO_THROW) throw new Error('expected the call to reject');
  return outcome as GeoProviderError;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetBreakers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GEO-002 — credential never leaves the client (spec §20, §26)', () => {
  it('redacts apikey out of a URL', () => {
    const url = `https://maps.vietmap.vn/api/search/v4?apikey=${KEY}&text=pho`;
    const redacted = redactVietmapUrl(url);

    expect(redacted).not.toContain(KEY);
    expect(redacted).toContain('apikey=REDACTED');
    expect(redacted).toContain('text=pho');
  });

  it('refuses to guess at a string it cannot parse as a URL', () => {
    // Returning the input unchanged would be the dangerous default: a mangled
    // URL still carries a key.
    expect(redactVietmapUrl('apikey=' + KEY)).toBe('[unparseable url]');
  });

  it('keeps the key out of the error thrown on a failed request', async () => {
    fetchMock.mockResolvedValue(errorResponse(401));

    const err = await failure(client().get('search', '/search/v4', { text: 'pho' }));

    expect(err).toBeInstanceOf(GeoProviderError);
    expect(err.code).toBe('AUTH_FAILED');
    expect(JSON.stringify({ message: err.message, cause: err.cause })).not.toContain(KEY);
  });
});

describe('GEO-002 — retry table (spec §17)', () => {
  it.each([400, 401, 403, 404])('does not retry %i', async (status) => {
    fetchMock.mockResolvedValue(errorResponse(status));

    await expect(client().get('search', '/search/v4', {})).rejects.toBeInstanceOf(GeoProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 503])('retries %i exactly once more', async (status) => {
    fetchMock.mockResolvedValue(errorResponse(status));

    await expect(client().get('search', '/search/v4', {})).rejects.toBeInstanceOf(GeoProviderError);
    // Two attempts total, per VIETMAP_MAX_ATTEMPTS — not two retries.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the second attempt when the first fails transiently', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse({ data: 'ok' }));

    await expect(client().get('search', '/search/v4', {})).resolves.toEqual({ data: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a body it could not parse', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    const err = await failure(client().get('search', '/search/v4', {}));

    expect(err.code).toBe('BAD_UPSTREAM_RESPONSE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GEO-002 — Retry-After (spec §17)', () => {
  it('reads seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2_000);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    expect(parseRetryAfterMs('Tue, 01 Sep 2026 00:00:03 GMT', now)).toBe(3_000);
  });

  it('treats a date already past as no wait at all', () => {
    const now = Date.parse('2026-09-01T00:00:10Z');
    expect(parseRetryAfterMs('Tue, 01 Sep 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('ignores a value it cannot read', () => {
    // A provider that cannot say when to come back has not said when.
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('waits what the provider asked, not the backoff curve', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '2' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const pending = client().get('search', '/search/v4', {});
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps an absurd Retry-After instead of parking the request', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '3600' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const pending = client().get('search', '/search/v4', {});
      await vi.advanceTimersByTimeAsync(VIETMAP_MAX_RETRY_AFTER_MS + 10);

      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GEO-002 — cancellation and timeout', () => {
  it('classifies the per-attempt timeout as TIMEOUT', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );

    const err = await failure(client({ timeoutMs: 20 }).get('search', '/search/v4', {}));

    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
  });

  it('gives the caller back its own cancellation, and stops', async () => {
    // A cancelled request is not a provider fault. Retrying it would call an
    // API nobody is waiting for; classifying it as TIMEOUT would inflate the
    // provider's error rate with our own cancellations.
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) fail();
          init.signal?.addEventListener('abort', fail);
        }),
    );

    const pending = client({ timeoutMs: 10_000 }).get(
      'autocomplete',
      '/autocomplete/v4',
      {},
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.not.toBeInstanceOf(GeoProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GEO-002 — circuit breaker', () => {
  it('fails fast without another upstream call once open', async () => {
    fetchMock.mockResolvedValue(errorResponse(500));
    const c = client({ breakerThreshold: 2, breakerCooldownMs: 60_000 });

    await expect(c.get('matrix', '/matrix/v4', {})).rejects.toBeInstanceOf(GeoProviderError);
    const callsBefore = fetchMock.mock.calls.length;

    const err = await failure(c.get('matrix', '/matrix/v4', {}));

    expect(err.code).toBe('UPSTREAM_UNAVAILABLE');
    // The breaker refusing a call is not a reason to try again behind it.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('GEO-002 — request shape', () => {
  it('drops empty params rather than sending blanks', () => {
    const url = client().buildUrl('/search/v4', { text: 'pho', focus: undefined, layers: '' });

    expect(url).toContain('text=pho');
    expect(url).not.toContain('focus=');
    expect(url).not.toContain('layers=');
  });
});
