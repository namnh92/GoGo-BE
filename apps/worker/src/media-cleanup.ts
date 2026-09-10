import {
  CloudflareCachePurgeAdapter,
  NoopCachePurge,
  R2StorageAdapter,
  resolveR2AccountId,
  type CachePurgePort,
  type StoragePort,
} from '@gogo/providers';

export type MediaCleanupWiring = {
  privateStorage: StoragePort;
  publicStorage: StoragePort;
  purge: CachePurgePort;
  mediaBaseUrl: string;
  purgeConfigured: boolean;
};

export type MediaCleanupWiringResult =
  { ok: true; wiring: MediaCleanupWiring } | { ok: false; missing: string[] };

/**
 * ADR-0022 — what the worker needs to retry the media cleanup queue, read
 * from its own copy of the env exactly as the API reads its own.
 *
 * Refuses rather than faking: a worker on an in-memory bucket would report
 * every row done while the real object stayed in R2, which is worse than a
 * queue that waits. When any credential is missing the job is not registered,
 * the boot log says which values are absent, and the rows keep until a
 * configured worker comes along.
 */
export function mediaCleanupFromEnv(env: NodeJS.ProcessEnv): MediaCleanupWiringResult {
  // GoGo-BE#548 — the account id may arrive as itself or inside R2_ENDPOINT;
  // what the adapter needs is the resolved value, and a worker that cannot
  // resolve one must not register the job.
  const accountId = resolveR2AccountId({
    accountId: env.R2_ACCOUNT_ID,
    endpoint: env.R2_ENDPOINT,
  });
  const required = {
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: env.R2_BUCKET,
    R2_PUBLIC_BUCKET: env.R2_PUBLIC_BUCKET,
    R2_PUBLIC_ACCESS_KEY_ID: env.R2_PUBLIC_ACCESS_KEY_ID,
    R2_PUBLIC_SECRET_ACCESS_KEY: env.R2_PUBLIC_SECRET_ACCESS_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) return { ok: false, missing };

  const purgeConfigured = Boolean(env.CF_ZONE_ID && env.CF_CACHE_PURGE_TOKEN);
  return {
    ok: true,
    wiring: {
      privateStorage: new R2StorageAdapter({
        accountId: required.R2_ACCOUNT_ID!,
        accessKeyId: required.R2_ACCESS_KEY_ID!,
        secretAccessKey: required.R2_SECRET_ACCESS_KEY!,
        bucket: required.R2_BUCKET!,
      }),
      publicStorage: new R2StorageAdapter({
        accountId: required.R2_ACCOUNT_ID!,
        accessKeyId: required.R2_PUBLIC_ACCESS_KEY_ID!,
        secretAccessKey: required.R2_PUBLIC_SECRET_ACCESS_KEY!,
        bucket: required.R2_PUBLIC_BUCKET!,
      }),
      purge: purgeConfigured
        ? new CloudflareCachePurgeAdapter({
            zoneId: env.CF_ZONE_ID!,
            token: env.CF_CACHE_PURGE_TOKEN!,
          })
        : new NoopCachePurge(),
      mediaBaseUrl: env.MEDIA_PUBLIC_BASE_URL ?? '',
      purgeConfigured,
    },
  };
}
