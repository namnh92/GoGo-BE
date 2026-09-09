import { describe, expect, it } from 'vitest';
import { NoopCachePurge, R2StorageAdapter, CloudflareCachePurgeAdapter } from '@gogo/providers';
import { mediaCleanupFromEnv } from './media-cleanup';

const full = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'k',
  R2_SECRET_ACCESS_KEY: 's',
  R2_BUCKET: 'gogo-dev-assets',
  R2_PUBLIC_BUCKET: 'gogo-dev-public',
  R2_PUBLIC_ACCESS_KEY_ID: 'pk',
  R2_PUBLIC_SECRET_ACCESS_KEY: 'ps',
  MEDIA_PUBLIC_BASE_URL: 'https://assets-dev.gogo.id.vn',
};

describe('media cleanup wiring (ADR-0022)', () => {
  it('names every missing value instead of binding a fake that would lie', () => {
    const result = mediaCleanupFromEnv({ R2_ACCOUNT_ID: 'acct' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_PUBLIC_BUCKET',
      'R2_PUBLIC_ACCESS_KEY_ID',
      'R2_PUBLIC_SECRET_ACCESS_KEY',
    ]);
  });

  it('binds two real buckets and a no-op purge when the purge credential is absent', () => {
    const result = mediaCleanupFromEnv(full);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wiring.privateStorage).toBeInstanceOf(R2StorageAdapter);
    expect(result.wiring.publicStorage).toBeInstanceOf(R2StorageAdapter);
    expect(result.wiring.purge).toBeInstanceOf(NoopCachePurge);
    expect(result.wiring.purgeConfigured).toBe(false);
    expect(result.wiring.mediaBaseUrl).toBe('https://assets-dev.gogo.id.vn');
  });

  it('binds the Cloudflare purge when zone and token are both present', () => {
    const result = mediaCleanupFromEnv({ ...full, CF_ZONE_ID: 'z', CF_CACHE_PURGE_TOKEN: 't' });
    expect(result.ok && result.wiring.purge).toBeInstanceOf(CloudflareCachePurgeAdapter);
    expect(result.ok && result.wiring.purgeConfigured).toBe(true);
  });
});
