/**
 * GOGO-550 — validate configuration *before* the running containers are
 * replaced.
 *
 * On 2026-09-10 a deploy shipped an env file carrying `R2_PUBLIC_BUCKET`
 * without its two credentials. The all-or-none rule in `loadEnv` did exactly
 * what it should — refuse — but it refused inside the new container, after the
 * old one was already gone: DEV crash-looped for two minutes. The schema was
 * right and the ordering was wrong.
 *
 * So this runs the same schema against the env file the deploy is about to
 * install, in a container that is not serving anything. A refusal here costs
 * nothing; the same refusal after the swap is an outage.
 *
 * It also prints what the environment can and cannot do, because "valid" and
 * "capable" are different questions: an env with no public bucket is valid, and
 * the avatar feature is off. A deploy that silently turns a feature off is
 * worth one line of output.
 */
import { loadEnv, type AppConfig } from './env';
import { resolveR2AccountId } from '@gogo/providers';

export type PreflightResult =
  { ok: true; capabilities: Record<string, boolean> } | { ok: false; problem: string };

/** Feature switches a deploy silently flips, named so a log shows the flip. */
export function capabilitiesOf(config: AppConfig): Record<string, boolean> {
  const accountId = resolveR2AccountId({
    accountId: config.R2_ACCOUNT_ID,
    endpoint: config.R2_ENDPOINT,
  });
  const privateStorage = Boolean(accountId && config.R2_ACCESS_KEY_ID && config.R2_BUCKET);
  return {
    privateStorage,
    avatarUpload:
      privateStorage &&
      Boolean(
        config.R2_PUBLIC_BUCKET &&
        config.R2_PUBLIC_ACCESS_KEY_ID &&
        config.R2_PUBLIC_SECRET_ACCESS_KEY &&
        config.MEDIA_PUBLIC_BASE_URL,
      ),
    edgeCachePurge: Boolean(config.CF_ZONE_ID && config.CF_CACHE_PURGE_TOKEN),
    push: Boolean(config.ONESIGNAL_APP_ID && config.ONESIGNAL_REST_API_KEY),
  };
}

export function preflight(source: NodeJS.ProcessEnv): PreflightResult {
  try {
    return { ok: true, capabilities: capabilitiesOf(loadEnv(source)) };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}
