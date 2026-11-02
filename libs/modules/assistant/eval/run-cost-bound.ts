/* eslint-disable no-console */
import { OpenRouterDecisionProvider } from '@gogo/providers';
import type { IntentTaxonomy } from '../../search/domain/intent';
import { TURN_CALL_SHARE } from '../domain/limits';
import {
  PRICE_SOURCE,
  calibrationDrift,
  computeCostBound,
  worstCases,
  type TokenCounter,
} from './cost-bound';
import calibration from './cost-bound.calibration.json';

/**
 * GoGo-BE#738 D-11 — prints `C` for one environment. Paid: three provider calls
 * at their worst-case size (under a cent), so it runs only when asked:
 *
 *   exec-with.sh dev openrouter/api-key openrouter/assistant-api-key -- \
 *     env COST_BOUND_AUTHORIZED=yes COST_BOUND_ENV=dev \
 *     COST_BOUND_TAXONOMY_URL=https://api-dev.gogo.id.vn/v1/taxonomies pnpm assistant:cost-bound
 *
 * Fails closed: without a provider count for every call, no `C` is printed.
 */

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** `GET /v1/taxonomies`: the kinds, each with its keys and labels. */
type TaxonomyBody = {
  kinds: Record<string, { key: string; labels?: Record<string, string> }[]>;
};

export function taxonomyFrom(body: TaxonomyBody): IntentTaxonomy {
  const of = (kind: string) =>
    (body.kinds[kind] ?? []).map((r) => ({ key: r.key, label: r.labels?.vi ?? r.key }));
  return {
    category: of('category'),
    mood: of('mood'),
    setting: of('setting'),
    suitability: of('suitability'),
  };
}

async function main(): Promise<void> {
  const env = process.env;
  if (env.COST_BOUND_AUTHORIZED !== 'yes') {
    throw new Error('COST_BOUND_AUTHORIZED=yes is required: this run is paid inference');
  }
  const jevKey = env.OPENROUTER_API_KEY;
  const haikuKey = env.OPENROUTER_ASSISTANT_API_KEY;
  const url = env.COST_BOUND_TAXONOMY_URL;
  if (!jevKey || !haikuKey || !url) {
    throw new Error('both OpenRouter keys and COST_BOUND_TAXONOMY_URL are required');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`taxonomy read failed: HTTP ${res.status}`);
  const taxonomy = taxonomyFrom((await res.json()) as TaxonomyBody);
  if (taxonomy.category.length === 0) throw new Error('taxonomy is empty: failing closed');

  const provider = new OpenRouterDecisionProvider({
    apiKey: jevKey,
    model: env.ASSISTANT_JEV_MODEL ?? 'typesafe/jev-1.14',
    timeoutMs: 15_000,
  });
  const jevCount: TokenCounter['decision'] = async (request) =>
    (await provider.decide(request)).usage.inputTokens;
  const counter: TokenCounter = {
    decision: jevCount,
    relevance: jevCount,
    compose: async (messages) => {
      const reply = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${haikuKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.ASSISTANT_HAIKU_MODEL ?? 'anthropic/claude-haiku-5.5',
          messages,
          max_tokens: 1,
          usage: { include: true },
          provider: { only: ['anthropic'], allow_fallbacks: false },
          reasoning: { enabled: false },
        }),
      });
      if (!reply.ok) throw new Error(`haiku count failed: HTTP ${reply.status}`);
      const parsed = (await reply.json()) as { usage?: { prompt_tokens?: unknown } };
      const tokens = parsed.usage?.prompt_tokens;
      return typeof tokens === 'number' ? tokens : null;
    },
  };
  const outputTokens = Number(env.ASSISTANT_MAX_OUTPUT_TOKENS ?? 600);
  const bound = await computeCostBound(worstCases(taxonomy, outputTokens), counter);
  console.log(JSON.stringify({ environment: env.COST_BOUND_ENV ?? 'unknown', ...bound }, null, 2));
  console.log(`prices: ${PRICE_SOURCE}`);
  console.log(`code shares TURN_CALL_SHARE: ${JSON.stringify(TURN_CALL_SHARE)}`);
  // The code's shares and the committed record must describe this run, or the
  // hard stop is reading a different calibration than the ceiling (Astra r1).
  const drift = calibrationDrift(bound, taxonomy, outputTokens, TURN_CALL_SHARE, calibration);
  if (drift.length > 0) {
    console.error(
      `calibration drift: ${drift.join('; ')} — update TURN_CALL_SHARE and cost-bound.calibration.json`,
    );
    process.exitCode = 2;
  }
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
