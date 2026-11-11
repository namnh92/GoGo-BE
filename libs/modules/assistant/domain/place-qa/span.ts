import { normalizeVietnamese } from '../../../search/domain/normalize';

export type PlaceNameSpan =
  | {
      kind: 'span';
      text: string;
      start: number;
      end: number;
      statedArea?: string;
      areaSpan?: { start: number; end: number };
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

/** Only explicit comparison grammar opens two slots. “và” alone is a name token. */
export function extractComparisonPlaceNameSpans(text: string): PlaceNameSpans {
  const tokens = [...text.matchAll(/\S+/gu)];
  const folded = tokens.map((m) => normalizeVietnamese(m[0]).replace(/[?!.,]+$/g, '')).join(' ');
  const explicit = folded.startsWith('so sanh ');
  const tail =
    /\s+(?:quan nao re hon|quan nao dat hon|ve gia|ve gio mo cua|which is cheaper)\s*$/u.exec(
      folded,
    );
  if (!tail) return { kind: 'ambiguous' };
  const count = folded.slice(0, tail.index).split(/\s+/).length;
  const end = tokens[count]?.index ?? text.length;
  const connectors = tokens.filter(
    (m) =>
      m.index < end &&
      (['voi', 'vs', 'versus'].includes(normalizeVietnamese(m[0])) ||
        (explicit && normalizeVietnamese(m[0]) === 'va')),
  );
  if (connectors.length !== 1) return { kind: 'ambiguous' };
  const connector = connectors[0]!;
  const start = explicit ? (tokens[2]?.index ?? end) : 0;
  const parts = [
    { start, end: connector.index },
    { start: connector.index + connector[0].length, end },
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
 */
export function extractPlaceNameSpan(
  text: string,
  area?: { start: number; end: number },
): PlaceNameSpan {
  if (!text.trim() || text.length > 2000 || /[\uE000\uE001]/u.test(text))
    return { kind: 'ambiguous' };
  const tokens = [...text.matchAll(/[^\s]+/gu)].map((m) => ({
    raw: m[0],
    start: m.index,
    end: m.index + m[0].length,
    folded: normalizeVietnamese(m[0]).replace(/[?!.,:;]+$/u, ''),
  }));
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
    /^(?:(?:gio mo cua|gio dong cua|gia|dia chi|so dien thoai|thong tin|danh gia)(?: cua| ve)?|(?:opening hours|price|address|phone number|information)(?: of| for)?)\s+/;
  const folded = tokens.map((t) => t.folded).join(' ');
  const leading = prefix.exec(folded);
  // A bare single-word topic can also identify a venue (Gia Bảo, Price Cafe).
  // Keep it when a terminal question supplies the topic; otherwise clarify.
  const bareTopic = !!leading && /^(?:gia|price|address)\s+$/u.test(leading[0]);
  if (leading && !bareTopic) {
    const count = leading[0].trim().split(/\s+/).length;
    start = tokens[count]?.start ?? end;
  }
  // A terminal question clause is unambiguous only when its first token is
  // inside the span. Negation belongs to that clause, never to the name.
  const suffix =
    /\s+(?:(?:co|khong co)\s+)?(?:mo cua(?: may gio| luc nao| khong)?|dong cua(?: may gio)?|gia bao nhieu|o dau|dia chi la gi|(?:co |khong co )?(?:cho dau xe|wifi)(?: khong)?|danh gia the nao|may sao|so dien thoai la gi|opening hours|price|address|rating)\s*$/;
  // The same words with no question grammar around them may equally be the end
  // of a venue name (Cafe Wifi, Sunset Address).
  const bareNoun = /^(?:cho dau xe|wifi|opening hours|price|address|rating)$/;
  // A request carries ONE terminal question clause, so it is consumed at most
  // once: before a trailing area, or after it when nothing was consumed yet.
  // Stripping a second time removes name tokens (Cafe Wifi -> Cafe).
  let consumed = false;
  let uncertain = false;
  const consumeQuestion = () => {
    if (consumed) return;
    const usable = tokens.filter((t) => t.start >= start && t.end <= end);
    const tail = usable.map((t) => t.folded).join(' ');
    const match = suffix.exec(tail);
    if (!match) return;
    if (bareNoun.test(match[0].trim())) {
      // A stripped leading topic already supplies the question, so the noun
      // is a name token and stays. Otherwise the boundary cannot be decided.
      if (!leading || bareTopic) uncertain = true;
      return;
    }
    const count = tail.slice(0, match.index).split(/\s+/).length;
    end = usable[count]?.start ?? end;
    consumed = true;
  };
  consumeQuestion();
  let detectedArea = area;
  if (!detectedArea && !uncertain) {
    const remaining = tokens.filter((t) => t.start >= start && t.start < end);
    const boundary = remaining.findIndex((t, i) => i > 0 && ['o', 'tai', 'in'].includes(t.folded));
    if (boundary > 0) {
      const next = remaining[boundary + 1]?.folded ?? '';
      if (/^(?:quan|huyen|phuong|xa|tinh|thanh|tp|q|p|ward|district|city)$/u.test(next)) {
        detectedArea = { start: remaining[boundary]!.start, end };
        end = detectedArea.start;
      } else if (leading || consumed) {
        // A stated but unparseable area must not become a guessed name core.
        return { kind: 'ambiguous' };
      }
    }
  }
  consumeQuestion();
  // Ambiguous segmentation clarifies; it never yields a guessed exact core.
  if (uncertain || (bareTopic && !consumed)) return { kind: 'ambiguous' };
  let span = text.slice(start, end);
  const left = span.length - span.trimStart().length;
  start += left;
  span = span
    .trim()
    .replace(/[?!]+$/u, '')
    .trimEnd();
  end = start + span.length;
  if (
    !span ||
    span.length > 120 ||
    /["“”]/u.test(span) ||
    /\s(?:voi|versus|vs)\s/u.test(normalizeVietnamese(span))
  )
    return { kind: 'ambiguous' };
  if (detectedArea) {
    const rawArea = text.slice(detectedArea.start, detectedArea.end);
    detectedArea = {
      ...detectedArea,
      end: detectedArea.end - (rawArea.length - rawArea.trimEnd().length),
    };
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
  };
}
