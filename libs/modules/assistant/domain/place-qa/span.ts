import { normalizeVietnamese } from '../../../search/domain/normalize';

// Shared with the resolver: at most 32 readings / 96 punctuation keys, never truncated.
export const PLACE_NAME_READING_LIMIT = 32;

/**
 * A longer whole-name reading of the same message: a token at a name/grammar
 * boundary (a stripped topic prefix, the first tokens of the question clause,
 * an area marker) may equally belong to the venue name. The extractor cannot
 * know which venues exist, so it never decides: the resolver probes every
 * reading for whole-name equality and the truth table picks (two exact
 * readings => choice). Alternates only add exact candidates, never fuzzy ones.
 */
export type PlaceNameAlternate = Readonly<{
  text: string;
  start: number;
  end: number;
  /** The reading swallows the stated area, so it is looked up without that area. */
  includesArea?: true;
}>;

export type PlaceNameSpan =
  | {
      kind: 'span';
      text: string;
      start: number;
      end: number;
      statedArea?: string;
      areaSpan?: { start: number; end: number };
      alternates?: readonly PlaceNameAlternate[];
    }
  | { kind: 'ambiguous' };

export type PlaceNameSpans =
  | {
      kind: 'spans';
      spans: readonly [
        Extract<PlaceNameSpan, { kind: 'span' }>,
        Extract<PlaceNameSpan, { kind: 'span' }>,
      ];
    }
  | { kind: 'ambiguous' };

/**
 * The accented spelling of every Vietnamese grammar word the patterns below
 * use (lowercase NFC). A token typed WITH diacritics is grammar only when it
 * is one of these: "Cỏ", "Cô", "Mây", "Ô" fold to co/may/o but are name tokens.
 * A token typed without diacritics matches on its folded form and is ambiguous
 * by nature; such boundaries are reported as alternates.
 */
const ACCENTED_GRAMMAR = new Set(
  (
    'giờ mở cửa đóng giá vé địa chỉ số điện thoại thông của về đánh có không mấy lúc nào ' +
    'nhiêu ở đâu là gì chỗ đậu thế tại quận huyện phường xã tỉnh thành với và sánh quán rẻ hơn đắt'
  )
    .normalize('NFC')
    .split(' '),
);
/** Never equal to a grammar word; private to this module (not a stored marker). */
const NAME_ONLY = '\u0001';

type Token = {
  start: number;
  end: number;
  /** End without trailing sentence punctuation. */
  wordEnd: number;
  /** Folded form when the token may be grammar; otherwise a non-matching form. */
  grammar: string;
};
function tokenize(text: string): Token[] {
  return [...text.matchAll(/\S+/gu)].map((m) => {
    const word = m[0].replace(/[?!.,:;]+$/u, '');
    const folded = normalizeVietnamese(word);
    const typed = word.normalize('NFC').toLowerCase();
    return {
      start: m.index,
      end: m.index + m[0].length,
      wordEnd: m.index + word.length,
      grammar: typed === folded || ACCENTED_GRAMMAR.has(typed) ? folded : NAME_ONLY + folded,
    };
  });
}

/** Only explicit comparison grammar opens two slots. “và” alone is a name token. */
export function extractComparisonPlaceNameSpans(text: string): PlaceNameSpans {
  const tokens = tokenize(text);
  const folded = tokens.map((t) => t.grammar).join(' ');
  const explicit = folded.startsWith('so sanh ');
  const tail =
    /\s+(?:quan nao re hon|quan nao dat hon|ve gia|ve gio mo cua|which is cheaper)\s*$/u.exec(
      folded,
    );
  if (!tail) return { kind: 'ambiguous' };
  const count = folded.slice(0, tail.index).split(/\s+/).length;
  const end = tokens[count]?.start ?? text.length;
  const connectors = tokens.filter(
    (t) =>
      t.start < end &&
      (['voi', 'vs', 'versus'].includes(t.grammar) || (explicit && t.grammar === 'va')),
  );
  if (connectors.length !== 1) return { kind: 'ambiguous' };
  const connector = connectors[0]!;
  const start = explicit ? (tokens[2]?.start ?? end) : 0;
  const parts = [
    { start, end: connector.start },
    { start: connector.end, end },
  ];
  const spans = parts.map((part) => {
    const parsed = extractPlaceNameSpan(text.slice(part.start, part.end));
    return parsed.kind === 'span'
      ? {
          ...parsed,
          start: parsed.start + part.start,
          end: parsed.end + part.start,
          ...(parsed.areaSpan
            ? {
                areaSpan: {
                  start: parsed.areaSpan.start + part.start,
                  end: parsed.areaSpan.end + part.start,
                },
              }
            : {}),
          ...(parsed.alternates
            ? {
                alternates: parsed.alternates.map((a) => ({
                  ...a,
                  start: a.start + part.start,
                  end: a.end + part.start,
                })),
              }
            : {}),
        }
      : parsed;
  });
  if (spans[0]?.kind !== 'span' || spans[1]?.kind !== 'span') return { kind: 'ambiguous' };
  return { kind: 'spans', spans: [spans[0], spans[1]] };
}

/**
 * Span extraction only, not route admission. S3 must decide factual intent first.
 * Token offsets refer to the original request, including decomposed Vietnamese.
 * Optional area boundaries come from the area grammar, never a global word filter.
 * `text` is the shortest reading; `alternates` are the longer whole-name readings
 * that MUST be resolved with it (`resolvePlaceName(span.text, { alternates })`).
 */
export function extractPlaceNameSpan(
  text: string,
  area?: { start: number; end: number },
): PlaceNameSpan {
  if (
    !text.trim() ||
    text.length > 2000 ||
    /[\uE000\uE001]/u.test(text) ||
    text.includes(NAME_ONLY)
  )
    return { kind: 'ambiguous' };
  const tokens = tokenize(text);
  let start = 0;
  let end = text.length;
  if (area) {
    if (
      area.start < 0 ||
      area.end > text.length ||
      area.start >= area.end ||
      !tokens.some((t) => t.start === area.start) ||
      !/^(?:o|tai|in)\s/u.test(normalizeVietnamese(text.slice(area.start, area.end))) ||
      text.slice(area.end).replace(/[?!.,\s]/g, '')
    )
      return { kind: 'ambiguous' };
    end = area.start;
  }
  // Only anchored topic clauses outside a name are removed. A name containing
  // Cafe, Mới, Gần, Tìm, numbers or administrative words keeps those tokens.
  const prefix =
    /^(?:(?:gio mo cua|gio dong cua|gia(?: ve)?|dia chi|so dien thoai|thong tin|danh gia)( cua| ve)?|(?:opening hours|price|address|phone number|information)( of| for)?)\s+/;
  const leading = prefix.exec(tokens.map((t) => t.grammar).join(' '));
  // A bare single-word topic can also identify a venue (Gia Bảo, Price Cafe).
  // Keep it when a terminal question supplies the topic; otherwise clarify.
  const bareTopic = !!leading && /^(?:gia|price|address)\s+$/u.test(leading[0]);
  if (leading && !bareTopic) {
    const count = leading[0].trim().split(/\s+/).length;
    start = tokens[count]?.start ?? end;
  }
  // A terminal question clause is unambiguous only when its first token is
  // inside the span. Negation belongs to that clause, never to the name. The
  // có / không có particle is matched ONCE, so "Quán Có có wifi không?" keeps Có.
  const suffix =
    /\s+(?:(?:co|khong co)\s+)?(?:mo cua(?: may gio| luc nao| khong)?|dong cua(?: may gio)?|gia bao nhieu|(?:la )?bao nhieu|o dau|dia chi la gi|(?:cho dau xe|wifi)(?: khong)?|danh gia the nao|may sao|so dien thoai la gi|opening hours|price|address|rating)\s*$/;
  // The same words with no question grammar around them may equally be the end
  // of a venue name (Cafe Wifi, Sunset Address).
  const bareNoun = /^(?:cho dau xe|wifi|opening hours|price|address|rating)$/;
  // A request carries ONE terminal question clause, so it is consumed at most
  // once: before a trailing area, or after it when nothing was consumed yet.
  // Stripping a second time removes name tokens (Cafe Wifi -> Cafe).
  let clause: { first: number; length: number } | undefined;
  let uncertain = false;
  const consumeQuestion = () => {
    if (clause) return;
    const usable = tokens.filter((t) => t.start >= start && t.end <= end);
    const tail = usable.map((t) => t.grammar).join(' ');
    const match = suffix.exec(tail);
    if (!match) return;
    if (bareNoun.test(match[0].trim())) {
      // A stripped leading topic already supplies the question, so the noun
      // is a name token and stays. Otherwise the boundary cannot be decided.
      if (!leading || bareTopic) uncertain = true;
      return;
    }
    const count = tail.slice(0, match.index).split(/\s+/).length;
    if (!usable[count]) return;
    clause = { first: tokens.indexOf(usable[count]), length: usable.length - count };
    end = usable[count].start;
  };
  consumeQuestion();
  let detectedArea = area;
  if (!detectedArea && !uncertain) {
    const remaining = tokens.filter((t) => t.start >= start && t.start < end);
    const boundary = remaining.findIndex((t, i) => i > 0 && ['o', 'tai', 'in'].includes(t.grammar));
    if (boundary > 0) {
      const next = remaining[boundary + 1]?.grammar ?? '';
      if (/^(?:quan|huyen|phuong|xa|tinh|thanh|tp|q|p|ward|district|city)$/u.test(next)) {
        detectedArea = { start: remaining[boundary]!.start, end };
        end = detectedArea.start;
      } else if (leading || clause) {
        // A stated but unparseable area must not become a guessed name core.
        return { kind: 'ambiguous' };
      }
    }
  }
  consumeQuestion();
  // Ambiguous segmentation clarifies; it never yields a guessed exact core.
  if (uncertain || (bareTopic && !clause)) return { kind: 'ambiguous' };
  let span = text.slice(start, end);
  const left = span.length - span.trimStart().length;
  start += left;
  span = span
    .trim()
    .replace(/[?!]+$/u, '')
    .trimEnd();
  end = start + span.length;
  const unusable = (name: string) =>
    !name ||
    name.length > 120 ||
    /["“”]/u.test(name) ||
    /\s(?:voi|versus|vs)\s/u.test(normalizeVietnamese(name));
  if (unusable(span)) return { kind: 'ambiguous' };
  if (detectedArea) {
    const rawArea = text.slice(detectedArea.start, detectedArea.end);
    detectedArea = {
      ...detectedArea,
      end: detectedArea.end - (rawArea.length - rawArea.trimEnd().length),
    };
  }
  // Enumerate the Cartesian product of EVERY token cut across both boundaries.
  // This includes zero consumed grammar (the full unstripped message), all
  // partial topic prefixes, and every clause/area suffix, not only two tokens.
  // Even explicit "của/of" may occur inside a published name. Catalogue equality,
  // not grammar plausibility, decides whether any of these readings exists.
  const starts = [start, ...tokens.filter((t) => t.start < start).map((t) => t.start)];
  const ends = [end, ...tokens.filter((t) => t.wordEnd > end).map((t) => t.wordEnd)];
  if (starts.length * ends.length > PLACE_NAME_READING_LIMIT) return { kind: 'ambiguous' };
  const alternates: PlaceNameAlternate[] = [];
  for (const from of starts) {
    for (const to of ends) {
      const candidate = text.slice(from, to);
      // An unrepresentable reading cannot silently disappear from the set.
      if (unusable(candidate)) return { kind: 'ambiguous' };
      if (from === start && to === end) continue;
      alternates.push({
        text: candidate,
        start: from,
        end: to,
        // Any overlap can be name text, so don't hide that collision behind
        // an area filter (including externally supplied area boundaries).
        ...(detectedArea && to > detectedArea.start ? { includesArea: true as const } : {}),
      });
    }
  }
  return {
    kind: 'span',
    text: span,
    start,
    end,
    ...(detectedArea
      ? {
          statedArea: text.slice(detectedArea.start, detectedArea.end).trim(),
          areaSpan: detectedArea,
        }
      : {}),
    ...(alternates.length ? { alternates } : {}),
  };
}
