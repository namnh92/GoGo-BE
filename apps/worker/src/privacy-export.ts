import { parseExportKeyring, pickExportKeyEnv, type ExportKeyring } from '@gogo/modules';
import { R2StorageAdapter, resolveR2AccountId, type StoragePort } from '@gogo/providers';

export type PrivacyExportWiring = {
  /** The private bucket, or null with the names of what is missing. */
  storage: StoragePort | null;
  /** At least one wrapping key, or null: this worker then sweeps but never generates. */
  keyring: ExportKeyring | null;
  missing: { storage: string[]; keyring: string[] };
};

/**
 * GoGo-BE#256, ADR-0033 — what the worker needs for secure exports, read from
 * its own copy of the env. Two independent decisions (PR #677 S-F-11):
 *
 * - the bucket: needed by the sweep (expiry, timeouts, deletion, dead-letter
 *   alerts, redrive) and by generation. Refused rather than faked, like media
 *   cleanup: an in-memory bucket would "publish" an export no API process can
 *   read and "delete" one that was never stored. Without it nothing is
 *   registered and the boot log names what is absent;
 * - the wrapping keys: needed by generation only. Without them the sweep still
 *   runs — a key rotation gone wrong must never also stop deletion — and
 *   artifacts wait pending until a keyed worker claims them (then time out
 *   explicitly). A malformed key throws: the worker must not boot on a key of
 *   the wrong size.
 */
export function privacyExportFromEnv(env: NodeJS.ProcessEnv): PrivacyExportWiring {
  const accountId = resolveR2AccountId({ accountId: env.R2_ACCOUNT_ID, endpoint: env.R2_ENDPOINT });
  const required = {
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: env.R2_BUCKET,
  };
  const missingStorage = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  // Same picker as the API's loadEnv (PR #677 F-08): any V<n>, never a fixed list.
  const keyring = parseExportKeyring(pickExportKeyEnv(env as Record<string, unknown>));
  return {
    storage:
      missingStorage.length === 0
        ? new R2StorageAdapter({
            accountId: required.R2_ACCOUNT_ID!,
            accessKeyId: required.R2_ACCESS_KEY_ID!,
            secretAccessKey: required.R2_SECRET_ACCESS_KEY!,
            bucket: required.R2_BUCKET!,
          })
        : null,
    keyring,
    missing: { storage: missingStorage, keyring: keyring ? [] : ['EXPORT_WRAPPING_KEY_V1'] },
  };
}
