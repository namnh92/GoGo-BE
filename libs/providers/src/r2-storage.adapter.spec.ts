import { describe, expect, it } from 'vitest';
import { R2StorageAdapter } from './r2-storage.adapter';

const adapter = new R2StorageAdapter({
  accountId: 'acct',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  bucket: 'gogo-media',
});

describe('R2 presigned upload (#171)', () => {
  it('signs a PUT to the bucket-scoped key', async () => {
    const { url } = await adapter.presignUpload('u/user/abc/photo.jpg', 'image/jpeg');
    const parsed = new URL(url);

    expect(parsed.host).toBe('acct.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe('/gogo-media/u/user/abc/photo.jpg');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the content type, so storage rejects a different one', async () => {
    const { url } = await adapter.presignUpload('k.jpg', 'image/jpeg');
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });

  it('a different content type produces a different signature', async () => {
    const jpeg = await adapter.presignUpload('k.jpg', 'image/jpeg');
    const png = await adapter.presignUpload('k.jpg', 'image/png');
    const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
    expect(sig(jpeg.url)).not.toBe(sig(png.url));
  });

  it('escapes each path segment without escaping the separators', async () => {
    const { url } = await adapter.presignUpload('u/user/a b/ảnh.jpg', 'image/jpeg');
    const parsed = new URL(url);
    expect(parsed.pathname).toContain('/gogo-media/u/user/a%20b/');
    expect(parsed.pathname).not.toContain('%2F');
  });

  it('expires, and says for how long', async () => {
    const result = await adapter.presignUpload('k.jpg', 'image/jpeg');
    expect(result.expiresInSeconds).toBe(900);
    expect(new URL(result.url).searchParams.get('X-Amz-Expires')).toBe('900');
  });
});

/** Captures what the adapter sends, answers what the test says. */
function stubFetch(answer: { status: number; body?: Uint8Array; headers?: Record<string, string> }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(answer.body ?? null, { status: answer.status, headers: answer.headers ?? {} });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe('R2 server-side verbs (ADR-0022)', () => {
  const header = (init: RequestInit, name: string) =>
    (init.headers as Record<string, string>)[name];

  it('PUT signs every header it sends, the payload hash included', async () => {
    const { calls, fetcher } = stubFetch({ status: 200 });
    const signed = new R2StorageAdapter({ ...adapter['config'], fetch: fetcher });
    const body = new Uint8Array([1, 2, 3]);
    await signed.putObject('avatars/abc.webp', body, 'image/webp', {
      cacheControl: 'public, max-age=86400',
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(init.method).toBe('PUT');
    expect(url).toBe('https://acct.r2.cloudflarestorage.com/gogo-media/avatars/abc.webp');
    expect(header(init, 'content-type')).toBe('image/webp');
    expect(header(init, 'cache-control')).toBe('public, max-age=86400');
    expect(header(init, 'x-amz-content-sha256')).toBe(
      '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    );
    const authorization = header(init, 'authorization');
    expect(authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('GET refuses an object the declared length says is too large, before reading it', async () => {
    const { fetcher } = stubFetch({
      status: 200,
      body: new Uint8Array(10),
      headers: { 'content-length': '10' },
    });
    const signed = new R2StorageAdapter({ ...adapter['config'], fetch: fetcher });
    await expect(signed.getObject('k', { maxBytes: 5 })).rejects.toThrow(/exceeds 5 bytes/);
  });

  it('GET refuses on the real length too, because a header is a claim', async () => {
    const { fetcher } = stubFetch({ status: 200, body: new Uint8Array(10) });
    const signed = new R2StorageAdapter({ ...adapter['config'], fetch: fetcher });
    await expect(signed.getObject('k', { maxBytes: 5 })).rejects.toThrow(/exceeds 5 bytes/);
  });

  it('GET returns the bytes and the content type under the cap', async () => {
    const { fetcher } = stubFetch({
      status: 200,
      body: new Uint8Array([9, 9]),
      headers: { 'content-type': 'image/png' },
    });
    const signed = new R2StorageAdapter({ ...adapter['config'], fetch: fetcher });
    const found = await signed.getObject('k', { maxBytes: 5 });
    expect(found).toEqual({ body: new Uint8Array([9, 9]), contentType: 'image/png', contentLength: 2 });
  });

  it('GET 404 is not-found; DELETE 404 is success', async () => {
    const missing = new R2StorageAdapter({ ...adapter['config'], fetch: stubFetch({ status: 404 }).fetcher });
    await expect(missing.getObject('gone')).rejects.toThrow(/not found/);
    await expect(missing.deleteObject('gone')).resolves.toBeUndefined();
  });

  it('any other failure is the provider being unavailable, never a silent success', async () => {
    const broken = new R2StorageAdapter({ ...adapter['config'], fetch: stubFetch({ status: 500 }).fetcher });
    await expect(broken.deleteObject('k')).rejects.toThrow(/unavailable/);
    await expect(broken.putObject('k', new Uint8Array(1), 'image/webp')).rejects.toThrow(/unavailable/);
  });
});
