import type { DecisionAnswer, DecisionQuestion } from '@gogo/providers';
import { normalizeVietnamese } from './normalize';

/**
 * GoGo-BE#709 — Vietnamese intent classification, DEV POC.
 *
 * "Tối nay 4 người đi ăn lẩu khoảng 300k/người, gần Cầu Giấy, ưu tiên quán
 * yên tĩnh." splits in two:
 *
 * - **Facts code can read** — party size, budget (integer VND, `per_person`
 *   or `total`), a time hint, the area phrase as typed. Parsed here,
 *   deterministically, and never asked of a model: a decision model cannot
 *   do arithmetic, compare amounts or read dates reliably, and a value code
 *   already holds is never re-asked. The area is the text only; resolving it
 *   to an administrative unit is the administrative module's job, not this
 *   one's and not a model's.
 * - **Judgments** — is this a request for somewhere to go, what kind of
 *   place, who it is for, which atmosphere and setting, does a planner need
 *   to ask first. Those go to the decision port as `choice`/`noul`
 *   questions whose options are the taxonomy's stable keys, passed in by the
 *   caller — nothing here names a taxonomy key.
 *
 * Output is facts, not sentences (CLAUDE.md): keys, probabilities as
 * returned, flags. Nothing about a place — price, hours, location — ever
 * comes from this file.
 */

export type IntentTaxonomyTerm = { key: string; label: string };

export type IntentTaxonomy = {
  category: IntentTaxonomyTerm[];
  mood: IntentTaxonomyTerm[];
  setting: IntentTaxonomyTerm[];
  /** Who the outing is for (`suitability` kind). */
  suitability: IntentTaxonomyTerm[];
  /** Category key → search synonyms (`taxonomy_synonyms`), for the fallback only. */
  categorySynonyms?: Record<string, string[]>;
};

/** `saturday`/`sunday` name the day; `weekend` names neither (#733). */
export type TimeHint = 'now' | 'tonight' | 'today' | 'tomorrow' | 'saturday' | 'sunday' | 'weekend';

/** A part of the day said next to a day ("thứ 7 tối"), for an exact start (#733 Q-2). */
export type DayPart = 'morning' | 'noon' | 'afternoon' | 'evening';

export type IntentFacts = {
  partySize: number | null;
  /** Integer VND (ISO 4217 exponent 0: the đồng is the minor unit). `mode` null = not stated. */
  budget: { amount: number; currency: 'VND'; mode: 'per_person' | 'total' | null } | null;
  timeHint: TimeHint | null;
  /** The area as typed — unresolved, unvalidated. */
  areaText: string | null;
};

export type ClarificationReason =
  'empty_request' | 'out_of_scope' | 'unclear_activity' | 'conflicting_preferences';

export type IntentFallbackReason =
  'disabled' | 'empty_request' | 'timeout' | 'quota' | 'provider_error' | 'invalid_response';

export type ScoredKey = { key: string; probability: number };

export type IntentClassification = {
  source: 'decision_model' | 'fallback';
  /** Exact build that answered; null for the fallback. */
  model: string | null;
  fallbackReason: IntentFallbackReason | null;
  facts: IntentFacts;
  /** `probability` null when no model answered. */
  inScope: { value: boolean; probability: number | null };
  category: {
    key: string | null;
    probabilities?: Record<string, number>;
    confidence?: number;
  };
  occasion: {
    key: string | null;
    probabilities?: Record<string, number>;
    confidence?: number;
  };
  /** Labels at or above the gate, most probable first. Several may hold. */
  moods: ScoredKey[];
  settings: ScoredKey[];
  clarification: { needed: boolean; reasons: ClarificationReason[] };
};

/**
 * Gates on model answers. PROVISIONAL: the official starting point (a noul
 * gate at 0.5) — not probed on Vietnamese GoGo queries. The live eval
 * (`pnpm eval:intent`, authorized runs only) sets them from observed numbers.
 * A wrong gate here costs a weaker filter or one clarifying question, never a
 * wrong place fact.
 */
export const INTENT_THRESHOLDS = {
  /** Below this P(in scope) the request is treated as out of scope. */
  inScopeMin: 0.5,
  /** A mood/setting label counts at or above this. */
  preferenceMin: 0.5,
  /** At or above this P(needs clarification) the caller should ask. */
  clarificationMin: 0.5,
  /** At or above this P(conflicting wishes) the caller should ask. */
  conflictMin: 0.5,
} as const;

/** Longest request sent to the model; longer text is cut, not summarised. */
export const MAX_REQUEST_CHARS = 500;
const NONE = 'none';
const NOT_STATED = 'not_stated';

// ── Deterministic facts ──────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  một: 1,
  hai: 2,
  ba: 3,
  bốn: 4,
  tư: 4,
  năm: 5,
  sáu: 6,
  bảy: 7,
  tám: 8,
  chín: 9,
  mười: 10,
};

/** Multipliers for amount units, including spoken slang (lít / xị = 100k, củ = 1 triệu). */
const UNIT: Record<string, number> = {
  k: 1_000,
  nghìn: 1_000,
  ngàn: 1_000,
  lít: 100_000,
  xị: 100_000,
  củ: 1_000_000,
  tr: 1_000_000,
  triệu: 1_000_000,
};

const END = '(?=$|[^\\p{L}\\p{N}])';
const AMOUNT_UNIT = `(k|nghìn|ngàn|lít|xị|củ|triệu|tr)${END}`;
const PER_PERSON_AFTER =
  /^\s*(?:\/\s*(?:1\s*)?(?:người|ng|pax|suất|mạng)|(?:một|1|mỗi|cho mỗi|trên)\s*(?:người|ng|mạng|suất)|(?:đầu|mỗi)\s*người)/u;
const PER_PERSON_BEFORE =
  /(?:mỗi người|mỗi đứa|một người|1 người|đầu người|mỗi ng)\s*(?:khoảng|tầm|cỡ|chừng|dưới|tối đa)?\s*$/u;
const TOTAL_NEAR = /(?:tổng|cả nhóm|cả bàn|tất cả|cả hội|chung|cho cả)/u;
const FOR_PARTY_AFTER =
  /^\s*cho\s+(\d{1,2}|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)\s*(?:người|đứa|ng)(?=$|[^\p{L}])/u;

function partyWord(word: string): number {
  return /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? 0);
}

export function parseIntentFacts(input: string): IntentFacts {
  const text = input.normalize('NFC').toLowerCase();
  const budget = parseBudget(text);
  // The budget phrase is removed before counting people, so "300k/1 người"
  // or "khoảng 300k một người" cannot read as a party of one.
  const rest = budget ? text.slice(0, budget.start) + ' ' + text.slice(budget.end) : text;
  return {
    partySize: parsePartySize(rest),
    budget: budget ? budget.value : null,
    timeHint: parseTimeHint(text, input.normalize('NFC')),
    areaText: parseAreaText(input.normalize('NFC')),
  };
}

type Located<T> = { value: T; start: number; end: number };

function parseBudget(text: string): Located<NonNullable<IntentFacts['budget']>> | null {
  const patterns: Array<[RegExp, (m: RegExpExecArray) => number]> = [
    // "1tr2", "1 củ 5" — a million and a tenth-part digit. A spaced digit
    // that counts people ("1tr 2 người") is the party, not the tenths.
    [
      new RegExp(`(\\d+)\\s*(tr|củ)(?:(\\d)|\\s+(\\d)(?!\\s*${PARTY_NOUN}${END}))${END}`, 'u'),
      (m) => Number(m[1]) * 1_000_000 + Number(m[3] ?? m[4]) * 100_000,
    ],
    // "200-300k", "200 đến 300 nghìn" — the upper bound is the budget.
    [
      new RegExp(
        `(\\d+(?:[.,]\\d+)?)\\s*(?:-|–|~|đến|tới)\\s*(\\d+(?:[.,]\\d+)?)\\s*${AMOUNT_UNIT}`,
        'u',
      ),
      (m) => toAmount(m[2]!, m[3]!),
    ],
    // "300k", "1,5 triệu", "2 lít", "1 triệu rưỡi"
    [
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${AMOUNT_UNIT}(\\s*rưỡi)?`, 'u'),
      (m) => toAmount(m[1]!, m[2]!) + (m[3] ? UNIT[m[2]!]! / 2 : 0),
    ],
    // "300.000đ", "1,200,000 đồng", "500000 vnd"
    [
      /(\d{1,3}(?:[.,]\d{3})+|\d{5,})\s*(?:đ|đồng|vnd|vnđ)?(?=$|[^\p{L}\p{N}])/u,
      (m) => Number(m[1]!.replace(/[.,]/g, '')),
    ],
  ];
  for (const [pattern, amountOf] of patterns) {
    const m = pattern.exec(text);
    if (!m) continue;
    const amount = Math.round(amountOf(m));
    if (!Number.isFinite(amount) || amount < 1_000) continue;
    let end = m.index + m[0].length;
    const after = PER_PERSON_AFTER.exec(text.slice(end));
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    let mode: 'per_person' | 'total' | null = null;
    const forN = FOR_PARTY_AFTER.exec(text.slice(end));
    if (after) {
      mode = 'per_person';
      end += after[0].length;
    } else if (forN) {
      // "2 triệu cho 2 người" is the total for two; "cho 1 người" is per head.
      // The span is not consumed: the party size is read from it.
      mode = partyWord(forN[1]!) >= 2 ? 'total' : 'per_person';
    } else if (PER_PERSON_BEFORE.test(before)) {
      mode = 'per_person';
    } else if (TOTAL_NEAR.test(before) || TOTAL_NEAR.test(text.slice(end, end + 16))) {
      mode = 'total';
    }
    return { value: { amount, currency: 'VND', mode }, start: m.index, end };
  }
  return null;
}

function toAmount(number: string, unit: string): number {
  return Number(number.replace(',', '.')) * UNIT[unit]!;
}

// Not `ông`/`bà`: "Hai Bà Trưng" is a district, not two grandmothers.
const PARTY_NOUN = '(?:người|ng|đứa|bạn|mạng|thằng|anh em|chị em|đứa bạn|people)';

function parsePartySize(text: string): number | null {
  const digits = new RegExp(`(?<![\\d/.,])(\\d{1,2})\\s*${PARTY_NOUN}${END}`, 'u').exec(text);
  if (digits) return Number(digits[1]);
  const words = new RegExp(
    `(?:^|[^\\p{L}])(${Object.keys(NUMBER_WORDS).join('|')})\\s+${PARTY_NOUN}${END}`,
    'u',
  ).exec(text);
  if (words) return NUMBER_WORDS[words[1]!]!;
  const group = /(?:nhóm|hội|team|bàn)\s+(\d{1,2})(?=$|[^\p{N}])/u.exec(text);
  if (group) return Number(group[1]);
  if (/(?:^|[^\p{L}])một mình(?=$|[^\p{L}])/u.test(text)) return 1;
  if (
    /(?:cặp đôi|vợ chồng|hai đứa mình|2 đứa mình|với (?:người yêu|ny|bạn gái|bạn trai|crush|vợ|chồng|bồ))(?=$|[^\p{L}])/u.test(
      text,
    )
  ) {
    return 2;
  }
  return null;
}

const TIME_RULES: Array<[RegExp, TimeHint]> = [
  [/(?:tối nay|đêm nay|tối hôm nay|(?:^|[^\p{L}])tonight(?=$|[^\p{L}]))/u, 'tonight'],
  [
    /(?:ngày mai|tối mai|trưa mai|sáng mai|chiều mai|(?:^|[^\p{L}])tomorrow(?=$|[^\p{L}]))/u,
    'tomorrow',
  ],
  // The day before the weekend: "thứ 7" is a day the person named (#733).
  [/(?:thứ 7|thứ bảy|(?:^|[^\p{L}])saturday(?=$|[^\p{L}]))/u, 'saturday'],
  [/(?:chủ nhật|(?:^|\s)cn(?=\s|$)|(?:^|[^\p{L}])sunday(?=$|[^\p{L}]))/u, 'sunday'],
  [/(?:cuối tuần|(?:^|[^\p{L}])weekend(?=$|[^\p{L}]))/u, 'weekend'],
  [/(?:hôm nay|trưa nay|chiều nay|sáng nay|bữa nay)/u, 'today'],
  [/(?:bây giờ|giờ luôn|ngay bây giờ|ngay lúc này|liền luôn|đi liền)/u, 'now'],
];

function parseTimeHint(text: string, input: string): TimeHint | null {
  for (const [pattern, hint] of TIME_RULES) {
    if (pattern.test(text)) return hint;
    if (hint === 'tomorrow' && hasBareMai(input)) return hint;
  }
  return null;
}

const DAY_PART_WORDS: Record<string, DayPart> = {
  sáng: 'morning',
  trưa: 'noon',
  chiều: 'afternoon',
  tối: 'evening',
  morning: 'morning',
  noon: 'noon',
  afternoon: 'afternoon',
  evening: 'evening',
};
const DAY_WORD = '(?:thứ 7|thứ bảy|chủ nhật|cn|saturday|sunday)';
const PART_WORD = '(sáng|trưa|chiều|tối|morning|noon|afternoon|evening)';

/**
 * #733 Q-2 — the part of the day, only when it is said right next to a named
 * day ("thứ 7 tối", "tối thứ 7", "Saturday evening"): a meal ("ăn tối"), a
 * mood ("sáng sủa") or "tối đa" is not an hour. Today and tomorrow keep their
 * own hints and are not read here.
 */
export function parseDayPart(input: string): DayPart | null {
  const text = input.normalize('NFC').toLowerCase();
  const after = new RegExp(`${DAY_WORD}\\s+${PART_WORD}(?=$|[^\\p{L}])`, 'u').exec(text);
  const before = new RegExp(
    // "ăn tối thứ 7" is a meal on a day, not an hour.
    `(?:^|[^\\p{L}])(?<!(?:ăn|bữa)\\s)${PART_WORD}\\s+${DAY_WORD}(?=$|[^\\p{L}\\p{N}])`,
    'u',
  ).exec(text);
  const word = after?.[1] ?? before?.[1];
  return word ? (DAY_PART_WORDS[word] ?? null) : null;
}

/**
 * A bare "mai" is tomorrow only as typed in lowercase, or capitalised at the
 * start of a sentence and not followed by another name. "Hoàng Mai", "Bạch
 * Mai", "Mai Dịch" are places — the same trap as "Hai Bà Trưng", and "Hoàng
 * Mai đi đâu" is still a place. Known gaps: a place name typed in lowercase
 * still reads as tomorrow (names are left to the resolver), and an all-caps
 * "MAI" never does.
 */
function hasBareMai(input: string): boolean {
  for (const m of input.matchAll(/(?<=^|[^\p{L}])mai(?=$|[^\p{L}])/giu)) {
    if (m[0] === 'mai') return true;
    const before = input.slice(0, m.index);
    const after = input.slice(m.index + m[0].length);
    if (/(?:^|[.!?])\s*$/u.test(before) && !/^\s+\p{Lu}/u.test(after)) return true;
  }
  return false;
}

/**
 * The area after a locative word, as typed. Only a capitalised name or a
 * numbered district counts: "gần nhà" is about an origin, not an area, and a
 * lowercase place name is left for the administrative resolver rather than
 * guessed at here.
 */
function parseAreaText(input: string): string | null {
  // Only the first letter is folded, so a sentence-initial "Gần …" reads as
  // the locative it is while every capitalised name after it stays a name.
  const text = input.charAt(0).toLowerCase() + input.slice(1);
  const m =
    /(?:^|[^\p{L}])(?:gần|ở|quanh|khu vực|khu|tại|bên|phía|quanh quanh)\s+((?:quận|q\.?)\s*\d{1,2}|\p{Lu}[\p{L}]*(?:\s+(?:\p{Lu}[\p{L}]*|\d{1,2}))*)/u.exec(
      text,
    );
  if (m) return m[1]!.trim();
  // A numbered district is unambiguous wherever it appears.
  const district = /(?:^|[^\p{L}])((?:[Qq]uận|Q\.)\s*\d{1,2})(?=$|[^\p{N}])/u.exec(text);
  return district ? district[1]!.trim() : null;
}

// ── Judgments ────────────────────────────────────────────────────────────────

/**
 * The CMS-owned labels Jev reads, as data (GoGo-BE#737): kind → taxonomy key →
 * label. Question texts only point at a record (`taxonomy.mood.chill`), so a
 * label is never part of an instruction and a quote in one ends nothing.
 */
export type IntentStateTaxonomy = Record<
  'category' | 'occasion' | 'mood' | 'setting',
  Record<string, string>
>;

export function buildIntentRequest(
  text: string,
  taxonomy: IntentTaxonomy,
): {
  state: { request: string; taxonomy: IntentStateTaxonomy };
  questions: Record<string, DecisionQuestion>;
} {
  const labels = (terms: IntentTaxonomyTerm[]) =>
    Object.fromEntries(terms.map((t) => [t.key, t.label]));
  const stateTaxonomy: IntentStateTaxonomy = {
    category: labels(taxonomy.category),
    occasion: labels(taxonomy.suitability),
    mood: labels(taxonomy.mood),
    setting: labels(taxonomy.setting),
  };
  const options = (kind: keyof IntentStateTaxonomy, terms: IntentTaxonomyTerm[]) =>
    Object.fromEntries(
      terms.map((t) => [t.key, `The one named in \`taxonomy.${kind}.${t.key}\`.`]),
    );
  const questions: Record<string, DecisionQuestion> = {
    in_scope: {
      type: 'noul',
      instructions:
        'Is `request` asking for somewhere to go or something to do — eating, drinking, an outing, a date or a group activity — that a place-planning app could answer?',
      criteria: {
        true: 'The person wants a place or an outing suggested, even if details are missing.',
        false:
          'The person wants something else: a fact, a product, a service, a chat, or nothing at all.',
      },
    },
    category: {
      type: 'choice',
      instructions:
        'Which kind of place does `request` most want? A dish or drink implies the kind of place that serves it.',
      criteria: {
        ...options('category', taxonomy.category),
        [NONE]: 'No listed kind fits, or the request does not say what kind of place.',
      },
    },
    occasion: {
      type: 'choice',
      instructions: 'Who is the outing in `request` for?',
      criteria: {
        ...options('occasion', taxonomy.suitability),
        [NOT_STATED]: 'The request does not say or imply who is going.',
      },
    },
    needs_clarification: {
      type: 'noul',
      instructions:
        'Would a planner have to ask the person something before suggesting anywhere, because `request` does not say what kind of outing they want?',
      criteria: {
        true: 'What to do or what kind of place cannot be told from the request.',
        false:
          'A planner can suggest places now; a missing budget, time or area can be filled with defaults.',
      },
    },
    conflicting: {
      type: 'noul',
      instructions: 'Does `request` contain wishes that one place cannot satisfy together?',
      criteria: {
        true: 'At least two wishes contradict each other, e.g. quiet and lively, or indoor and outdoor.',
        false: 'The wishes can all hold at one place.',
      },
    },
  };
  for (const term of taxonomy.mood) {
    questions[`mood:${term.key}`] = {
      type: 'noul',
      instructions: `Does the person in \`request\` want a place whose atmosphere is the one named in \`taxonomy.mood.${term.key}\`?`,
    };
  }
  for (const term of taxonomy.setting) {
    questions[`setting:${term.key}`] = {
      type: 'noul',
      instructions: `Does the person in \`request\` want a place that is the one named in \`taxonomy.setting.${term.key}\`?`,
    };
  }
  return {
    state: { request: text.slice(0, MAX_REQUEST_CHARS), taxonomy: stateTaxonomy },
    questions,
  };
}

export function mapIntentAnswers(
  facts: IntentFacts,
  answers: Record<string, DecisionAnswer>,
  model: string,
): IntentClassification {
  const noul = (key: string) => {
    const a = answers[key];
    if (a?.type !== 'noul') throw new Error(`answer ${key} is not a noul`);
    return a.noul;
  };
  const choice = (key: string, none: string) => {
    const a = answers[key];
    if (a?.type !== 'choice') throw new Error(`answer ${key} is not a choice`);
    return {
      key: a.choice === none ? null : a.choice,
      ...(a.probabilities ? { probabilities: a.probabilities } : {}),
      ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
    };
  };
  const labels = (prefix: string) =>
    Object.keys(answers)
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k.slice(prefix.length), probability: noul(k) }))
      .filter((s) => s.probability >= INTENT_THRESHOLDS.preferenceMin)
      .sort((a, b) => b.probability - a.probability);

  const inScopeP = noul('in_scope');
  const inScope = inScopeP >= INTENT_THRESHOLDS.inScopeMin;
  const reasons: ClarificationReason[] = [];
  if (!inScope) reasons.push('out_of_scope');
  if (inScope && noul('needs_clarification') >= INTENT_THRESHOLDS.clarificationMin)
    reasons.push('unclear_activity');
  if (inScope && noul('conflicting') >= INTENT_THRESHOLDS.conflictMin)
    reasons.push('conflicting_preferences');

  return {
    source: 'decision_model',
    model,
    fallbackReason: null,
    facts,
    inScope: { value: inScope, probability: inScopeP },
    category: choice('category', NONE),
    occasion: choice('occasion', NOT_STATED),
    moods: labels('mood:'),
    settings: labels('setting:'),
    clarification: { needed: reasons.length > 0, reasons },
  };
}

/**
 * What a caller gets without a model: the facts, a category only when exactly
 * one synonym family matches, and no question — the caller runs the search it
 * runs today. Nothing is guessed: no mood, no occasion, in-scope unknown.
 */
export function fallbackIntent(
  text: string,
  facts: IntentFacts,
  taxonomy: IntentTaxonomy,
  reason: IntentFallbackReason,
): IntentClassification {
  const empty = reason === 'empty_request';
  const haystack = ` ${normalizeVietnamese(text)} `;
  const matches = Object.entries(taxonomy.categorySynonyms ?? {})
    .filter(([key, terms]) =>
      [key, ...terms].some((term) => haystack.includes(` ${normalizeVietnamese(term)} `)),
    )
    .map(([key]) => key);
  return {
    source: 'fallback',
    model: null,
    fallbackReason: reason,
    facts,
    inScope: { value: !empty, probability: null },
    category: { key: matches.length === 1 ? matches[0]! : null },
    occasion: { key: null },
    moods: [],
    settings: [],
    clarification: empty
      ? { needed: true, reasons: ['empty_request'] }
      : { needed: false, reasons: [] },
  };
}
