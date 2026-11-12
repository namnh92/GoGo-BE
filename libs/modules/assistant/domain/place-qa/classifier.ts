import { PLACE_NAME_READING_LIMIT } from './config';
import vi from './lexicon.vi.json';
import en from './lexicon.en.json';
import { normalizeVietnamese } from '../../../search/domain/normalize';
import { extractPlaceNameSpan, type PlaceNameSpan } from './span';
import { isTypedConfirm } from './pending';
import type { AnswerQuery, AnswerTopic } from './tokens';

export type QaArgs = {
  -readonly [K in keyof Omit<AnswerQuery, 'placeId' | 'locale' | 'topic'>]: Omit<
    AnswerQuery,
    'placeId' | 'locale' | 'topic'
  >[K];
};
export type QaVocabularyEntry = Readonly<{
  kind: 'amenity' | 'suitability';
  key: string;
  terms: readonly string[];
}>;
export type QaClass =
  | 'named_place_question'
  | 'compare'
  | 'referent_question'
  | 'name_only'
  | 'clarify_referent'
  | 'not_qa';
export type QaClassification =
  | { kind: 'not_qa' }
  | { kind: 'compare'; topic: AnswerTopic; args: QaArgs }
  | {
      kind: 'named_place_question' | 'name_only';
      topic: AnswerTopic;
      args: QaArgs;
      span: Extract<PlaceNameSpan, { kind: 'span' }>;
    }
  | { kind: 'referent_question' | 'clarify_referent'; topic: AnswerTopic; args: QaArgs };
const test = (pattern: string, text: string) => new RegExp(`(?:${pattern})`, 'u').test(text);
const folded = (text: string) =>
  normalizeVietnamese(text)
    .replace(/[?!.,;]+$/u, '')
    .trim();
/** Bare “bao nhiêu” is a name token unless a ticket-price head supplies the question. */
function lexiconFor(text: string, locale: 'vi' | 'en') {
  if (locale === 'en') return en;
  if (!/^gia ve /u.test(text)) return vi;
  return {
    ...vi,
    suffix: `(?:${vi.suffix}| (?:la )?bao nhieu$)`,
    topics: { ...vi.topics, price: `${vi.topics.price}|(?:la )?bao nhieu` },
  };
}
export function isNewNonQaRequest(text: string): boolean {
  const t = folded(text);
  if (isTypedConfirm(text)) return false;
  return [lexiconFor(t, 'vi'), en].some((l) => {
    if (test(l.guard, t) || test(l.category, t)) return true;
    const recommendation = new RegExp(l.recommend, 'u').exec(t);
    if (!recommendation) return false;
    if (recommendation.index === 0) return true;
    const prefix = new RegExp(l.prefix, 'u').exec(t);
    const suffix = lastQuestionClause(
      l.suffix,
      Object.values(l.topics).join('|'),
      t,
      prefix ? prefix[0].trimEnd().length : 0,
    );
    const start = prefix?.[0].length ?? 0;
    const end = suffix?.index ?? t.length;
    const name = t.slice(start, end).trim();
    // A factual clause supplies the name boundary. Protect the complete venue
    // span, not a bag of words. An imperative head or an external command still
    // wins; category-only traffic never requires a catalogue read.
    if (!(prefix || suffix) || !name) return true;
    if (!prefix && !/^(?:cafe|ca phe|quan|nha hang|restaurant|bistro|bar) /u.test(name))
      return true;
    if (test(l.guard, name) || /^[^.;!?]*[.;!?]/u.test(name)) return true;
    return test(l.recommend, t.slice(0, start)) || test(l.recommend, t.slice(end));
  });
}
/**
 * GoGo-BE#873 round 2. What the send can know about a turn from its own text,
 * with no read: written into the assistant row in the admission transaction.
 * It is a provisional marker, never a route. `control` alone is already QA
 * (a structured follow-up is QA control in every flag state, §3.1 item 1).
 * - `question`: QA-shaped question; QA when the flag is on.
 * - `name`: bare text, a name-only PROBE; QA only after exact canonical-name
 *   qualification, or as a typed reply to a QA turn.
 * - `reply`: other text; QA only as a typed reply to a QA turn.
 * `null`: an explicit recommendation/action/guide — never QA, no marker.
 */
export type QaProbe = 'control' | 'question' | 'name' | 'reply';
export function qaProbeOf(
  text: string,
  context: { kind: string; id: string } | null,
  locale: 'vi' | 'en',
  structured: boolean,
): QaProbe | null {
  if (structured) return 'control';
  // An explicit confirmation remains control even after its source is stale;
  // never let its identity words enter a recommendation model request.
  if (isTypedConfirm(text)) return 'control';
  if (isNewNonQaRequest(text)) return null;
  const kind = new PlaceQaClassifier().classify(text, context, { now: new Date(), locale }).kind;
  return kind === 'not_qa' ? 'reply' : kind === 'name_only' ? 'name' : 'question';
}
/** Newest text only. Catalogue evidence for a name-only query is supplied by the caller.
 * name_only is a probe, and may be admitted only for complete whole-name equality.
 * No pending/recommendation text is merged into this input.
 */
export class PlaceQaClassifier {
  classify(
    text: string,
    context: { kind: string; id: string } | null,
    qaView: { now: Date; locale: 'vi' | 'en'; vocabulary?: readonly QaVocabularyEntry[] },
  ): QaClassification {
    const t = folded(text);
    if (!t || /[\uE000\uE001]/u.test(text) || isNewNonQaRequest(text)) return { kind: 'not_qa' };
    const lex = lexiconFor(t, qaView.locale);
    const prefix = new RegExp(lex.prefix, 'u').exec(t);
    const suffix = lastQuestionClause(
      lex.suffix,
      Object.values(lex.topics).join('|'),
      t,
      prefix ? prefix[0].trimEnd().length : 0,
    );
    const topicText = suffix ? t.slice(suffix.index).trim() : (prefix?.[0].trim() ?? t);
    let topic = (Object.entries(lex.topics).find(([, p]) =>
      test(`(?:^| )(${p})(?: |$)`, topicText),
    )?.[0] ?? null) as AnswerTopic | null;
    // Specific unsupported data outranks broad suitability/overview phrases.
    if (test(lex.topics.rating, topicText)) topic = 'rating';
    if (test(lex.topics.out_of_data, topicText)) topic = 'out_of_data';
    const vocabulary =
      topic === null || ['amenity', 'parking', 'suitability'].includes(topic)
        ? qaView.vocabulary?.find((v) =>
            v.terms.some((term) => ` ${topicText} `.includes(` ${normalizeVietnamese(term)} `)),
          )
        : undefined;
    if (vocabulary)
      topic =
        vocabulary.kind === 'suitability'
          ? 'suitability'
          : vocabulary.key === 'parking'
            ? 'parking'
            : 'amenity';
    if (!topic && /(?:^| )(?:co .+ khong$|has .+|have .+)/u.test(topicText)) topic = 'out_of_data';
    if (test(lex.compare, t)) return { kind: 'compare', topic: topic ?? 'overview', args: {} };
    const args: QaArgs = {};
    if (topic === 'hours') {
      const day = dayArgs(topicText, qaView.now);
      if (!day) return { kind: 'clarify_referent', topic, args };
      Object.assign(args, day);
    }
    if (topic === 'amenity') args.k = /wi-?fi/u.test(topicText) ? 'wifi' : 'air_conditioning';
    if (topic === 'parking') args.k = 'parking';
    if (topic === 'suitability') {
      const n = /(?:^| )(\d+) (?:nguoi|people)(?: |$)/u.exec(topicText);
      if (n) {
        const count = Number(n[1]);
        if (count < 1 || count > 99) topic = 'out_of_data';
        else args.n = count;
      } else if (/hen ho|dating/u.test(topicText)) args.s = 'couple';
      else if (/nhom|group/u.test(topicText)) args.s = 'group';
      else if (/gia dinh|family/u.test(topicText)) args.s = 'family';
    }
    if (vocabulary) {
      if (vocabulary.kind === 'suitability') args.s = vocabulary.key;
      else args.k = vocabulary.key;
    }
    if (!topic) {
      // Pure categories and fragments never become fuzzy QA. A name-only probe
      // must match the WHOLE canonical name; failures return to the old path.
      const span = extractPlaceNameSpan(text);
      return span.kind === 'span' && text.trim().split(/\s+/u).length <= 12
        ? { kind: 'name_only', topic: 'overview', args, span }
        : { kind: 'not_qa' };
    }
    if (
      /^(?:(?:co |khong co )?(?:gia bao nhieu|mo cua.*|gio mo cua|dong cua.*|wifi(?: khong)?|cho dau xe(?: khong)?|may sao|dia chi|o dau|so dien thoai)|(?:what (?:is|are) (?:the )?)?(?:opening hours|price|address|phone number))$/u.test(
        t,
      )
    )
      return {
        kind: context?.kind === 'place' ? 'referent_question' : 'clarify_referent',
        topic,
        args,
      };
    if (
      !prefix &&
      suffix &&
      /^(?:wifi|menu|price|address|rating|opening hours)$/u.test(suffix[0].trim())
    ) {
      const name = text.trim().replace(/[?!]+$/u, '');
      return {
        kind: 'name_only',
        topic: 'overview',
        args: {},
        span: {
          kind: 'span',
          text: name,
          start: text.indexOf(name),
          end: text.indexOf(name) + name.length,
        },
      };
    }
    // S2 keeps alternate whole-name readings at grammar boundaries. Extend its
    // anchored grammar for the remaining S3 topics, never global word deletion.
    let span = extractPlaceNameSpan(text);
    const rawTokens = [...text.matchAll(/\S+/gu)];
    if (prefix || suffix) {
      const startCount = prefix ? prefix[0].trim().split(/\s+/u).length : 0;
      const endCount = suffix ? t.slice(0, suffix.index).split(/\s+/u).length : rawTokens.length;
      const start = rawTokens[startCount]?.index ?? text.length;
      const end = rawTokens[endCount]?.index ?? text.length;
      const core = text
        .slice(start, end)
        .trim()
        .replace(/[?!]+$/u, '');
      if (core) {
        const extended = extractPlaceNameSpan(core);
        if (extended.kind === 'span') {
          const originals =
            span.kind === 'span'
              ? [{ text: span.text, start: span.start, end: span.end }, ...(span.alternates ?? [])]
              : [];
          const alternates = [
            ...(extended.alternates ?? []).map((a) => ({
              ...a,
              start: start + a.start,
              end: start + a.end,
            })),
            ...originals,
            {
              text: text.trim().replace(/[?!]+$/u, ''),
              start: 0,
              end: text.trim().replace(/[?!]+$/u, '').length,
              ...(extended.statedArea || (span.kind === 'span' && span.statedArea)
                ? { includesArea: true as const }
                : {}),
            },
          ].filter(
            (a, i, all) =>
              a.text !== extended.text && all.findIndex((b) => b.text === a.text) === i,
          );
          if (alternates.length >= PLACE_NAME_READING_LIMIT)
            return { kind: 'clarify_referent', topic, args };
          const originalArea =
            span.kind === 'span' && span.statedArea && !extended.statedArea
              ? {
                  statedArea: span.statedArea,
                  ...(span.areaSpan ? { areaSpan: span.areaSpan } : {}),
                }
              : {};
          span = {
            ...extended,
            ...originalArea,
            start: start + extended.start,
            end: start + extended.end,
            ...(extended.areaSpan
              ? {
                  areaSpan: {
                    start: start + extended.areaSpan.start,
                    end: start + extended.areaSpan.end,
                  },
                }
              : {}),
            alternates,
          };
        }
      } else span = { kind: 'ambiguous' };
    }
    if (span.kind === 'ambiguous') return { kind: 'clarify_referent', topic, args };
    // The generalized topic grammar has the same whole-boundary protection as
    // S2: every partial prefix/suffix reading is checked, or we clarify. Never
    // truncate readings and turn an incomplete search into a unique answer.
    const spanStart = span.start,
      spanEnd = span.end;
    const starts = [spanStart, ...rawTokens.filter((w) => w.index < spanStart).map((w) => w.index)];
    const ends = [
      spanEnd,
      ...rawTokens
        .map((w) => w.index + w[0].replace(/[?!.,:;]+$/u, '').length)
        .filter((end) => end > spanEnd),
    ];
    if (starts.length * ends.length > PLACE_NAME_READING_LIMIT)
      return { kind: 'clarify_referent', topic, args };
    const readings = [...(span.alternates ?? [])];
    for (const start of starts)
      for (const end of ends) {
        if (start === span.start && end === span.end) continue;
        const reading = text.slice(start, end);
        if (reading.length > 120) return { kind: 'clarify_referent', topic, args };
        if (!readings.some((a) => a.text === reading))
          readings.push({
            text: reading,
            start,
            end,
            ...(span.areaSpan && end > span.areaSpan.start ? { includesArea: true as const } : {}),
          });
      }
    if (readings.length >= PLACE_NAME_READING_LIMIT)
      return { kind: 'clarify_referent', topic, args };
    span = { ...span, alternates: readings };
    const name = folded(span.text);
    if (
      test(lex.deictic, name) ||
      (name === t && test(`^(?:${Object.values(lex.topics).join('|')})$`, t))
    )
      return {
        kind: context?.kind === 'place' ? 'referent_question' : 'clarify_referent',
        topic,
        args,
      };
    return { kind: 'named_place_question', topic, args, span };
  }
}
function dayArgs(t: string, now: Date): QaArgs | null {
  if (/(?:timezone|mui gio|utc|gmt|tuan sau|ngay kia)/u.test(t)) return null;
  const dateMatch = /(?:^| )(\d{4}-\d{2}-\d{2})(?: |$)/u.exec(t);
  const weekday =
    /(?:^| )(?:thu ([2-7])|thu hai|thu ba|thu tu|thu nam|thu sau|thu bay|chu nhat|cn|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?: |$)/u.exec(
      t,
    );
  if (weekday && !dateMatch) {
    const d = weekday[1]
      ? Number(weekday[1]) - 1
      : ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(
          weekday[0].trim(),
        );
    const verbal = [
      'chu nhat',
      'thu hai',
      'thu ba',
      'thu tu',
      'thu nam',
      'thu sau',
      'thu bay',
    ].indexOf(weekday[0].trim());
    return { day: 'weekday', d: d < 0 ? Math.max(0, verbal) : d };
  }
  if (/\d{1,2}[/.-]\d{1,2}/u.test(t) && !dateMatch) return null;
  const local = new Date(
    now.getTime() + 7 * 60 * 60 * 1000 + (/ngay mai|tomorrow/u.test(t) ? 86400000 : 0),
  );
  const date = dateMatch?.[1] ?? local.toISOString().slice(0, 10);
  const at = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== date) return null;
  return { day: 'date', date, d: at.getUTCDay(), tz: 'Asia/Ho_Chi_Minh' };
}

/** Prefer the final asked clause over a topic word inside a venue name.
 * Multiword topic heads and the single có/không có particle stay atomic.
 */
function lastQuestionClause(
  pattern: string,
  topics: string,
  text: string,
  afterPrefix: number,
): { index: number; 0: string } | null {
  // A topic prefix already owns its words. A suffix may start only after it;
  // otherwise "Giờ mở cửa của X" is split at "mở cửa" inside the prefix.
  let cursor = afterPrefix,
    selected: { index: number; 0: string } | null = null;
  const head = new RegExp(
    `^ (?:(?:hom nay|ngay mai|thu [2-7]|chu nhat|cn) )?(?:(?:co|khong co|have|has) )?(?:${topics})(?= |$)`,
    'u',
  );
  while (cursor < text.length) {
    const match = new RegExp(pattern, 'u').exec(text.slice(cursor));
    if (!match) break;
    const index = cursor + match.index;
    selected = { index, 0: match[0] };
    // Advance over the complete topic head, not one character. Nested matches
    // such as "đậu xe" inside "có chỗ đậu xe" are the SAME clause. Later
    // separate heads still win ("Cafe Đánh Giá giá bao nhiêu?").
    cursor = index + (head.exec(match[0])?.[0].length ?? 1);
  }
  if (selected) {
    const before = text.slice(0, selected.index);
    const particle = / (?:khong co|co)$/u.exec(before);
    if (particle && !/^(?:co|khong co) /u.test(selected[0].trimStart()))
      selected = { index: particle.index, 0: text.slice(particle.index) };
  }
  return selected;
}
