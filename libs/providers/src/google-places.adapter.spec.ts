import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePlacesAdapter } from './google-places.adapter';
import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
} from './ports';
import { resetBreakers } from './resilience';

const API_KEY = 'AIzaSyExampleNotARealCredential0000000000';

/**
 * #273 — the same body shape INF-050 captured from DEV for Sheets, with the
 * service swapped. Kept verbatim rather than hand-written: the defect was that
 * nothing ever looked at this body, so a paraphrase would test the paraphrase.
 */
const SERVICE_DISABLED_BODY = {
  error: {
    code: 403,
    message: 'Places API (New) has not been used in project 186055730568 before or it is disabled.',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'SERVICE_DISABLED',
        domain: 'googleapis.com',
        metadata: {
          service: 'places.googleapis.com',
          consumer: 'projects/186055730568',
          activationUrl:
            'https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=186055730568',
        },
      },
    ],
  },
};

/** A key restricted to the wrong API — the failure #271's split made possible. */
const KEY_SERVICE_BLOCKED_BODY = {
  error: {
    code: 403,
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_SERVICE_BLOCKED',
      },
    ],
  },
};

/**
 * #314 — captured verbatim from the live Places API for
 * `GET /v1/places/ChIJ0000000000000000000`. Note what is *not* here: no
 * `details[]`, no `ErrorInfo`, no `reason`. Reading only the reason left this
 * as `unknown`, which meant retryable, which meant an outage.
 */
const INVALID_PLACE_ID_BODY = {
  error: {
    code: 400,
    message: 'The provided Place ID: ChIJ0000000000000000000 is not valid.\n',
    status: 'INVALID_ARGUMENT',
  },
};

function respond(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('#314 — a rejected request is not an outage', () => {
  beforeEach(() => {
    resetBreakers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies a place id Google calls invalid as a rejected request', async () => {
    respond(400, INVALID_PLACE_ID_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJ0000000000000000000', 'quality')).rejects.toBeInstanceOf(
      ProviderInvalidRequestError,
    );
    await expect(adapter.details('ChIJ0000000000000000000', 'quality')).rejects.toMatchObject({
      canonicalStatus: 'INVALID_ARGUMENT',
    });
  });

  it('does not retry it — one call, not three', async () => {
    const fetchMock = respond(400, INVALID_PLACE_ID_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJbad', 'quality')).rejects.toBeInstanceOf(
      ProviderInvalidRequestError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never becomes ProviderUnavailableError, however many bad ids arrive', async () => {
    respond(400, INVALID_PLACE_ID_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    // Enough to trip the breaker if these counted as failures — which is the
    // second half of the bug: pasted junk would break resolution for everyone.
    for (let i = 0; i < 8; i += 1) {
      await expect(adapter.details(`ChIJbad${i}`, 'quality')).rejects.toBeInstanceOf(
        ProviderInvalidRequestError,
      );
    }
    await expect(adapter.details('ChIJbad', 'quality')).rejects.not.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('reads 404 NOT_FOUND as a rejected request too, and says which', async () => {
    respond(404, {
      error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' },
    });
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJretired', 'quality')).rejects.toMatchObject({
      canonicalStatus: 'NOT_FOUND',
    });
  });

  it('does not infer from HTTP 400 alone when Google gives no canonical status', async () => {
    const fetchMock = respond(400, { error: { code: 400, message: 'something else' } });
    const adapter = new GooglePlacesAdapter(API_KEY);

    // No status, no verdict: it stays a transient failure and is retried, which
    // is the conservative reading. Silently swallowing every 400 as "bad input"
    // is the over-correction this issue must not make.
    await expect(adapter.details('ChIJexample', 'quality')).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('an auth failure still outranks a canonical status in the same body', async () => {
    respond(403, {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' },
        ],
      },
    });
    const adapter = new GooglePlacesAdapter(API_KEY);

    // Our console is what needs fixing, not the caller's argument.
    await expect(adapter.details('ChIJexample', 'quality')).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
  });

  it('counts a rejection on its own series, never as a provider failure', async () => {
    respond(400, INVALID_PLACE_ID_BODY);
    const seen: { name: string; labels: Record<string, unknown> }[] = [];
    const adapter = new GooglePlacesAdapter(API_KEY, {
      increment: (name, labels) => seen.push({ name, labels: labels ?? {} }),
      observe: () => undefined,
    });

    await expect(adapter.details('ChIJbad', 'quality')).rejects.toBeInstanceOf(
      ProviderInvalidRequestError,
    );

    const names = seen.map((m) => m.name);
    expect(names).toContain('places_provider_rejected_total');
    // The assertion that matters: an alert on this series means Google is not
    // serving us, and a user's typo must not make that statement.
    expect(names).not.toContain('places_provider_failures_total');
    const rejected = seen.find((m) => m.name === 'places_provider_rejected_total');
    expect(rejected?.labels).toMatchObject({ canonical_status: 'INVALID_ARGUMENT' });
    expect(JSON.stringify(seen)).not.toContain(API_KEY);
  });
});

describe('#273 — GooglePlacesAdapter failure classification', () => {
  beforeEach(() => {
    resetBreakers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a disabled Places API instead of answering "no such place"', async () => {
    respond(403, SERVICE_DISABLED_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    // The whole defect in one assertion: this used to resolve to null, which
    // the resolver reported as NOT_FOUND and Mobile printed as "Không tìm thấy
    // địa điểm trên Google Maps" about a place that exists.
    await expect(adapter.details('ChIJexample', 'quality')).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
    await expect(adapter.details('ChIJexample', 'quality')).rejects.toMatchObject({
      faultCode: 'AUTH_FAILED',
      providerReason: 'SERVICE_DISABLED',
    });
  });

  it('reads a key restricted to another API the same way', async () => {
    respond(403, KEY_SERVICE_BLOCKED_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(
      adapter.resolveUrl('https://www.google.com/maps/place/Lacaph+Coffee'),
    ).rejects.toMatchObject({
      faultCode: 'AUTH_FAILED',
      providerReason: 'API_KEY_SERVICE_BLOCKED',
    });
  });

  it('treats a bare 403 with no reason as a credential fault, not a missing place', async () => {
    respond(403, { error: { code: 403, status: 'PERMISSION_DENIED' } });
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJexample', 'quality')).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
  });

  it('does not retry a configuration fault', async () => {
    const fetchMock = respond(403, SERVICE_DISABLED_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJexample', 'quality')).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
    // One call, not three. Retrying an API nobody enabled burns the breaker
    // and produces the "opens and closes forever" symptom from the issue.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still reports quota exhaustion as quota', async () => {
    respond(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJexample', 'quality')).rejects.toBeInstanceOf(
      ProviderQuotaExceededError,
    );
  });

  it('still reports a 5xx as a transient outage', async () => {
    respond(503, { error: { code: 503 } });
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJexample', 'quality')).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('a successful search with no match is still a genuine no-result', async () => {
    respond(200, { places: [] });
    const adapter = new GooglePlacesAdapter(API_KEY);

    // The contract this change must not break: Google answered, and the answer
    // was "nothing here". That is a fact about the world, and it stays null.
    await expect(
      adapter.resolveUrl('https://www.google.com/maps/place/Nowhere'),
    ).resolves.toBeNull();
  });

  /**
   * COST-BE-006 (#339) — `resolveUrl` had a second, unguarded short-link
   * expander: `fetch(url, { redirect: 'follow' })`, which lets the platform
   * chase every hop with no hostname allowlist and no private-address block.
   * `POST /v1/places/imports` feeds it a URL typed by a user.
   */
  describe('resolveUrl is SSRF-guarded (#339)', () => {
    it('refuses a host that is not Google, without a request', async () => {
      const fetchMock = respond(200, { places: [{ id: 'ChIJevil' }] });
      const adapter = new GooglePlacesAdapter(API_KEY);

      // The old hand-rolled regex matched `/maps/place/<name>` on any host, so
      // an attacker's string became a billed Text Search.
      await expect(adapter.resolveUrl('https://evil.test/maps/place/Anything')).resolves.toBeNull();
      expect(fetchMock, 'a link GoGo will not follow costs nothing').not.toHaveBeenCalled();
    });

    it('refuses a private address outright', async () => {
      const fetchMock = respond(200, {});
      const adapter = new GooglePlacesAdapter(API_KEY);

      for (const url of [
        'http://127.0.0.1/maps/place/X',
        'http://169.254.169.254/maps/place/X',
        'http://[::1]/maps/place/X',
        'http://metadata.internal/maps/place/X',
      ]) {
        await expect(adapter.resolveUrl(url)).resolves.toBeNull();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('walks a short link one hop at a time and re-checks every hop', async () => {
      const seen: { url: string; redirect: string | undefined }[] = [];
      const fetchMock = vi.fn(async (url: string, init?: Record<string, unknown>) => {
        seen.push({ url, redirect: init?.['redirect'] as string | undefined });
        // Hop 1 redirects off Google entirely — the pivot an open redirect
        // gives an attacker, and the reason each hop is re-validated.
        return {
          ok: true,
          status: 301,
          url,
          headers: { get: (h: string) => (h === 'location' ? 'https://evil.test/x' : null) },
          json: async () => ({}),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new GooglePlacesAdapter(API_KEY);

      await expect(adapter.resolveUrl('https://maps.app.goo.gl/abc123')).resolves.toBeNull();
      // `manual`, not `follow`: the platform never gets to make the second
      // request on its own.
      expect(seen[0]?.redirect).toBe('manual');
      // And the off-Google hop is never requested.
      expect(seen.some((h) => h.url.includes('evil.test'))).toBe(false);
    });

    it('still counts the expansion hop, under the same label as the resolver', async () => {
      const increments: Record<string, unknown>[] = [];
      const fetchMock = vi.fn(async (url: string) => ({
        ok: true,
        status: 301,
        url,
        headers: {
          get: (h: string) =>
            h === 'location' ? 'https://www.google.com/maps?place_id=ChIJshort' : null,
        },
        json: async () => ({}),
      }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new GooglePlacesAdapter(API_KEY, {
        increment: (name, labels) => void increments.push({ name, ...labels }),
        observe: () => undefined,
      });

      await expect(adapter.resolveUrl('https://maps.app.goo.gl/abc123')).resolves.toBe('ChIJshort');
      expect(increments).toContainEqual(
        expect.objectContaining({
          name: 'places_provider_requests_total',
          method: 'google.expand',
        }),
      );
    });

    it('takes a place_id from the URL without any request at all', async () => {
      const fetchMock = respond(200, {});
      const adapter = new GooglePlacesAdapter(API_KEY);

      await expect(
        adapter.resolveUrl('https://www.google.com/maps?place_id=ChIJdirect'),
      ).resolves.toBe('ChIJdirect');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('never puts the API key in the error it throws', async () => {
    respond(403, SERVICE_DISABLED_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    const err = (await adapter.details('ChIJexample', 'quality').catch((e: unknown) => e)) as Error;
    // Own enumerable fields plus the message, which is what a log serializer
    // and an error reporter each pick up.
    const serialized = JSON.stringify({ ...err, message: err.message });
    expect(serialized).not.toContain(API_KEY);
    expect(err.stack ?? '').not.toContain(API_KEY);
  });
});

/**
 * #313 — the counter must stay bounded and the duration must land in the
 * histogram, measured through the adapter rather than the registry alone.
 */
describe('#313 — adapter emits bounded labels and a latency observation', () => {
  beforeEach(() => {
    resetBreakers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function recorder() {
    const counters: { name: string; labels: Record<string, unknown>; by?: number | undefined }[] =
      [];
    const observations: { name: string; value: number; labels: Record<string, unknown> }[] = [];
    return {
      counters,
      observations,
      metrics: {
        increment: (
          name: string,
          labels?: Record<string, string | number | undefined>,
          by?: number,
        ) => void counters.push({ name, labels: labels ?? {}, by }),
        observe: (
          name: string,
          value: number,
          labels?: Record<string, string | number | undefined>,
        ) => void observations.push({ name, value, labels: labels ?? {} }),
      },
    };
  }

  it('never puts a duration in a label', async () => {
    respond(200, {
      id: 'ChIJ1',
      displayName: { text: 'X' },
      location: { latitude: 1, longitude: 2 },
    });
    const rec = recorder();
    const adapter = new GooglePlacesAdapter(API_KEY, rec.metrics);

    await adapter.details('ChIJ1', 'quality');

    const requests = rec.counters.find((c) => c.name === 'places_provider_requests_total');
    expect(requests?.labels).toEqual({ method: 'google.details.quality', status: 200 });
    expect(Object.keys(requests?.labels ?? {})).not.toContain('duration_ms');
  });

  it('observes the duration on the provider histogram instead', async () => {
    respond(200, {
      id: 'ChIJ1',
      displayName: { text: 'X' },
      location: { latitude: 1, longitude: 2 },
    });
    const rec = recorder();
    const adapter = new GooglePlacesAdapter(API_KEY, rec.metrics);

    await adapter.details('ChIJ1', 'quality');

    const timing = rec.observations.find(
      (o) => o.name === 'place_provider_request_duration_seconds',
    );
    expect(timing).toBeDefined();
    // #320: seconds. A fake fetch answers in well under a second, so an
    // observation at or above 1 means the adapter is still handing over
    // milliseconds.
    expect(timing?.value).toBeGreaterThanOrEqual(0);
    expect(timing?.value).toBeLessThan(1);
    expect(timing?.labels).toEqual({ method: 'google.details.quality', status: 200 });
  });

  it('repeated calls reuse one label set, whatever they cost in time', async () => {
    respond(200, {
      id: 'ChIJ1',
      displayName: { text: 'X' },
      location: { latitude: 1, longitude: 2 },
    });
    const rec = recorder();
    const adapter = new GooglePlacesAdapter(API_KEY, rec.metrics);

    for (let i = 0; i < 5; i += 1) await adapter.details('ChIJ1', 'quality');

    const shapes = new Set(
      rec.counters
        .filter((c) => c.name === 'places_provider_requests_total')
        .map((c) => JSON.stringify(c.labels)),
    );
    expect(shapes.size).toBe(1);
  });

  it('every label value emitted is a finite enum, never free text', async () => {
    respond(200, {
      id: 'ChIJ1',
      displayName: { text: 'X' },
      location: { latitude: 1, longitude: 2 },
    });
    const rec = recorder();
    const adapter = new GooglePlacesAdapter(API_KEY, rec.metrics);

    await adapter.details('ChIJ1', 'quality');

    const allowed = new Set(['method', 'status', 'sku', 'reason', 'canonical_status']);
    for (const c of [...rec.counters, ...rec.observations]) {
      for (const key of Object.keys(c.labels)) expect(allowed).toContain(key);
    }
    // The place id is the obvious unbounded value within reach here.
    expect(JSON.stringify([...rec.counters, ...rec.observations])).not.toContain('ChIJ1');
    expect(JSON.stringify([...rec.counters, ...rec.observations])).not.toContain(API_KEY);
  });
});

describe('#334 — the id that came back is not always the id we asked for', () => {
  beforeEach(() => {
    resetBreakers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the requested id when Google answers about a successor', async () => {
    respond(200, {
      id: 'ChIJnew',
      displayName: { text: 'Quán Đã Chuyển' },
      location: { latitude: 10.78, longitude: 106.7 },
    });
    const adapter = new GooglePlacesAdapter(API_KEY);

    const details = await adapter.details('ChIJold', 'quality');

    // Both ids, so the caller can see the change rather than infer it. What it
    // must not do is relink on its own — that is PR7's review path.
    expect(details?.providerPlaceId).toBe('ChIJnew');
    expect(details?.requestedProviderPlaceId).toBe('ChIJold');
  });

  it('says nothing when the two agree, which is the ordinary case', async () => {
    respond(200, {
      id: 'ChIJsame',
      displayName: { text: 'Quán Bình Thường' },
      location: { latitude: 10.78, longitude: 106.7 },
    });
    const adapter = new GooglePlacesAdapter(API_KEY);

    const details = await adapter.details('ChIJsame', 'quality');

    expect(details?.providerPlaceId).toBe('ChIJsame');
    expect(details?.requestedProviderPlaceId).toBeUndefined();
  });
});

/**
 * GoGo-BE#505 — what the adapter now asks Google for.
 *
 * Both request options were verified against the live Places API on
 * 2026-09-09 before being asserted here:
 *
 * - `GET /v1/places/ChIJxwnWy6usNTERS_TY4hfsH2s` answers `displayName.text`
 *   "Hanoi Museum" with no locale and "Bảo tàng Hà Nội" with
 *   `?languageCode=vi&regionCode=VN`. A share link made on a Vietnamese phone
 *   carries the Vietnamese name, so without this the query and the candidate
 *   had no token in common.
 * - `places:searchText` for "Cafe Phê La" returns Thành Thái / Lê Văn Lương /
 *   Huỳnh Thúc Kháng unbiased — not the branch the link points at — and
 *   returns that branch first with a 200 m `locationBias.circle`.
 */
describe('locale and location bias (#505)', () => {
  type SpiedFetch = ReturnType<typeof vi.fn<(url: string, init?: { body?: string }) => unknown>>;
  const bodyOf = (mock: SpiedFetch): Record<string, unknown> =>
    JSON.parse(String(mock.mock.calls[0]![1]?.body ?? '{}')) as Record<string, unknown>;
  const urlOf = (mock: SpiedFetch): string => String(mock.mock.calls[0]![0]);
  const jsonFetch = (payload: unknown): SpiedFetch =>
    vi.fn((_url: string, _init?: { body?: string }) =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    ) as SpiedFetch;

  afterEach(() => {
    vi.unstubAllGlobals();
    resetBreakers();
  });

  it('asks Text Search in Vietnamese, for Vietnam', async () => {
    const fetchMock = jsonFetch({ places: [] });
    vi.stubGlobal('fetch', fetchMock);

    await new GooglePlacesAdapter(API_KEY).searchCandidates('Bảo tàng Hà Nội', 3);

    expect(bodyOf(fetchMock)).toMatchObject({ languageCode: 'vi', regionCode: 'VN' });
  });

  it('sends a bias as a circle, and only when it has one', async () => {
    const fetchMock = jsonFetch({ places: [] });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new GooglePlacesAdapter(API_KEY);

    await adapter.searchCandidates('Cafe Phê La', 3, {
      bias: { lat: 21.0495428, lng: 105.8138058, radiusMeters: 250 },
    });
    expect(bodyOf(fetchMock)).toMatchObject({
      locationBias: {
        circle: { center: { latitude: 21.0495428, longitude: 105.8138058 }, radius: 250 },
      },
    });
    // A bias, never a restriction: Google must still be free to answer with a
    // place just outside the circle.
    expect(bodyOf(fetchMock)).not.toHaveProperty('locationRestriction');

    fetchMock.mockClear();
    await adapter.searchCandidates('Cafe Phê La', 3);
    expect(bodyOf(fetchMock)).not.toHaveProperty('locationBias');
  });

  it('asks Details in Vietnamese too, on the query string', async () => {
    const fetchMock = jsonFetch({
      id: 'ChIJxwnWy6usNTERS_TY4hfsH2s',
      displayName: { text: 'Bảo tàng Hà Nội' },
      location: { latitude: 21.0055, longitude: 105.7823 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await new GooglePlacesAdapter(API_KEY).details(
      'ChIJxwnWy6usNTERS_TY4hfsH2s',
      'core',
    );

    const url = urlOf(fetchMock);
    expect(url).toContain('languageCode=vi');
    expect(url).toContain('regionCode=VN');
    expect(out?.name).toBe('Bảo tàng Hà Nội');
  });

  it('spends one request per search — the locale is not a second call', async () => {
    const fetchMock = jsonFetch({ places: [] });
    vi.stubGlobal('fetch', fetchMock);

    await new GooglePlacesAdapter(API_KEY).searchCandidates('x', 3, {
      bias: { lat: 21, lng: 105, radiusMeters: 250 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
