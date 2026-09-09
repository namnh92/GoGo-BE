import { describe, expect, it } from 'vitest';
import { CloudflareCachePurgeAdapter, NoopCachePurge } from './cloudflare-cache-purge.adapter';

function stubFetch(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe('Cloudflare cache purge (ADR-0022)', () => {
  it('posts the URLs to the zone purge endpoint with the bearer token', async () => {
    const { calls, fetcher } = stubFetch(200);
    const purge = new CloudflareCachePurgeAdapter({ zoneId: 'zone1', token: 'tok', fetch: fetcher });
    await purge.purgeUrls(['https://assets-dev.gogo.id.vn/avatars/a.webp']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/purge_cache');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      files: ['https://assets-dev.gogo.id.vn/avatars/a.webp'],
    });
  });

  it('sends nothing for an empty list', async () => {
    const { calls, fetcher } = stubFetch(200);
    await new CloudflareCachePurgeAdapter({ zoneId: 'z', token: 't', fetch: fetcher }).purgeUrls([]);
    expect(calls).toHaveLength(0);
  });

  it('a refused purge is the provider being unavailable', async () => {
    const { fetcher } = stubFetch(403);
    const purge = new CloudflareCachePurgeAdapter({ zoneId: 'z', token: 't', fetch: fetcher });
    await expect(purge.purgeUrls(['https://x/y'])).rejects.toThrow(/unavailable/);
  });

  it('the no-op purges nothing and never fails', async () => {
    await expect(new NoopCachePurge().purgeUrls()).resolves.toBeUndefined();
  });
});
