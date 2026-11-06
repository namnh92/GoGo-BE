import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePlacesAdapter } from './google-places.adapter';
import { resetBreakers } from './resilience';

beforeEach(() => resetBreakers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const metrics = { increment: vi.fn(), observe: vi.fn() };
  return { fetcher, metrics, adapter: new GooglePlacesAdapter('test-key', metrics) };
}

describe('Google address-only backfill request', () => {
  it('uses only formattedAddress, locale and normal Places cost metrics', async () => {
    const f = setup();
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ formattedAddress: ' Address ' })));
    expect(await f.adapter.address('place/id')).toBe('Address');
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(url).toContain('/places/place%2Fid?languageCode=vi&regionCode=VN');
    expect(init.headers['X-Goog-FieldMask']).toBe('formattedAddress');
    expect(init.redirect).toBe('error');
    expect(f.metrics.increment).toHaveBeenCalledWith('places_provider_requests_total', {
      method: 'google.details.address',
      status: 200,
    });
    expect(f.metrics.increment).toHaveBeenCalledWith('places_provider_cost_units', {
      sku: 'google.details.address',
    });
  });

  it.each([{}, { formattedAddress: ' ' }, { formattedAddress: 42 }])(
    'ignores absent/malformed address %j',
    async (body) => {
      const f = setup();
      f.fetcher.mockResolvedValue(new Response(JSON.stringify(body)));
      expect(await f.adapter.address('id')).toBeNull();
    },
  );

  it('does not retry server errors', async () => {
    const f = setup();
    f.fetcher.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(f.adapter.address('id')).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.metrics.increment).not.toHaveBeenCalledWith(
      'places_provider_cost_units',
      expect.anything(),
    );
  });

  it('counts a transport error as an attempt, never a billed unit', async () => {
    const f = setup();
    f.fetcher.mockRejectedValue(new Error('offline'));
    await expect(f.adapter.address('id')).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.metrics.increment).toHaveBeenCalledWith('places_provider_requests_total', {
      method: 'google.details.address',
      status: 'error',
    });
    expect(f.metrics.increment).not.toHaveBeenCalledWith(
      'places_provider_cost_units',
      expect.anything(),
    );
  });

  it('aborts at the adapter deadline without retrying', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.fetcher.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
        }),
    );
    const rejected = expect(f.adapter.address('id')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
