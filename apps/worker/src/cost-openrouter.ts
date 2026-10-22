import type { Db } from '@gogo/database';
import {
  ANTHROPIC_BYOK_COLLECTOR_ID,
  OPENROUTER_ACTIVITY_COLLECTOR_ID,
  anthropicByokCollector,
  openRouterActivityCollector,
} from '@gogo/modules';
import { openRouterUsageFromEnv } from '@gogo/providers';
import type { CollectorDefinition } from '@gogo/modules';

type Registry = { register(def: CollectorDefinition): unknown };
type InfoLogger = { info(obj: object, msg: string): void };

/**
 * GoGo-BE#709 — the `openrouter_activity` + `anthropic_byok_openrouter` registration, out of `main.ts` so
 * the gate is testable. One OpenRouter account serves every environment, so
 * only the worker whose env holds `OPENROUTER_MANAGEMENT_KEY` counts it
 * (Infra writes it for dev only). No key → nothing registered, one info line
 * naming what is missing, no throw.
 */
export function registerOpenRouterActivityCollector(
  env: Record<string, string | undefined>,
  db: Db,
  collectors: Registry,
  logger: InfoLogger,
  fetchImpl?: typeof fetch,
): boolean {
  const client = openRouterUsageFromEnv(env, fetchImpl);
  if (!client) {
    logger.info(
      { provider: 'openrouter', missing: 'OPENROUTER_MANAGEMENT_KEY' },
      'openrouter cost collector not registered — credentials absent',
    );
    return false;
  }
  collectors.register(openRouterActivityCollector(db, client));
  // The Claude part of BYOK spend is Anthropic's money: its own collector, so
  // Anthropic's freshness is its own.
  collectors.register(anthropicByokCollector(db, client));
  logger.info(
    { collectors: [OPENROUTER_ACTIVITY_COLLECTOR_ID, ANTHROPIC_BYOK_COLLECTOR_ID] },
    'openrouter cost collector registered',
  );
  return true;
}
