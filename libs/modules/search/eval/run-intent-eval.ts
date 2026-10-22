/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OpenRouterDecisionProvider } from '@gogo/providers';
import {
  IntentClassificationService,
  type IntentCallRecord,
} from '../application/intent-classification.service';
import { SEED_TAXONOMY } from './seed-taxonomy';
import { committedSpendUsd, unknownCostCalls } from './spend';

/**
 * GoGo-BE#709 — evaluation of Vietnamese intent classification.
 *
 *   pnpm eval:intent                       # no model: deterministic facts + fallback only
 *   INTENT_EVAL_MODE=live INTENT_EVAL_LIVE_AUTHORIZED=yes OPENROUTER_API_KEY=… pnpm eval:intent
 *
 * Live mode is paid inference and runs only when a person authorized it: both
 * variables, a key, and a spend ceiling (INTENT_EVAL_MAX_USD, default $0.05 —
 * ~150 requests of a few hundred input tokens at $0.042 per 1M is far below
 * it). The run stops at the ceiling; a call with an unknown cost counts at
 * INTENT_EVAL_UNKNOWN_CALL_USD so an unreported cost can only stop it sooner.
 *
 * Model accuracy is reported only for a live run. The default run says
 * nothing about model quality, and prints that it does not.
 */

type Case = {
  id: string;
  text: string;
  tags: string[];
  expect: {
    category: string | null;
    occasion: string | null;
    inScope: boolean;
    needsClarification: boolean;
  };
};

async function main(): Promise<void> {
  const { cases } = JSON.parse(
    readFileSync(path.join(__dirname, 'intent-cases.vi.json'), 'utf8'),
  ) as {
    cases: Case[];
  };
  const live = process.env.INTENT_EVAL_MODE === 'live';
  if (live && process.env.INTENT_EVAL_LIVE_AUTHORIZED !== 'yes') {
    throw new Error(
      'INTENT_EVAL_MODE=live needs INTENT_EVAL_LIVE_AUTHORIZED=yes — paid inference is never implied',
    );
  }
  const maxUsd = Number(process.env.INTENT_EVAL_MAX_USD ?? '0.05');
  const unknownCallUsd = Number(process.env.INTENT_EVAL_UNKNOWN_CALL_USD ?? '0.001');
  const calls: IntentCallRecord[] = [];
  const provider = live
    ? new OpenRouterDecisionProvider({
        apiKey: process.env.OPENROUTER_API_KEY ?? '',
        model: process.env.INTENT_EVAL_MODEL ?? 'typesafe/jev-1.14',
        timeoutMs: Number(process.env.INTENT_EVAL_TIMEOUT_MS ?? '5000'),
      })
    : null;
  const service = new IntentClassificationService(provider, live ? 'enabled' : 'disabled', (c) =>
    calls.push(c),
  );

  const committed = () => committedSpendUsd(calls, unknownCallUsd);
  const hits = { category: 0, occasion: 0, inScope: 0, needsClarification: 0 };
  let evaluated = 0;
  for (const c of cases) {
    if (live && committed() + unknownCallUsd > maxUsd) {
      console.log(`stopped at the spend ceiling ($${maxUsd}) after ${evaluated} cases`);
      break;
    }
    const r = await service.classify(c.text, SEED_TAXONOMY);
    evaluated += 1;
    if (r.category.key === c.expect.category) hits.category += 1;
    if (r.occasion.key === c.expect.occasion) hits.occasion += 1;
    if (r.inScope.value === c.expect.inScope) hits.inScope += 1;
    if (r.clarification.needed === c.expect.needsClarification) hits.needsClarification += 1;
  }

  const latencies = calls
    .filter((c) => c.outcome === 'answered')
    .map((c) => c.latencyMs)
    .sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies.length ? latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)] : null;
  const outcomes = calls.reduce<Record<string, number>>(
    (acc, c) => ({ ...acc, [c.outcome]: (acc[c.outcome] ?? 0) + 1 }),
    {},
  );
  const report = {
    mode: live ? 'live' : 'no-model',
    cases: cases.length,
    evaluated,
    models: [...new Set(calls.map((c) => c.model).filter(Boolean))],
    // Without a model these are the fallback's numbers — what a caller gets
    // when the provider is off — not a measure of any model.
    accuracy: Object.fromEntries(
      Object.entries(hits).map(([k, v]) => [k, evaluated ? +(v / evaluated).toFixed(3) : null]),
    ),
    requests: calls.length,
    outcomes,
    latencyMs: { p50: pct(0.5), p95: pct(0.95) },
    reportedCostUsd: calls.reduce((s, c) => s + (c.costUsd ?? 0), 0),
    unknownCostCalls: unknownCostCalls(calls),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!live)
    console.log(
      'No model was called: accuracy above is the deterministic fallback, not model quality.',
    );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
