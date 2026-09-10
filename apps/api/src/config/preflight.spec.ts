import { describe, expect, it } from 'vitest';

import { capabilitiesOf, preflight } from './preflight';
import { loadEnv } from './env';

/**
 * GOGO-550 — the check exists because a partial config was caught *after* the
 * container swap, not before. These cases are the ones that took DEV down and
 * the ones that would silently turn a feature off.
 */
const base = {
  DATABASE_URL: 'postgres://gogo:gogo@localhost:5432/gogo',
  REDIS_URL: 'redis://localhost:6379',
};

const withStorage = {
  ...base,
  R2_ENDPOINT: 'https://acc123.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'gogo-dev-assets',
};

describe('config preflight', () => {
  it('refuses the exact partial config that crash-looped DEV', () => {
    const result = preflight({ ...withStorage, R2_PUBLIC_BUCKET: 'gogo-dev-public' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/R2_PUBLIC_BUCKET/);
  });

  it('refuses a zone id without its purge token', () => {
    const result = preflight({ ...base, CF_ZONE_ID: 'zone' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/CF_ZONE_ID/);
  });

  it('accepts a valid environment and reports what it can do', () => {
    const result = preflight(withStorage);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.capabilities.privateStorage).toBe(true);
      expect(result.capabilities.avatarUpload).toBe(false);
      expect(result.capabilities.edgeCachePurge).toBe(false);
    }
  });

  it('reports avatar upload only when the bucket, its credential and the base URL are all present', () => {
    const complete = loadEnv({
      ...withStorage,
      R2_PUBLIC_BUCKET: 'gogo-dev-public',
      R2_PUBLIC_ACCESS_KEY_ID: 'pub-key',
      R2_PUBLIC_SECRET_ACCESS_KEY: 'pub-secret',
      MEDIA_PUBLIC_BASE_URL: 'https://assets-dev.gogo.id.vn',
    });
    expect(capabilitiesOf(complete).avatarUpload).toBe(true);

    const noBaseUrl = loadEnv({
      ...withStorage,
      R2_PUBLIC_BUCKET: 'gogo-dev-public',
      R2_PUBLIC_ACCESS_KEY_ID: 'pub-key',
      R2_PUBLIC_SECRET_ACCESS_KEY: 'pub-secret',
    });
    expect(capabilitiesOf(noBaseUrl).avatarUpload).toBe(false);
  });

  it('reports edge purge once both halves are present', () => {
    const config = loadEnv({ ...base, CF_ZONE_ID: 'zone', CF_CACHE_PURGE_TOKEN: 'token' });
    expect(capabilitiesOf(config).edgeCachePurge).toBe(true);
  });

  it('does not call an environment storage-capable when no account id resolves', () => {
    const result = preflight({ ...base, R2_ACCESS_KEY_ID: 'key', R2_BUCKET: 'b' });
    expect(result.ok).toBe(false);
  });
});
