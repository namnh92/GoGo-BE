import { parseExportKeyring, type ExportKeyring } from '@gogo/modules';
import { R2StorageAdapter, resolveR2AccountId, type StoragePort } from '@gogo/providers';

export type PrivacyExportWiring =
  { ok: true; storage: StoragePort; keyring: ExportKeyring } | { ok: false; missing: string[] };

/**
 * GoGo-BE#256, ADR-0031 — what the worker needs to generate and delete secure
 * exports: the private bucket and at least one wrapping key, read from its own
 * copy of the env.
 *
 * Refuses rather than faking, like media cleanup: an in-memory bucket would
 * "publish" an export no API process can read, and "delete" one that was never
 * stored. When anything is missing the jobs are not registered, the boot log
 * names what is absent, and artifacts wait (then time out explicitly).
 * A malformed key throws: the worker must not boot on a key of the wrong size.
 */
export function privacyExportFromEnv(env: NodeJS.ProcessEnv): PrivacyExportWiring {
  const accountId = resolveR2AccountId({ accountId: env.R2_ACCOUNT_ID, endpoint: env.R2_ENDPOINT });
  const required = {
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: env.R2_BUCKET,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  const keyring = parseExportKeyring(env as Record<string, unknown>);
  if (!keyring) missing.push('EXPORT_WRAPPING_KEY_V1');
  if (missing.length > 0 || !keyring) return { ok: false, missing };
  return {
    ok: true,
    keyring,
    storage: new R2StorageAdapter({
      accountId: required.R2_ACCOUNT_ID!,
      accessKeyId: required.R2_ACCESS_KEY_ID!,
      secretAccessKey: required.R2_SECRET_ACCESS_KEY!,
      bucket: required.R2_BUCKET!,
    }),
  };
}
