import type { StoragePort } from '@gogo/providers';

export type PrivacyExportStorageConfig = {
  NODE_ENV: 'development' | 'test' | 'production';
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
};

/**
 * GoGo-BE#256, PR #677 S-F-13 — the one decision behind `PRIVACY_EXPORT_STORAGE`.
 *
 * `general` is the process's `STORAGE_PROVIDER`: the real private bucket when R2
 * is configured, otherwise an in-memory fake that keeps the upload flows
 * exercisable without credentials. Privacy cleanup cannot share that fallback:
 * `cleanupDueArtifacts` marks an artifact cleaned when the delete returns, and a
 * fake delete returns. An API instance booted without the private bucket would
 * then erase the only reference to an object a configured worker had stored,
 * and the object would outlive every record of it. So the answer is the real
 * adapter, the fake under `NODE_ENV=test` only, or `null` — never something
 * that says yes.
 */
export function privacyExportStorageFor(
  config: PrivacyExportStorageConfig,
  general: StoragePort,
): StoragePort | null {
  const real = Boolean(config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_BUCKET);
  return real || config.NODE_ENV === 'test' ? general : null;
}
