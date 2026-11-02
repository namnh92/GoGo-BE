import {
  parseBudgetSpan,
  parseDayPart,
  parseIntentFacts,
  type DayPart,
  type IntentFacts,
} from '../../search/domain/intent';
import { normalizeVietnamese } from '../../search/domain/normalize';

/**
 * GoGo-BE#738 D-19 — a parsed fact asserts only when it is not negated.
 * Deterministic, on the original newest message. A clause holding a marker
 * anywhere, before or after the fact, rejects what it contains; a quoted fact
 * asserts nothing. Over-rejection costs one question; a wrong reading never
 * replaces a value the person settled (I-8).
 */

const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';

/**
 * Each word as written or typed without marks. Folding every word would read
 * "bò" as "bỏ" and "đúng" as "đừng", so a marked spelling must be the marker's.
 */
const NEGATION = new RegExp(
  `${WORD_START}(?:không|khong|chẳng|chang|đừng|dung|bỏ|bo|khỏi|khoi|hết|het)${WORD_END}|${WORD_START}(?:thôi|thoi)${WORD_END}.*${WORD_START}(?:nữa|nua)${WORD_END}`,
  'iu',
);
/** Nouns that begin with "không", not negations ("không gian ngoài trời"). */
const NEGATION_NOUN = new RegExp(`${WORD_START}(?:không|khong) (?:gian|khí|khi)${WORD_END}`, 'giu');
const QUOTED = /"[^"]*"|“[^”]*”|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])/gu;
/** Marks between digits ("1,5 triệu") end no clause; those before a space do. */
const CLAUSE_BREAK = new RegExp(
  `[;!?]|[,.](?=\\s|$)|${WORD_START}(?:nhưng|nhung|mà|ma|còn|con|chứ|chu)${WORD_END}`,
  'iu',
);

const hasNegation = (clause: string) => NEGATION.test(clause.replace(NEGATION_NOUN, ' '));

const EMPTY_FACTS = (): IntentFacts => ({
  partySize: null,
  budget: null,
  timeHint: null,
  areaText: null,
});

export type MessageReading = {
  /** The latest asserted value of each fact. */
  asserted: IntentFacts;
  dayPart: DayPart | null;
  /** The facts a negated clause contains. */
  rejected: IntentFacts;
  clauses: { text: string; negated: boolean }[];
};

export function readMessage(input: string): MessageReading {
  const text = input.normalize('NFC').replace(QUOTED, ' ');
  // No marker: the whole message reads as it always did, numbers and dotted
  // names ("Q. Bình Thạnh") intact.
  if (!hasNegation(text)) {
    return {
      asserted: parseIntentFacts(text),
      dayPart: parseDayPart(text),
      rejected: EMPTY_FACTS(),
      clauses: [{ text, negated: false }],
    };
  }
  const clauses = text
    .split(new RegExp(CLAUSE_BREAK.source, 'giu'))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .map((clause) => ({ text: clause, negated: hasNegation(clause) }));
  const asserted = EMPTY_FACTS();
  const rejected = EMPTY_FACTS();
  let dayPart: DayPart | null = null;
  for (const clause of clauses) {
    const facts = parseIntentFacts(clause.text);
    const into = clause.negated ? rejected : asserted;
    if (facts.partySize !== null) into.partySize = facts.partySize;
    if (facts.budget !== null) into.budget = facts.budget;
    if (facts.timeHint !== null) into.timeHint = facts.timeHint;
    if (facts.areaText !== null) into.areaText = facts.areaText;
    if (!clause.negated) dayPart = parseDayPart(clause.text) ?? dayPart;
  }
  return { asserted, dayPart, rejected, clauses };
}

const containsTerm = (haystack: string, term: string) => {
  const needle = normalizeVietnamese(term).trim();
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
};

const foldedWords = (text: string) =>
  normalizeVietnamese(text)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether one of a taxonomy key's terms occurs in the texts, folded (D-9). */
export function statesTerm(texts: readonly string[], terms: readonly string[]): boolean {
  const haystack = foldedWords(texts.join(' '));
  return terms.some((term) => containsTerm(haystack, term));
}

/** How the newest message treats a taxonomy key's terms. */
export function termStatus(
  reading: MessageReading,
  terms: readonly string[],
): 'asserted' | 'rejected' | null {
  let status: 'asserted' | 'rejected' | null = null;
  for (const clause of reading.clauses) {
    if (statesTerm([clause.text], terms)) status = clause.negated ? 'rejected' : 'asserted';
  }
  return status;
}

// ── D-16 rule 1: a bare answer ───────────────────────────────────────────────

const PARTICLES = new Set([
  'cho',
  'minh',
  'toi',
  'la',
  'thi',
  'nhe',
  'nha',
  'a',
  'vay',
  'di',
  'thoi',
]);
/** "thôi," opens a new clause; it is no particle there. */
const CLAUSE_OPENING_THOI = /(?<![\p{L}\p{N}])(?:thôi|thoi)\s*,/iu;

/** Only particles left once the fact's own span is gone (D-16 rule 1). */
export function isOnlyParticles(remainder: string): boolean {
  if (CLAUSE_OPENING_THOI.test(remainder.normalize('NFC'))) return false;
  const words = foldedWords(remainder);
  return words.length === 0 || words.split(' ').every((word) => PARTICLES.has(word));
}

const PARTY_SPAN =
  /(?:\d{1,2}|một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười)\s*(?:người|ng|đứa bạn|đứa|bạn|mạng|thằng|anh em|chị em|people)(?![\p{L}\p{N}])|(?:nhóm|hội|team|bàn)\s+\d{1,2}(?!\p{N})|một mình|cặp đôi|vợ chồng/iu;
const TIME_SPAN =
  /tối hôm nay|ngày mai|tối mai|trưa mai|sáng mai|chiều mai|tối nay|đêm nay|hôm nay|trưa nay|chiều nay|sáng nay|bữa nay|ngay bây giờ|bây giờ|giờ luôn|ngay lúc này|liền luôn|đi liền|cuối tuần|chủ nhật|thứ 7|thứ bảy|tonight|tomorrow|saturday|sunday|weekend|(?<![\p{L}\p{N}])cn(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])mai(?![\p{L}\p{N}])/iu;
const PART_SPAN =
  /(?<![\p{L}\p{N}])(?:sáng|trưa|chiều|tối|morning|noon|afternoon|evening)(?![\p{L}\p{N}])/iu;
const PART_OF: Record<string, DayPart> = {
  sáng: 'morning',
  trưa: 'noon',
  chiều: 'afternoon',
  tối: 'evening',
  morning: 'morning',
  noon: 'noon',
  afternoon: 'afternoon',
  evening: 'evening',
};
const LOCATIVE = /(?:gần|ở|quanh|khu vực|khu|tại|bên|phía)\s*$/iu;

/** A bare party size: "4 người", "cho 4 người nhé", "3 người thôi". */
export function bareParty(input: string): number | null {
  const reading = readMessage(input);
  if (reading.rejected.partySize !== null || reading.asserted.partySize === null) return null;
  return isOnlyParticles(input.normalize('NFC').toLowerCase().replace(PARTY_SPAN, ' '))
    ? reading.asserted.partySize
    : null;
}

export function bareBudget(input: string): NonNullable<IntentFacts['budget']> | null {
  const reading = readMessage(input);
  const budget = reading.asserted.budget;
  if (reading.rejected.budget !== null || budget === null) return null;
  const text = input.normalize('NFC').toLowerCase();
  const span = parseBudgetSpan(text);
  if (!span) return null;
  return isOnlyParticles(`${text.slice(0, span.start)} ${text.slice(span.end)}`) ? budget : null;
}

/** "thứ 7 tối", "tối nay", or a lone part of the day: only as a whole answer (D-17). */
export function bareTime(input: string): {
  timeHint: IntentFacts['timeHint'];
  dayPart: DayPart | null;
} | null {
  const reading = readMessage(input);
  if (reading.clauses.some((clause) => clause.negated)) return null;
  const text = input.normalize('NFC').toLowerCase();
  const rest = text.replace(TIME_SPAN, ' ');
  if (reading.asserted.timeHint !== null) {
    return isOnlyParticles(rest.replace(PART_SPAN, ' '))
      ? { timeHint: reading.asserted.timeHint, dayPart: reading.dayPart }
      : null;
  }
  const part = PART_SPAN.exec(text);
  if (!part || !isOnlyParticles(text.replace(PART_SPAN, ' '))) return null;
  return { timeHint: null, dayPart: PART_OF[part[0].toLowerCase()] ?? null };
}

/** A lone part of the day beside a day the other side said (D-17 (b)). */
export function lonePart(input: string): DayPart | null {
  const text = input.normalize('NFC').toLowerCase();
  // A meal, "tối đa" and "sáng sủa" are not hours (#733 Q-2).
  const cleaned = text.replace(/(?:ăn|bữa)\s+(?:sáng|trưa|chiều|tối)|tối đa|sáng sủa/gu, ' ');
  const part = PART_SPAN.exec(cleaned);
  return part ? (PART_OF[part[0].toLowerCase()] ?? null) : null;
}

/** "ở Quận 1 nhé": the area phrase with its locative word and nothing else. */
export function bareAreaPhrase(input: string): string | null {
  const reading = readMessage(input);
  const area = reading.asserted.areaText;
  if (reading.rejected.areaText !== null || area === null) return null;
  const text = input.normalize('NFC');
  const at = text.toLowerCase().lastIndexOf(area.toLowerCase());
  if (at < 0) return null;
  const before = text.slice(0, at).replace(LOCATIVE, ' ');
  return isOnlyParticles(`${before} ${text.slice(at + area.length)}`) ? area : null;
}

/** The term a whole message names, once particles are gone. */
export function bareTerm(input: string, terms: readonly string[]): boolean {
  if (readMessage(input).clauses.some((clause) => clause.negated)) return false;
  const words = foldedWords(input).split(' ');
  return terms.some((term) => {
    const needle = foldedWords(term);
    if (!needle) return false;
    const haystack = ` ${words.join(' ')} `;
    return (
      haystack.includes(` ${needle} `) && isOnlyParticles(haystack.replace(` ${needle} `, ' '))
    );
  });
}
