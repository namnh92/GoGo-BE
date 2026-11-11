import type { PlaceFactContext, PlaceFacts, RenderedSource, VerifiedFact } from './place-facts';
import type { AnswerQuery } from './tokens';
import { mapPrivateTokens } from './tokens';

export const LOAD_ERROR = {
  vi: 'GoGo chưa tải được dữ liệu địa điểm. Bạn thử lại nhé.',
  en: 'GoGo could not load place data. Please try again.',
} as const;
export const SAFE_LABEL = { vi: 'địa điểm này', en: 'this place' } as const;
export const POINTER = {
  vi: 'Bạn xem thông tin trong thẻ địa điểm nhé.',
  en: 'Please see the place card for details.',
} as const;
export const UNSUPPORTED_CAPACITY = {
  vi: 'GoGo chưa có dữ liệu sức chứa; bạn nên hỏi trực tiếp địa điểm.',
  en: 'GoGo has no capacity data; please ask the place directly.',
} as const;
const UNAVAILABLE = {
  vi: 'Địa điểm hiện không khả dụng.',
  en: 'This place is currently unavailable.',
} as const;
export const safeText = (text: string): string => mapPrivateTokens(text, () => '');
const dateValid = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
export function eligible<T>(
  fact: VerifiedFact<T> | undefined,
  kinds: readonly string[] = ['gogo', 'community'],
): fact is VerifiedFact<T> {
  return (
    !!fact &&
    ['verified_current', 'verified_reference'].includes(fact.tier) &&
    dateValid(fact.verifiedAt) &&
    !!fact.source &&
    kinds.includes(fact.source.kind) &&
    dateValid(fact.source.collectedAt)
  );
}
const clock = (minute: number): string =>
  `${Math.floor(minute / 60)
    .toString()
    .padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
const weekdays = {
  vi: ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
const units = {
  vi: { per_person: 'người', per_item: 'món', per_hour: 'giờ', per_night: 'đêm' },
  en: { per_person: 'person', per_item: 'item', per_hour: 'hour', per_night: 'night' },
};
export function validPrices(place: PlaceFacts) {
  return (place.facts.price ?? [])
    .filter((f) => eligible(f, ['gogo']))
    .flatMap((fact) =>
      fact.value
        .filter(
          (p) =>
            Number.isSafeInteger(p.min) &&
            Number.isSafeInteger(p.max) &&
            p.min >= 0 &&
            p.max >= p.min &&
            /^[A-Z]{3}$/.test(p.currency) &&
            Intl.supportedValuesOf('currency').includes(p.currency) &&
            Object.hasOwn(units.en, p.unit),
        )
        .map((value) => ({ value, evidence: fact })),
    );
}
export type PlaceAnswer = {
  text: string;
  sources: RenderedSource[];
  eligible: boolean;
  unavailable: boolean;
};
/** Pure templates over S2's eligible projection. No DB, model, persistence or TTL. */
export function renderPlaceAnswer(query: AnswerQuery, context: PlaceFactContext): PlaceAnswer {
  const { locale, topic } = query,
    en = locale === 'en';
  const p = context.places.get(query.placeId);
  if (!p?.available)
    return { text: UNAVAILABLE[locale], sources: [], eligible: false, unavailable: true };
  const name = safeText(p.name) || SAFE_LABEL[locale];
  const decorate = (body: string, fact: VerifiedFact<unknown>) => {
    return (
      body +
      (fact.tier === 'verified_reference'
        ? en
          ? ` Reference information verified on ${fact.verifiedAt.slice(0, 10)}; it may have changed. Confirm with the place.`
          : ` Thông tin tham khảo, xác minh ngày ${fact.verifiedAt.slice(0, 10)}; có thể đã thay đổi; cần xác nhận với địa điểm.`
        : en
          ? ` (GoGo data dated ${fact.verifiedAt.slice(0, 10)})`
          : ` (Dữ liệu GoGo ngày ${fact.verifiedAt.slice(0, 10)})`)
    );
  };
  const result = (
    body: string,
    fact?: VerifiedFact<unknown> | readonly VerifiedFact<unknown>[],
    decorated = false,
  ): PlaceAnswer => {
    const facts: readonly VerifiedFact<unknown>[] = !fact
      ? []
      : Array.isArray(fact)
        ? fact
        : [fact as VerifiedFact<unknown>];
    const sources: RenderedSource[] = facts
      .filter((f) => eligible(f))
      .map((f) => ({
        topic,
        verifiedAt: f.verifiedAt,
        kind: f.source.kind as 'gogo' | 'community',
        collectedAt: f.source.collectedAt,
      }));
    return {
      text: `${name}: ${!decorated && facts.length === 1 ? decorate(body, facts[0]!) : body}`,
      sources,
      eligible: facts.length > 0,
      unavailable: false,
    };
  };
  // A direct price question is the one place a missing price is said in words
  // (owner Q-2); it still carries the generic card pointer, like every other
  // missing fact. Cards and other surfaces keep omitting an unknown price.
  const missing = () =>
    result(
      topic === 'price'
        ? en
          ? 'GoGo has no verified price for this place. ' + POINTER.en
          : 'GoGo chưa có giá đã xác minh của địa điểm này. ' + POINTER.vi
        : en
          ? 'GoGo has no verified data for this question. ' + POINTER.en
          : 'GoGo chưa có dữ liệu đã xác minh về việc này. ' + POINTER.vi,
    );
  if (topic === 'suitability' && query.n !== undefined) return result(UNSUPPORTED_CAPACITY[locale]);
  if (topic === 'out_of_data')
    return result(
      en
        ? 'GoGo has no data about this; please ask the place directly.'
        : 'GoGo chưa có dữ liệu về việc này; bạn nên hỏi trực tiếp địa điểm.',
    );
  if (topic === 'price') {
    const prices = validPrices(p);
    if (!prices.length) return missing();
    const text = prices
      .map(({ value: r, evidence }) =>
        decorate(
          r.min === 0 && r.max === 0
            ? en
              ? 'Free'
              : 'Miễn phí'
            : `${r.min === r.max ? amount(r.min, r.currency, locale) : `${amount(r.min, r.currency, locale)}–${amount(r.max, r.currency, locale)}`} ${r.currency}/${units[locale][r.unit]}`,
          evidence,
        ),
      )
      .join('; ');
    return result(
      text,
      prices.map((r) => r.evidence),
      true,
    );
  }
  if (topic === 'hours') {
    const schedules = (p.facts.hours ?? []).filter((schedule) => schedule.day === query.d);
    if (schedules.length !== 1) return missing();
    const intervals = schedules[0]!.intervals;
    if (!intervals.length || intervals.some((fact) => !eligible(fact, ['gogo']))) return missing();
    const rows = intervals.map((fact) => fact.value);
    if (
      !rows.length ||
      rows.some(
        (r) =>
          !['closed', 'open_24h', 'interval'].includes(r.kind) ||
          (r.kind === 'interval' &&
            (!Number.isInteger(r.openMinute) ||
              !Number.isInteger(r.closeMinute) ||
              r.openMinute! < 0 ||
              r.openMinute! >= 1440 ||
              r.closeMinute! < 0 ||
              r.closeMinute! >= 1440 ||
              (!r.overnight && r.closeMinute! <= r.openMinute!) ||
              (r.overnight && r.closeMinute! > r.openMinute!))),
      ) ||
      (rows.length > 1 && rows.some((r) => r.kind !== 'interval'))
    )
      return missing();
    const sorted = [...intervals].sort(
      (a, b) => (a.value.openMinute ?? 0) - (b.value.openMinute ?? 0),
    );
    if (
      sorted.some(
        (r, i) =>
          i > 0 &&
          (sorted[i - 1]!.value.overnight ||
            r.value.openMinute! < sorted[i - 1]!.value.closeMinute!),
      )
    )
      return missing();
    const body = sorted
      .map((fact) => {
        const r = fact.value;
        return decorate(
          r.kind === 'closed'
            ? en
              ? 'closed'
              : 'đóng cửa'
            : r.kind === 'open_24h'
              ? en
                ? 'open 24 hours'
                : 'mở cửa 24 giờ'
              : `${clock(r.openMinute!)}–${clock(r.closeMinute!)}${r.overnight ? (en ? ' next day' : ' hôm sau') : ''}`,
          fact,
        );
      })
      .join('; ');
    const heading = en
      ? `Regular weekly hours for ${weekdays.en[query.d!]}`
      : `Giờ mở cửa thường lệ ${weekdays.vi[query.d!]}`;
    const dateNote =
      query.day === 'date'
        ? en
          ? ` (requested date ${query.date}). Special-day/holiday exceptions are unavailable.`
          : ` (ngày được hỏi ${query.date}). GoGo chưa có ngoại lệ cho ngày đặc biệt/ngày lễ.`
        : '';
    return result(`${heading}: ${body}.${dateNote}`, sorted, true);
  }
  if (topic === 'address' || topic === 'directions' || topic === 'contact') {
    const fact = topic === 'contact' ? p.facts.contact : p.facts.address;
    return eligible(fact, ['gogo']) && typeof fact.value === 'string' && fact.value.trim()
      ? result(safeText(fact.value), fact)
      : missing();
  }
  if (topic === 'rating') {
    const fact = p.facts.rating;
    if (
      !eligible(fact, ['community']) ||
      fact.value.source !== 'community' ||
      !Number.isSafeInteger(fact.value.count) ||
      fact.value.count < 0
    )
      return missing();
    const { count, score } = fact.value;
    if (count < 5)
      return result(
        en
          ? `GoGo community: not enough ratings (${count} reviews).`
          : `Cộng đồng GoGo: chưa đủ lượt đánh giá (${count} lượt).`,
        fact,
      );
    return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 5
      ? result(`GoGo: ${score}/5 (${count}${en ? ' reviews' : ' lượt đánh giá'}).`, fact)
      : missing();
  }
  const facts =
    (topic === 'overview'
      ? p.facts.overview
      : topic === 'suitability'
        ? p.facts.suitability
        : p.facts.amenity) ?? [];
  const key =
    topic === 'parking' ? (query.k ?? 'parking') : topic === 'suitability' ? query.s : query.k;
  const entries = facts
    .filter((f) => eligible(f, ['gogo']))
    .flatMap((fact) =>
      fact.value
        .filter((v) => !key || v.key === key)
        .map((v) => ({ label: safeText(v.labels[locale]), fact })),
    )
    .filter((v) => v.label);
  if (!entries.length) return missing();
  return result(
    `${en ? 'GoGo records' : 'GoGo ghi nhận'}: ${entries.map((e) => decorate(e.label, e.fact)).join('; ')}.`,
    entries.map((e) => e.fact),
    true,
  );
}
/** Integer minor units, formatted without floating-point division or guessing VND for another currency. */
function amount(minor: number, currency: string, locale: 'vi' | 'en'): string {
  const exponent =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const scale = 10n ** BigInt(exponent),
    value = BigInt(minor);
  return `${value / scale}${exponent ? `${locale === 'vi' ? ',' : '.'}${(value % scale).toString().padStart(exponent, '0')}` : ''}`;
}
