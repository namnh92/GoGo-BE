import * as Sentry from '@sentry/node';
import { sentryInitOptions } from '@gogo/observability';

/**
 * BE#675 — the worker's only Sentry calls, kept to this file so the #588
 * boundary (`libs/observability/src/sentry.ts`, pinned by
 * `apps/api/src/sentry-usage.spec.ts`) stays one place to review.
 *
 * Same options as the API, environment from APP_ENV for the same reason as
 * BE#674: the deploy writes NODE_ENV=production for every environment.
 */
export function initWorkerSentry(env: NodeJS.ProcessEnv): boolean {
  const dsn = env.SENTRY_DSN ?? '';
  if (!dsn) return false;
  Sentry.init(sentryInitOptions({ dsn, environment: env.APP_ENV ?? 'dev' }));
  return true;
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
