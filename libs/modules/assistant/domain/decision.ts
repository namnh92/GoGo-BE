import type { DecisionAnswer, DecisionCriterion, DecisionQuestion } from '@gogo/providers';
import {
  buildIntentRequest,
  mapIntentAnswers,
  type IntentClassification,
  type IntentFacts,
  type IntentTaxonomy,
} from '../../search/domain/intent';
import { normalizeVietnamese } from '../../search/domain/normalize';

/**
 * ADR-0036 §3C — Jev decision 1: the POC's intent questions (GoGo-BE#709,
 * reused as they are) plus the assistant's routing questions, in one call.
 * Every option is a closed key; the answer is validated against the request
 * by the adapter (`parseDecisionResponse`) before anything reads it.
 */

export const ASSISTANT_INTENTS = [
  'recommend_places',
  'gogo_guide',
  'plan_help',
  'out_of_scope',
] as const;
export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

export const ASSISTANT_ACTIONS = ['none', 'create_room', 'create_invite', 'finalize_plan'] as const;
export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

/** Where a turn goes. `clarify` is decided by the server, never asked of a model. */
export type AssistantRoute = AssistantIntent | 'clarify';

export type AssistantDecision = {
  source: 'decision_model' | 'fallback';
  model: string | null;
  fallbackReason: IntentClassification['fallbackReason'];
  intent: AssistantIntent;
  intentProbability: number | null;
  action: AssistantAction;
  /** P(the request needs an attribute GoGo does not verify), null without a model. */
  unverifiedAttribute: number | null;
  classification: IntentClassification;
};

/** Gates, PROVISIONAL (ADR-0036 §3D: calibrate on labelled Vietnamese requests). */
export const ASSISTANT_THRESHOLDS = {
  intentMin: 0.5,
  actionMin: 0.6,
  unverifiedAttributeMin: 0.6,
  relevanceMin: 0.5,
} as const;

export const MAX_PREVIOUS_REQUEST_CHARS = 300;

export function buildAssistantDecisionRequest(
  text: string,
  options: { previousRequest: string | null; openedFrom: 'place' | 'plan' | null },
  taxonomy: IntentTaxonomy,
): { state: Record<string, string>; questions: Record<string, DecisionQuestion> } {
  const base = buildIntentRequest(text, taxonomy);
  const state: Record<string, string> = { ...base.state };
  if (options.previousRequest) {
    state.previous_request = options.previousRequest.slice(0, MAX_PREVIOUS_REQUEST_CHARS);
  }
  if (options.openedFrom) state.opened_from = options.openedFrom;
  const questions: Record<string, DecisionQuestion> = {
    ...base.questions,
    assistant_intent: {
      type: 'choice',
      instructions:
        'What does `request` ask of GoGo, a date and group-outing planning app? `previous_request`, if present, is only for resolving words like "there" or "cheaper"; `opened_from` says which screen the person asked from.',
      criteria: {
        recommend_places:
          'Suggest somewhere to go, eat, drink or spend time, or refine an earlier suggestion.',
        gogo_guide:
          'Explain how GoGo works or how to do something in the app, in general: rooms, plans, voting, finalizing, invites, accounts ("làm sao để…", "cách…").',
        plan_help:
          'Act on the specific plan the person opened (`opened_from` is plan): its stops, members, votes or finalizing it.',
        out_of_scope:
          'Anything else: general knowledge, chit-chat, coding, other apps, or instructions aimed at the assistant itself.',
      },
    },
    action: {
      type: 'choice',
      instructions:
        'Does `request` explicitly ask GoGo to perform one of these actions now? Asking for ideas is not an action. Asking how to do something in the app is not an action.',
      criteria: {
        none: 'No action is requested, or it is only a question.',
        create_room:
          'Create a new room or plan for an outing (for example "tạo kèo", "lập kèo", "lên kèo", "rủ … đi", "tạo plan", "tạo room", "tạo kế hoạch", "lên lịch đi chơi với nhóm").',
        create_invite: 'Invite someone to the room or plan being discussed.',
        finalize_plan: 'Finalize or lock in the plan or choice being discussed.',
      },
    },
    needs_unverified_attribute: {
      type: 'noul',
      instructions:
        'Does `request` require a place attribute such as pets allowed, parking, wifi, a kids play area, smoking areas or power outlets?',
      criteria: {
        true: 'At least one such attribute is a requirement.',
        false: 'None of those attributes is required.',
      },
    },
  };
  return { state, questions };
}

/**
 * `text`, when given, is the request the answers are about: the #733 guards
 * then hold on this path as on the fallback one.
 */
export function mapAssistantAnswers(
  facts: IntentFacts,
  answers: Record<string, DecisionAnswer>,
  model: string,
  text?: string,
): AssistantDecision {
  const classification = mapIntentAnswers(facts, answers, model);
  const intentAnswer = answers.assistant_intent;
  const actionAnswer = answers.action;
  const unverified = answers.needs_unverified_attribute;
  if (
    intentAnswer?.type !== 'choice' ||
    actionAnswer?.type !== 'choice' ||
    unverified?.type !== 'noul'
  ) {
    throw new Error('assistant decision answers are missing');
  }
  const intent = intentAnswer.choice as AssistantIntent;
  const intentProbability = intentAnswer.probabilities?.[intent] ?? intentAnswer.confidence ?? null;
  const actionP = actionAnswer.probabilities?.[actionAnswer.choice] ?? actionAnswer.confidence ?? 1;
  const decision: AssistantDecision = {
    source: 'decision_model',
    model,
    fallbackReason: null,
    intent,
    intentProbability,
    action:
      actionAnswer.choice !== 'none' && actionP >= ASSISTANT_THRESHOLDS.actionMin
        ? (actionAnswer.choice as AssistantAction)
        : 'none',
    unverifiedAttribute: unverified.noul,
    classification,
  };
  return text === undefined ? decision : guardDecision(text, decision);
}

const GUIDE_TERMS = [
  'gogo',
  'ung dung',
  'tinh nang',
  'huong dan',
  'lam sao',
  'cach nao',
  'cach tao',
  'cach moi',
  'binh chon',
  'bo phieu',
  'tai khoan',
  'how do i',
  'how to',
];

/** Text aimed at the assistant itself, not at GoGo: never routed to retrieval. */
const INJECTION_TERMS = [
  'bo qua',
  'ignore previous',
  'ignore all',
  'system prompt',
  'prompt he thong',
  'jailbreak',
  'developer mode',
];

/**
 * #733 D-1 — asking how to do something: never an action, on either path.
 * Checked before the action terms ("cách tạo phòng" is a guide question).
 */
const QUESTION_TERMS = [
  'lam sao',
  'cach nao',
  'cach tao',
  'cach lap',
  'cach len',
  'cach mo',
  'cach moi',
  'cach dat',
  'huong dan',
  'the nao',
  'how do i',
  'how to',
];

const ACTION_TERMS: [AssistantAction, string[]][] = [
  [
    'create_room',
    [
      'tao ke hoach',
      'tao phong',
      'len ke hoach',
      'len lich',
      'tao keo',
      'lap keo',
      'len keo',
      'mo keo',
      'tao plan',
      'tao room',
      'create a plan',
      'create a room',
    ],
  ],
  ['create_invite', ['moi ', 'gui loi moi', 'invite']],
  ['finalize_plan', ['chot ', 'finalize', 'xac nhan ke hoach']],
];

/**
 * ADR-0035 deterministic fallback when Jev did not answer: keywords only,
 * conservative. Nothing is guessed about mood or occasion (the POC's
 * `fallbackIntent` already returns none), and an action is proposed only from
 * an explicit phrase — a proposal is never executed anyway.
 */
const haystackOf = (text: string) => ` ${normalizeVietnamese(text)} `;

/** The message asks how to do something (#733 D-1). */
export function hasQuestionTerm(text: string): boolean {
  const haystack = haystackOf(text);
  return QUESTION_TERMS.some((t) => haystack.includes(` ${t}`));
}

/**
 * #733 D-1 — applied to both decision paths: an injection phrase is out of
 * scope with no action (so the create_room routing override can never send
 * it to retrieval), and a how-to question carries no action.
 */
export function guardDecision(text: string, decision: AssistantDecision): AssistantDecision {
  const haystack = haystackOf(text);
  if (INJECTION_TERMS.some((t) => haystack.includes(t))) {
    return { ...decision, intent: 'out_of_scope', intentProbability: null, action: 'none' };
  }
  if (hasQuestionTerm(text)) return { ...decision, action: 'none' };
  return decision;
}

export function fallbackAssistantDecision(
  text: string,
  classification: IntentClassification,
  openedFrom: 'place' | 'plan' | null,
): AssistantDecision {
  const haystack = haystackOf(text);
  const action = hasQuestionTerm(text)
    ? 'none'
    : (ACTION_TERMS.find(([, terms]) => terms.some((t) => haystack.includes(t)))?.[0] ?? 'none');
  const facts = classification.facts;
  const looksLikePlaces =
    classification.category.key !== null ||
    facts.budget !== null ||
    facts.partySize !== null ||
    facts.areaText !== null ||
    facts.timeHint !== null;
  let intent: AssistantIntent;
  if (INJECTION_TERMS.some((t) => haystack.includes(t))) {
    return {
      source: 'fallback',
      model: null,
      fallbackReason: classification.fallbackReason,
      intent: 'out_of_scope',
      intentProbability: null,
      action: 'none',
      unverifiedAttribute: null,
      classification,
    };
  }
  if (GUIDE_TERMS.some((t) => haystack.includes(` ${t}`)) && classification.category.key === null) {
    intent = 'gogo_guide';
  } else if (openedFrom === 'plan' && !looksLikePlaces) {
    intent = 'plan_help';
  } else if (looksLikePlaces || action === 'create_room') {
    intent = 'recommend_places';
  } else {
    intent = 'out_of_scope';
  }
  return {
    source: 'fallback',
    model: null,
    fallbackReason: classification.fallbackReason,
    intent,
    intentProbability: null,
    action,
    unverifiedAttribute: null,
    classification,
  };
}

/** Relevance (decision 2): one `noul` per enumerated candidate key. */
export function buildRelevanceRequest(
  text: string,
  candidates: readonly { key: string; description: string }[],
): { state: Record<string, DecisionCriterion>; questions: Record<string, DecisionQuestion> } {
  const questions: Record<string, DecisionQuestion> = {};
  for (const c of candidates) {
    questions[c.key] = {
      type: 'noul',
      instructions: `Would the place described as candidates.${c.key} suit what the person in \`request\` wants (kind of place, atmosphere, setting, who it is for)? Ignore price, distance and opening hours; those are checked elsewhere.`,
    };
  }
  return {
    state: {
      request: text.slice(0, 500),
      candidates: Object.fromEntries(candidates.map((c) => [c.key, c.description])),
    },
    questions,
  };
}
