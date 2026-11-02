import type { DecisionRequest } from '@gogo/providers';
import type { IntentTaxonomy } from '../../search/domain/intent';
import { MAX_REQUEST_CHARS } from '../../search/domain/intent';
import {
  MAX_LATEST_MESSAGE_CHARS,
  MAX_PENDING_QUESTION_CHARS,
  MAX_PREVIOUS_REQUEST_CHARS,
  buildAssistantDecisionRequest,
  buildRelevanceRequest,
} from '../domain/decision';
import {
  MAX_CONTEXT_NAME_CHARS,
  MAX_GUIDE_EXCERPT_CHARS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  buildComposerMessages,
  type GroundedAnswerContext,
} from '../domain/grounding';
import type { ResolvedPayload } from '../domain/reconcile';

/**
 * GoGo-BE#738 D-11 — the per-turn worst case `C` as a bound: the sum of each
 * call's maximum charge, computed from the real serialized request at its caps.
 *
 * Tokens come from the provider that bills them (owner 2026-11-02): Jev has no
 * public tokenizer and the Decisions API takes no parameters, so the count is
 * what the provider reports for this exact request. There is no chars-per-token
 * fallback: a missing count fails the run. Jev's output term is zero because its
 * listed completion price is $0 — no `max_tokens` can be sent to it.
 */

/**
 * What `C` is (Astra r1 on #745, SA decision 2026-11-02): the charge of the
 * largest request the code can build, counted by the provider, plus margin —
 * a **calibrated worst-case estimate**, not a proof over every string under
 * the caps (tokens per character are not bounded). What bounds spend is the
 * reservation: a turn is admitted at `C`, and a call that exceeds its share
 * can overspend by at most its own excess, once, before the ledger records it.
 */

/** USD per token, one price per direction. Source and date: `PRICE_SOURCE`. */
export type Prices = {
  jevIn: number;
  jevOut: number;
  haikuIn: number;
  haikuOut: number;
};

export const PRICES: Prices = {
  jevIn: 0.042 / 1_000_000,
  jevOut: 0,
  haikuIn: 0.1 / 1_000_000,
  haikuOut: 0.5 / 1_000_000,
};
export const PRICE_SOURCE =
  'OpenRouter /api/v1/models/typesafe/jev-1.14/endpoints 2026-11-02; Haiku 5.5 BYOK = Anthropic tariff (ADR-0036 §5)';
export const MARGIN = 0.25;
/** OpenRouter's BYOK fee, allocated inside the margin rather than added to it. */
export const BYOK_FEE = 0.05;
/** The relevance call's candidates, `RELEVANCE_MAX` in the orchestrator. */
export const RELEVANCE_CANDIDATES = 6;
const MAX_NAME_CHARS = MAX_CONTEXT_NAME_CHARS;

/** A deterministic filler that tokenizes badly: rare scripts, digits and emoji. */
export function filler(length: number): string {
  const alphabet = 'ặẵẳỡởựữửỵỷ0927🜂𝛑ꙮ᚛ᚙ⟁ḝǿ';
  const chars = [...alphabet];
  let seed = 738;
  let out = '';
  while ([...out].length < length) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    out += chars[seed % chars.length];
  }
  return [...out].slice(0, length).join('').slice(0, length);
}

function worstResolved(taxonomy: IntentTaxonomy): ResolvedPayload {
  const keys = (terms: { key: string }[]) => terms.map((t) => t.key);
  const every = [
    ...taxonomy.category,
    ...taxonomy.mood,
    ...taxonomy.setting,
    ...taxonomy.suitability,
  ];
  return {
    settled: {
      category: taxonomy.category[0]?.key ?? '',
      occasion: taxonomy.suitability[0]?.key ?? '',
      moods: keys(taxonomy.mood),
      settings: keys(taxonomy.setting),
      partySize: 20,
      area: filler(MAX_NAME_CHARS),
      time: { timeHint: 'saturday', dayPart: 'afternoon' },
      budget: { amount: 100_000_000, currency: 'VND', mode: 'per_person' },
    },
    assumed: {},
    open: ['category', 'preferences', 'partySize', 'area', 'time', 'budget', 'occasion'],
    labels: Object.fromEntries(every.map((t) => [t.key, t.label])),
  };
}

export type WorstCases = {
  decision: DecisionRequest;
  relevance: DecisionRequest;
  compose: ReturnType<typeof buildComposerMessages>;
  composeOutputTokens: number;
};

/** The largest request each call can make under the caps the code enforces. */
export function worstCases(taxonomy: IntentTaxonomy, composeOutputTokens: number): WorstCases {
  const resolved = worstResolved(taxonomy);
  const decision = buildAssistantDecisionRequest(
    filler(MAX_REQUEST_CHARS),
    {
      previousRequest: filler(MAX_PREVIOUS_REQUEST_CHARS),
      openedFrom: 'place',
      pending: {
        question: filler(MAX_PENDING_QUESTION_CHARS),
        latest: filler(MAX_LATEST_MESSAGE_CHARS),
      },
      resolved,
    },
    taxonomy,
  );
  const words = [...taxonomy.category, ...taxonomy.mood, ...taxonomy.setting]
    .map((t) => t.label)
    .join(', ');
  const relevance = buildRelevanceRequest(
    filler(MAX_REQUEST_CHARS),
    Array.from({ length: RELEVANCE_CANDIDATES }, (_, i) => ({
      key: `c${i + 1}`,
      description: `${filler(MAX_NAME_CHARS)} (${words})`,
    })),
    resolved,
  );
  const ctx: GroundedAnswerContext = {
    route: 'recommend_places',
    locale: 'vi',
    constraints: ['partySize', 'budget', 'time', 'area'].map((name) => ({
      name,
      value: filler(MAX_NAME_CHARS),
      origin: 'explicit' as const,
    })),
    preferences: {
      moods: taxonomy.mood.map((t) => t.label),
      settings: taxonomy.setting.map((t) => t.label),
      occasion: taxonomy.suitability[0]?.label ?? null,
    },
    places: [1, 2, 3].map((position) => ({
      position,
      placeId: `p${position}`,
      name: filler(MAX_NAME_CHARS),
      categories: taxonomy.category.map((t) => t.label),
      moods: [...taxonomy.mood, ...taxonomy.setting].map((t) => t.label),
    })),
    guide: [1, 2, 3].map((index) => ({
      index,
      title: filler(MAX_NAME_CHARS),
      heading: filler(MAX_NAME_CHARS),
      excerpt: filler(MAX_GUIDE_EXCERPT_CHARS),
    })),
    plan: null,
    pendingAction: 'create_room',
    clarification: ['budget'],
    unverifiableRequirement: true,
    conflicting: true,
  };
  const history = Array.from({ length: MAX_HISTORY_TURNS }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: filler(MAX_HISTORY_CHARS),
  }));
  return {
    decision,
    relevance,
    compose: buildComposerMessages(ctx, history, filler(MAX_MESSAGE_CHARS)),
    composeOutputTokens,
  };
}

/** Counts a request's input tokens, as the provider bills them; `null` = unknown. */
export type TokenCounter = {
  decision(request: DecisionRequest): Promise<number | null>;
  relevance(request: DecisionRequest): Promise<number | null>;
  compose(messages: WorstCases['compose']): Promise<number | null>;
};

export type CostBound = {
  ceilingUsd: number;
  calls: { decision: number; relevance: number; compose: number };
  shares: { decision: number; relevance: number; compose: number };
  tokens: { decision: number; relevance: number; compose: number; composeOutput: number };
  byokFeeUsd: number;
  marginUsd: number;
};

/** The caps the worst-case requests are built from, as the code enforces them. */
export const REQUEST_CAPS = {
  request: MAX_REQUEST_CHARS,
  pendingQuestion: MAX_PENDING_QUESTION_CHARS,
  latestMessage: MAX_LATEST_MESSAGE_CHARS,
  previousRequest: MAX_PREVIOUS_REQUEST_CHARS,
  message: MAX_MESSAGE_CHARS,
  contextName: MAX_CONTEXT_NAME_CHARS,
  guideExcerpt: MAX_GUIDE_EXCERPT_CHARS,
  historyTurns: MAX_HISTORY_TURNS,
  historyChars: MAX_HISTORY_CHARS,
  relevanceCandidates: RELEVANCE_CANDIDATES,
} as const;

/** The committed record of the run `TURN_CALL_SHARE` was taken from. */
export type Calibration = {
  models: { jev: string; haiku: string };
  pricesUsdPerToken: Prices;
  caps: Record<keyof typeof REQUEST_CAPS, number> & { outputTokens: number };
  taxonomyCounts: Record<'category' | 'mood' | 'setting' | 'suitability', number>;
  tokens: { decision: number; relevance: number; compose: number; composeOutput: number };
  ceilingUsd: number;
  shares: { decision: number; relevance: number; compose: number };
};

/** What this run was made of, in the record's shape. */
export type RunInputs = {
  models: { jev: string; haiku: string };
  prices: Prices;
  taxonomy: IntentTaxonomy;
  outputTokens: number;
};

/** Counts and money may move a little between provider runs; past this it is drift. */
const TOLERANCE = 0.02;
const off = (a: number, b: number) => Math.abs(a - b) > TOLERANCE * Math.max(Math.abs(b), 1e-12);

/**
 * Where this run disagrees with the code's shares or the committed record:
 * shares, models, prices, every cap, the taxonomy counts, the token counts and
 * `C` itself (F-11 — proportional price moves keep the shares and still
 * change the ceiling).
 */
export function calibrationDrift(
  bound: Pick<CostBound, 'shares' | 'tokens' | 'ceilingUsd'>,
  run: RunInputs,
  codeShares: { decision: number; relevance: number; compose: number },
  record: Calibration,
): string[] {
  const out: string[] = [];
  for (const call of ['decision', 'relevance', 'compose'] as const) {
    if (Math.abs(bound.shares[call] - codeShares[call]) > 0.005) {
      out.push(`share ${call}: run ${bound.shares[call]}, code ${codeShares[call]}`);
    }
    if (record.shares[call] !== codeShares[call]) {
      out.push(`share ${call}: record ${record.shares[call]}, code ${codeShares[call]}`);
    }
    if (off(bound.tokens[call], record.tokens[call])) {
      out.push(`tokens ${call}: ${bound.tokens[call]} now, ${record.tokens[call]} recorded`);
    }
  }
  for (const model of ['jev', 'haiku'] as const) {
    if (run.models[model] !== record.models[model]) {
      out.push(`model ${model}: ${run.models[model]} now, ${record.models[model]} recorded`);
    }
  }
  for (const price of ['jevIn', 'jevOut', 'haikuIn', 'haikuOut'] as const) {
    // Per-token prices are tiny quotients: compare within tolerance, not bit for bit.
    if (off(run.prices[price], record.pricesUsdPerToken[price])) {
      out.push(
        `price ${price}: ${run.prices[price]} now, ${record.pricesUsdPerToken[price]} recorded`,
      );
    }
  }
  for (const [cap, value] of Object.entries(REQUEST_CAPS) as [
    keyof typeof REQUEST_CAPS,
    number,
  ][]) {
    if (value !== record.caps[cap])
      out.push(`cap ${cap}: ${value} now, ${record.caps[cap]} recorded`);
  }
  if (run.outputTokens !== record.caps.outputTokens) {
    out.push(`output tokens: ${run.outputTokens} now, ${record.caps.outputTokens} recorded`);
  }
  for (const kind of ['category', 'mood', 'setting', 'suitability'] as const) {
    if (run.taxonomy[kind].length !== record.taxonomyCounts[kind]) {
      out.push(
        `taxonomy ${kind}: ${run.taxonomy[kind].length} now, ${record.taxonomyCounts[kind]} recorded`,
      );
    }
  }
  if (off(bound.ceilingUsd, record.ceilingUsd)) {
    out.push(`C: ${bound.ceilingUsd} now, ${record.ceilingUsd} recorded`);
  }
  return out;
}

const required = (what: string, tokens: number | null): number => {
  if (tokens === null) {
    throw new Error(`no provider token count for ${what}: failing closed, C is not set`);
  }
  return tokens;
};

/** Rounds up at the micro-dollar: a bound never rounds down. */
const up = (usd: number) => Math.ceil(usd * 1_000_000) / 1_000_000;
const share = (part: number, whole: number) => Math.round((part / whole) * 1000) / 1000;

export async function computeCostBound(
  cases: WorstCases,
  counter: TokenCounter,
  prices: Prices = PRICES,
): Promise<CostBound> {
  const decision = required('the decision call', await counter.decision(cases.decision));
  const relevance = required('the relevance call', await counter.relevance(cases.relevance));
  const compose = required('the compose call', await counter.compose(cases.compose));
  const usd = {
    decision: decision * prices.jevIn,
    relevance: relevance * prices.jevIn,
    compose: compose * prices.haikuIn + cases.composeOutputTokens * prices.haikuOut,
  };
  // Two decision calls, one relevance, one compose (ADR-0036 §7 amendment).
  const sum = 2 * usd.decision + usd.relevance + usd.compose;
  const marginUsd = sum * MARGIN;
  const byokFeeUsd = usd.compose * BYOK_FEE;
  if (byokFeeUsd > marginUsd) throw new Error('the BYOK fee does not fit inside the margin');
  return {
    ceilingUsd: up(sum + marginUsd),
    calls: usd,
    shares: {
      decision: share(usd.decision, sum),
      relevance: share(usd.relevance, sum),
      compose: share(usd.compose, sum),
    },
    tokens: { decision, relevance, compose, composeOutput: cases.composeOutputTokens },
    byokFeeUsd,
    marginUsd,
  };
}
