import { withResilience } from './resilience';
import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
} from './ports';

/**
 * GoGo-BE#709 — decision models behind a port.
 *
 * A decision model reads state and answers typed questions with
 * probabilities, never text: `noul` (P(yes)), `choice` (one option of a set),
 * `score` (position on ordered levels). The shapes are the OpenRouter
 * Decisions API (`POST /api/alpha/decisions`) as documented by OpenRouter's
 * own reference (`OpenRouterTeam/skills`, `openrouter-decisions`, read
 * 2026-10-22) — any model on that API answers them, so callers name no vendor.
 *
 * Nothing here is ever a fact about a place (core rule #8): price, hours,
 * availability and location stay verified data. This port only answers
 * judgments about what a person typed.
 *
 * Kept apart from the AI Harness (GoGo-Infra#241) on purpose: no shared code,
 * its own key (`OPENROUTER_API_KEY` from a `backend` row, never the harness's
 * `ci` row), its own budget line. Nothing on a request path can reach a
 * development agent.
 */

export type DecisionCriterion =
  string | number | boolean | null | DecisionCriterion[] | { [key: string]: DecisionCriterion };

export type DecisionQuestion =
  | {
      type: 'noul';
      instructions: DecisionCriterion;
      criteria?: { true: DecisionCriterion; false: DecisionCriterion };
    }
  | { type: 'choice'; instructions: DecisionCriterion; criteria: Record<string, DecisionCriterion> }
  | { type: 'score'; instructions: DecisionCriterion; criteria: DecisionCriterion[] };

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice';
      choice: string;
      /** Optional in the API schema; absent stays absent, never filled in. */
      probabilities?: Record<string, number>;
      /** Concentration of the distribution — not correctness. */
      confidence?: number;
    }
  | {
      type: 'score';
      score: number;
      probabilities?: Record<string, number>;
      confidence?: number;
    };

export type DecisionRequest = {
  state: DecisionCriterion;
  questions: Record<string, DecisionQuestion>;
};

export type DecisionResponse = {
  answers: Record<string, DecisionAnswer>;
  /** The exact build that answered — logged with every stored answer. */
  model: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    /** USD as reported. `null` = not reported, never 0. */
    costUsd: number | null;
  };
};

export interface DecisionProviderPort {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

export const DECISION_PROVIDER = Symbol('DECISION_PROVIDER');

/** A response that does not answer the questions that were asked. */
export class DecisionContractError extends Error {
  constructor(detail: string) {
    super(`decision response rejected: ${detail}`);
    this.name = 'DecisionContractError';
  }
}

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** CLAUDE.md: an AI call times out at ≤ 15 s and falls back. */
export const MAX_DECISION_TIMEOUT_MS = 15_000;

export type OpenRouterDecisionOptions = {
  apiKey: string;
  /** Pinned id (`typesafe/jev-1.14`) or dated slug. Aliases (`~…`) are refused. */
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export class OpenRouterDecisionProvider implements DecisionProviderPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterDecisionOptions) {
    if (options.model.startsWith('~') || !options.model.includes('/')) {
      throw new Error('decision model must be a pinned versioned id, never an alias');
    }
    if (options.timeoutMs <= 0 || options.timeoutMs > MAX_DECISION_TIMEOUT_MS) {
      throw new Error(`decision timeout must be 1…${MAX_DECISION_TIMEOUT_MS} ms`);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    if (!this.options.apiKey) {
      throw new ProviderConfigurationError('openrouter', 'MISSING_CREDENTIAL');
    }
    // No retries: every attempt is billed per input token, and a caller with a
    // deterministic fallback is better served by falling back than by waiting.
    return withResilience(
      {
        name: 'openrouter.decisions',
        timeoutMs: this.options.timeoutMs,
        retries: 0,
        breakerThreshold: 5,
        breakerCooldownMs: 30_000,
      },
      (signal) => this.send(request, signal),
    );
  }

  private async send(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse> {
    const res = await this.fetchImpl(OPENROUTER_DECISIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        state: request.state,
        questions: request.questions,
      }),
      signal,
    });
    if (!res.ok) {
      // OpenRouter's general error table; the Decisions page could not be read
      // when this was written, so an unlisted 4xx is an invalid request.
      if (res.status === 401 || res.status === 403) {
        throw new ProviderConfigurationError('openrouter', 'AUTH_FAILED', `HTTP ${res.status}`);
      }
      // Out of credits is a budget decision, not an outage: withResilience
      // passes it through without retry or breaker count.
      if (res.status === 402) throw new ProviderQuotaExceededError('openrouter');
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new ProviderInvalidRequestError('openrouter', `HTTP_${res.status}`);
      }
      throw new Error(`openrouter decisions HTTP ${res.status}`);
    }
    return parseDecisionResponse(request, await res.json());
  }
}

/**
 * Validate a response against the request that produced it: every question
 * answered, nothing else, each answer of the asked type, a choice among the
 * options, every probability in [0, 1]. A response that fails is rejected
 * whole — a partly-right answer is not something a caller can act on.
 */
export function parseDecisionResponse(request: DecisionRequest, raw: unknown): DecisionResponse {
  if (!isRecord(raw)) throw new DecisionContractError('not an object');
  if (typeof raw.model !== 'string') throw new DecisionContractError('no model');
  const answers = raw.answers;
  if (!isRecord(answers)) throw new DecisionContractError('no answers');
  const keys = Object.keys(request.questions);
  if (keys.length !== Object.keys(answers).length || keys.some((k) => !(k in answers))) {
    throw new DecisionContractError('answers do not match the questions');
  }

  const parsed: Record<string, DecisionAnswer> = {};
  for (const key of keys) {
    const q = request.questions[key]!;
    const a = answers[key];
    if (!isRecord(a) || a.type !== q.type) throw new DecisionContractError(`${key}: wrong type`);
    if (q.type === 'noul') {
      parsed[key] = { type: 'noul', noul: unit(key, a.noul) };
    } else if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !(a.choice in q.criteria)) {
        throw new DecisionContractError(`${key}: choice is not an option`);
      }
      parsed[key] = {
        type: 'choice',
        choice: a.choice,
        ...optionalDistribution(key, Object.keys(q.criteria), a.probabilities),
        ...optionalConfidence(key, a.confidence),
      };
    } else {
      const score = a.score;
      if (typeof score !== 'number' || score < 0 || score > q.criteria.length - 1) {
        throw new DecisionContractError(`${key}: score outside the levels`);
      }
      parsed[key] = {
        type: 'score',
        score,
        ...optionalDistribution(
          key,
          q.criteria.map((_, i) => String(i)),
          a.probabilities,
        ),
        ...optionalConfidence(key, a.confidence),
      };
    }
  }

  const usage = isRecord(raw.usage) ? raw.usage : {};
  return {
    answers: parsed,
    model: raw.model,
    usage: {
      inputTokens: nonNegative(usage.input_tokens),
      outputTokens: nonNegative(usage.output_tokens),
      costUsd: nonNegative(usage.cost),
    },
  };
}

function optionalDistribution(
  key: string,
  options: string[],
  value: unknown,
): { probabilities?: Record<string, number> } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).length !== options.length) {
    throw new DecisionContractError(`${key}: probabilities do not match the options`);
  }
  const out: Record<string, number> = {};
  for (const option of options) out[option] = unit(key, value[option]);
  return { probabilities: out };
}

function optionalConfidence(key: string, value: unknown): { confidence?: number } {
  return value === undefined || value === null ? {} : { confidence: unit(key, value) };
}

function unit(key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionContractError(`${key}: probability outside [0, 1]`);
  }
  return value;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Test and DEV double: answers from a function, records what it was asked. */
export class FakeDecisionProvider implements DecisionProviderPort {
  readonly requests: DecisionRequest[] = [];

  constructor(
    private readonly answer: (request: DecisionRequest) => unknown | Promise<unknown>,
    private readonly model = 'fake/decision-fixture',
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    this.requests.push(request);
    const answers = await this.answer(request);
    return parseDecisionResponse(request, {
      model: this.model,
      answers,
      usage: {},
    });
  }
}
