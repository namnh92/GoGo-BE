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
