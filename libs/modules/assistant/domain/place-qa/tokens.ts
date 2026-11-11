/** Private, server-authored semantic grammar. Never accept this from user/model text. */
export const ANSWER_OPEN = '\uE000';
export const ANSWER_CLOSE = '\uE001';
export const PLACE_ANSWER_VERSION = 1;
export const ANSWER_TOPICS = [
  'hours',
  'price',
  'address',
  'directions',
  'parking',
  'amenity',
  'suitability',
  'rating',
  'contact',
  'overview',
  'out_of_data',
] as const;
export type AnswerTopic = (typeof ANSWER_TOPICS)[number];
export type AnswerQuery = Readonly<{
  placeId: string;
  locale: 'vi' | 'en';
  topic: AnswerTopic;
  day?: 'weekday' | 'date';
  d?: number;
  date?: string;
  tz?: 'Asia/Ho_Chi_Minh';
  k?: string;
  s?: string;
  n?: number;
}>;
export const REFERENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const ARGS: Record<AnswerTopic, readonly string[]> = {
  hours: ['day', 'd', 'date', 'tz'],
  price: [],
  address: [],
  directions: [],
  parking: ['k'],
  amenity: ['k'],
  suitability: ['s', 'n'],
  rating: [],
  contact: [],
  overview: [],
  out_of_data: ['n'],
};
export function parseAnswerToken(token: string): AnswerQuery | null {
  if (
    Buffer.byteLength(token, 'utf8') > 512 ||
    !token.startsWith(ANSWER_OPEN) ||
    !token.endsWith(ANSWER_CLOSE)
  )
    return null;
  const [version, placeId, locale, topic, ...parts] = token.slice(1, -1).split(':');
  if (
    version !== 'a1' ||
    !placeId ||
    !REFERENCE_ID.test(placeId) ||
    (locale !== 'vi' && locale !== 'en') ||
    !ANSWER_TOPICS.includes(topic as AnswerTopic)
  )
    return null;
  const args: Record<string, string> = {};
  for (const part of parts) {
    const pair = /^([a-z]+)=([^:=\uE000\uE001]+)$/.exec(part);
    if (!pair || !ARGS[topic as AnswerTopic].includes(pair[1]!) || Object.hasOwn(args, pair[1]!))
      return null;
    args[pair[1]!] = pair[2]!;
  }
  if ((args.k && !KEY.test(args.k)) || (args.s && !KEY.test(args.s))) return null;
  // Capacity is never clamped. Invalid N is neutral/unsupported, never a numeric claim.
  if (args.n !== undefined && !/^[1-9][0-9]?$/.test(args.n)) return null;
  if (topic === 'amenity' && !args.k) return null;
  if (topic === 'hours') {
    if (!/^[0-6]$/.test(args.d ?? '') || !['weekday', 'date'].includes(args.day ?? '')) return null;
    if (args.day === 'weekday' && (args.date || args.tz)) return null;
    if (args.day === 'date') {
      if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date) || args.tz !== 'Asia/Ho_Chi_Minh')
        return null;
      const at = new Date(`${args.date}T00:00:00Z`);
      if (
        !Number.isFinite(at.getTime()) ||
        at.toISOString().slice(0, 10) !== args.date ||
        at.getUTCDay() !== Number(args.d)
      )
        return null;
    }
  }
  return Object.freeze({
    placeId,
    locale,
    topic: topic as AnswerTopic,
    ...args,
    ...(args.d !== undefined ? { d: Number(args.d) } : {}),
    ...(args.n !== undefined ? { n: Number(args.n) } : {}),
  }) as AnswerQuery;
}
/** Serializer validates too; deliberately not connected to any production producer. */
export function answerToken(query: AnswerQuery): string {
  const parts = ['a1', query.placeId, query.locale, query.topic];
  for (const key of ['day', 'date', 'd', 'tz', 'k', 's', 'n'] as const)
    if (query[key] !== undefined) parts.push(`${key}=${query[key]}`);
  const token = ANSWER_OPEN + parts.join(':') + ANSWER_CLOSE;
  if (!parseAnswerToken(token)) throw new Error('Invalid place answer reference');
  return token;
}
/** Includes malformed, unknown-version and unfinished private runs: none may reach the wire. */
export function mapPrivateTokens(text: string, render: (token: string) => string): string {
  return text.replace(/\uE000[^\uE000\uE001]*(?:\uE001|(?=\uE000)|$)|\uE001/g, render);
}
export function answerQueries(text: string): AnswerQuery[] {
  const queries: AnswerQuery[] = [];
  mapPrivateTokens(text, (token) => {
    const q = parseAnswerToken(token);
    if (q) queries.push(q);
    return '';
  });
  return queries;
}
export function validAnswerMessage(text: string): boolean {
  const queries = answerQueries(text);
  return queries.length <= 8 && new Set(queries.map((q) => q.placeId)).size <= 2;
}
const IDENTITY_REFERENCE =
  /^\uE000place:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\uE001$/;
const SEPARATORS_ONLY = /^[ \t\r\n,;|]*$/;
/** Any private run that claims to be an answer reference, whatever its version or validity. */
export function hasAnswerReference(text: string): boolean {
  return /\uE000a[^\uE001]*(:|\uE001|$)/.test(text);
}
/**
 * The text half of the whole-message grammar, shared by every read surface:
 * every private run is a valid `a1` query or identity reference, nothing but
 * reference separators survives their removal (writer prose is never data),
 * and the query/id limits hold.
 */
export function referenceOnlyText(text: string): boolean {
  let malformed = false;
  const residual = mapPrivateTokens(text, (token) => {
    if (!parseAnswerToken(token) && !IDENTITY_REFERENCE.test(token)) malformed = true;
    return '';
  });
  return !malformed && SEPARATORS_ONLY.test(residual) && validAnswerMessage(text);
}
/**
 * For text read without its message metadata (a stored, truncated preview or
 * a single frame): `none` = no answer reference, legacy rendering applies;
 * `invalid` = an answer reference in text that is not reference-only.
 */
export function answerTextValidity(text: string): AnswerValidity {
  if (!hasAnswerReference(text)) return 'none';
  return referenceOnlyText(text) ? 'valid' : 'invalid';
}
export type AnswerValidity = 'none' | 'valid' | 'invalid';
export function queryLabel(q: AnswerQuery): string {
  return `${q.locale === 'en' ? 'GoGo place' : 'địa điểm GoGo'} (${q.placeId}; ${q.topic}${q.date ? `; ${q.date}` : ''}${q.d !== undefined ? `; weekday=${q.d}` : ''}${q.k ? `; key=${q.k}` : ''}${q.s ? `; key=${q.s}` : ''}${q.n ? `; n=${q.n}` : ''})`;
}

/** Invalid capacity arguments never become clamped facts or trigger a read. */
export function hasMalformedCapacity(text: string): boolean {
  let invalid = false;
  mapPrivateTokens(text, (token) => {
    if (
      /^\uE000a1:[0-9a-f-]{36}:(vi|en):suitability:/.test(token) &&
      /:n=/.test(token) &&
      !parseAnswerToken(token)
    )
      invalid = true;
    return '';
  });
  return invalid;
}
