import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePlacesAdapter } from './google-places.adapter';
import {
  ProviderConfigurationError,
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

function respond(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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
    await expect(adapter.details('ChIJexample')).rejects.toBeInstanceOf(ProviderConfigurationError);
    await expect(adapter.details('ChIJexample')).rejects.toMatchObject({
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

    await expect(adapter.details('ChIJexample')).rejects.toBeInstanceOf(ProviderConfigurationError);
  });

  it('does not retry a configuration fault', async () => {
    const fetchMock = respond(403, SERVICE_DISABLED_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJexample')).rejects.toBeInstanceOf(ProviderConfigurationError);
    // One call, not three. Retrying an API nobody enabled burns the breaker
    // and produces the "opens and closes forever" symptom from the issue.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still reports quota exhaustion as quota', async () => {
    respond(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJexample')).rejects.toBeInstanceOf(ProviderQuotaExceededError);
  });

  it('still reports a 5xx as a transient outage', async () => {
    respond(503, { error: { code: 503 } });
    const adapter = new GooglePlacesAdapter(API_KEY);

    await expect(adapter.details('ChIJexample')).rejects.toBeInstanceOf(ProviderUnavailableError);
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

  it('never puts the API key in the error it throws', async () => {
    respond(403, SERVICE_DISABLED_BODY);
    const adapter = new GooglePlacesAdapter(API_KEY);

    const err = await adapter.details('ChIJexample').catch((e: unknown) => e);
    const serialized = JSON.stringify({
      message: (err as Error).message,
      ...(err as ProviderConfigurationError),
    });
    expect(serialized).not.toContain(API_KEY);
    expect((err as Error).stack ?? '').not.toContain(API_KEY);
  });
});
