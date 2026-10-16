import * as Sentry from '@sentry/node';
import { sentryInitOptions, sentryRelease } from '@gogo/observability';

/**
 * BE#675 — the worker's only Sentry calls, kept to this file so the #588
 * boundary (`libs/observability/src/sentry.ts`, pinned by
 * `apps/api/src/sentry-usage.spec.ts`) stays one place to review.
 *
 * Same options as the API, environment from APP_ENV for the same reason as
 * BE#674: the deploy writes NODE_ENV=production for every environment.
 * The SDK only captures rejections (`none`); {@link fatalRejectionHandler}
 * ends the process. The heartbeat URLs carry their credential in the path, so
 * their breadcrumbs are redacted (F-03 on PR #678).
 */
export function initWorkerSentry(env: NodeJS.ProcessEnv): boolean {
  const dsn = env.SENTRY_DSN ?? '';
  if (!dsn) return false;
  Sentry.init(
    sentryInitOptions({
      dsn,
      environment: env.APP_ENV ?? 'dev',
      release: sentryRelease(env.GOGO_REVISION),
      unhandledRejection: 'none',
      secretUrls: [env.HEARTBEAT_URL_OUTBOX, env.HEARTBEAT_URL_INGEST, env.HEARTBEAT_URL_PRIVACY],
    }),
  );
  return true;
}

/**
 * BE#675 F-01/F-05 — an unhandled rejection ends the worker, as it did before
 * Sentry: a half-broken worker left running would keep failing, and reporting,
 * where compose would have restarted it. The SDK captures it first (its
 * listener is registered at init, before this one); this flushes and exits 1.
 * Owned here rather than by the SDK's `strict` mode, which returns early —
 * no exit — for the names it ignores (`AbortError` in 10.71). Such a rejection
 * still ends the process; it is just not in Sentry.
 */
export function fatalRejectionHandler(deps: {
  log: (reason: unknown) => void;
  flush: () => Promise<void>;
  exit: (code: number) => void;
}): (reason: unknown) => Promise<void> {
  let exiting = false;
  return async (reason) => {
    if (exiting) return;
    exiting = true;
    deps.log(reason);
    await deps.flush().catch(() => undefined);
    deps.exit(1);
  };
}

/** A no-op until `initWorkerSentry` has run with a DSN. Attaches the job name only. */
export function captureWorkerError(err: unknown, job?: string): void {
  if (job) Sentry.captureException(err, { tags: { periodic_job: job } });
  else Sentry.captureException(err);
}

/** Sends what is queued before the process exits; bounded so exit is never held. */
export async function flushWorkerSentry(): Promise<void> {
  await Sentry.flush(2_000);
}
