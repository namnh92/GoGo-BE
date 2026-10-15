import type { Db } from '@gogo/database';
import { SENTRY_EVENTS_COLLECTOR_ID, sentryEventsCollector } from '@gogo/modules';
import { sentryStatsFromEnv } from '@gogo/providers';
import type { CollectorDefinition } from '@gogo/modules';

type Registry = { register(def: CollectorDefinition): unknown };
type InfoLogger = { info(obj: object, msg: string): void };

/**
 * BE#696 (ADR-0011 D-14) — the `sentry_events` registration, out of
 * `main.ts` so the gate is testable. One Sentry org serves every
 * environment, so only the worker whose env holds `SENTRY_STATS_TOKEN`
 * counts it (Infra writes it for dev only). No token → nothing registered,
 * one info line naming what is missing, no throw.
 */
export function registerSentryEventsCollector(
  env: Record<string, string | undefined>,
  db: Db,
  collectors: Registry,
  logger: InfoLogger,
  fetchImpl?: typeof fetch,
): boolean {
  const client = sentryStatsFromEnv(env, fetchImpl);
  if (!client) {
    logger.info(
      { provider: 'sentry', missing: 'SENTRY_STATS_TOKEN / SENTRY_ORG' },
      'sentry cost collector not registered — credentials absent',
    );
    return false;
  }
  collectors.register(sentryEventsCollector(db, client));
  logger.info({ collectors: [SENTRY_EVENTS_COLLECTOR_ID] }, 'sentry cost collector registered');
  return true;
}
