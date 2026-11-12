import { QA_COPY } from '../domain/place-qa/copy';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG } from '../../shared/config';
import type { AssistantFollowUpGroup, AssistantSourceData } from '../domain/assistant.types';
import type { PlaceCard } from './card-hydrator.service';
import {
  PLACE_FACTS_READER,
  type PlaceFactContext,
  type PlaceFacts,
  type PlaceFactsReader,
} from '../domain/place-qa/place-facts';
import { isPlaceAnswerRow, parseReferenceGroup } from '../domain/place-qa/reference-group';
import { confirmText } from '../domain/place-qa/pending';
import {
  answerQueries,
  hasMalformedCapacity,
  mapPrivateTokens,
  parseAnswerToken,
  type AnswerQuery,
} from '../domain/place-qa/tokens';
import {
  eligible,
  LOAD_ERROR,
  UNSUPPORTED_CAPACITY,
  POINTER,
  renderPlaceAnswer,
  SAFE_LABEL,
  safeText,
  validPrices,
} from '../domain/place-qa/templates';

export type ReadSurface = 'live' | 'replay' | 'history' | 'cms';
export type PlaceAnswerRow = {
  id: string;
  text: string;
  locale?: 'vi' | 'en' | null;
  trace?: Record<string, unknown> | null;
};
export type RenderedPlaceGroup = {
  text: string;
  cards: PlaceCard[];
  sources: AssistantSourceData[];
  followUps: AssistantFollowUpGroup[];
  result: 'ok' | 'unavailable' | 'read_error' | 'timeout' | 'unknown_token';
};
class RenderTimeout extends Error {}
/** Shared reader boundary; no default projection or fake production implementation. */
@Injectable()
export class PlaceAnswerReader {
  constructor(
    @Optional() @Inject(PLACE_FACTS_READER) private readonly port?: PlaceFactsReader,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional()
    @Inject(APP_CONFIG)
    private readonly config?: { ASSISTANT_FIRST_TEXT_TIMEOUT_MS: number },
  ) {}
  firstVisibleDeadline(acceptedAt: number): number {
    return acceptedAt + (this.config?.ASSISTANT_FIRST_TEXT_TIMEOUT_MS ?? 15000);
  }
  async page(
    rows: readonly PlaceAnswerRow[],
    surface: ReadSurface,
    options: { signal?: AbortSignal; acceptedAt?: number } = {},
  ): Promise<Map<string, RenderedPlaceGroup>> {
    const out = new Map<string, RenderedPlaceGroup>();
    const parsed = rows
      .filter(isPlaceAnswerRow)
      .map((row) => ({ row, group: parseReferenceGroup(row.trace?.placeAnswerGroup, row.text) }));
    if (!parsed.length) return out;
    const limit = surface === 'live' || surface === 'replay' ? 3 : 30;
    const ids: string[] = [];
    const overflow = new Set<string>();
    for (const { row, group } of parsed) {
      if (!group) continue;
      const extra = group.cards.filter((id) => !ids.includes(id));
      if (ids.length + extra.length > limit) overflow.add(row.id);
      else ids.push(...extra);
    }
    const started = Date.now();
    const allowance =
      surface === 'live' && options.acceptedAt !== undefined
        ? Math.min(2000, this.firstVisibleDeadline(options.acceptedAt) - started)
        : 2000;
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let context: PlaceFactContext = { places: new Map() };
    let failure: 'read_error' | 'timeout' | undefined;
    // Set by the allowance timer BEFORE it aborts: aborting rejects the
    // cancellation branch (and a cancellable adapter) synchronously, so the
    // race winner and the wall clock cannot decide timeout versus read error.
    let timedOut = false;
    try {
      if (allowance <= 0) throw new RenderTimeout();
      if (controller.signal.aborted) throw new Error('reader cancelled');
      if (ids.length) {
        if (!this.port) throw new Error('Place facts projection not installed');
        // Race bounds even an adapter that ignores cancellation. S2 must also
        // cancel SQL with the same absolute deadline; no late result is used.
        const deadlineAt = started + allowance;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new RenderTimeout());
            controller.abort();
          }, allowance);
        });
        const aborted = new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('reader cancelled')), {
            once: true,
          }),
        );
        const loaded = await Promise.race([
          this.port.placeFacts(ids, { signal: controller.signal, deadlineAt }),
          deadline,
          aborted,
        ]);
        // Copy and freeze each object/array: adapters cannot mutate this response's snapshot.
        context = {
          places: new Map(
            ids.flatMap((id) => {
              const p = loaded.places.get(id);
              if (p && p.id !== id) throw new Error('Mismatched place projection');
              return p ? [[id, freeze(structuredClone(p))] as const] : [];
            }),
          ),
        };
      }
    } catch (e) {
      failure =
        timedOut ||
        e instanceof RenderTimeout ||
        (allowance > 0 && Date.now() - started >= allowance)
          ? 'timeout'
          : 'read_error';
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      this.metrics.observe(
        'assistant_place_facts_duration_seconds',
        (Date.now() - started) / 1000,
        { surface },
      );
    }
    for (const { row, group } of parsed) {
      const locale = row.locale ?? answerQueries(row.text)[0]?.locale ?? 'vi';
      let rendered: RenderedPlaceGroup;
      try {
        if (!group)
          rendered = empty(
            hasMalformedCapacity(row.text) ? UNSUPPORTED_CAPACITY[locale] : SAFE_LABEL[locale],
            'unknown_token',
          );
        else if (group.kind === 'notice') rendered = empty(QA_COPY[group.message!][locale], 'ok');
        else if (overflow.has(row.id))
          rendered = {
            ...empty(
              `${
                answerQueries(row.text)
                  .map((q) => `${TOPIC_LABELS[locale][q.topic]}: ${SAFE_LABEL[locale]}`)
                  .join('\n') || SAFE_LABEL[locale]
              }. ${POINTER[locale]}`,
              'ok',
            ),
            cards: group.cards.map((id) => ({
              kind: 'place',
              placeId: id,
              available: true,
              facts: { name: SAFE_LABEL[locale] },
            })),
          };
        else if (failure) rendered = empty(LOAD_ERROR[locale], failure);
        else {
          let unknown = false,
            unavailable = false;
          const text = mapPrivateTokens(row.text, (token) => {
            const query = parseAnswerToken(token);
            if (query) {
              const a = renderPlaceAnswer(query, context);
              unavailable ||= a.unavailable;
              return a.text;
            }
            const match = /^\uE000place:([0-9a-f-]+)\uE001$/.exec(token);
            if (match && group.cards.includes(match[1]!)) {
              const p = context.places.get(match[1]!);
              return p?.available
                ? `${safeText(p.name)}${group.kind === 'clarification' && p.areaLabel ? ` ${locale === 'en' ? 'in' : 'ở'} ${safeText(p.areaLabel)}` : ''}`
                : SAFE_LABEL[locale];
            }
            unknown = true;
            return SAFE_LABEL[locale];
          });
          const used = answerQueries(row.text);
          const sources: AssistantSourceData[] = [];
          // Source queries must actually occur in rendered text, never metadata-only claims.
          for (const token of group.sources) {
            const query = parseAnswerToken(token)!;
            if (!used.some((q) => sameQuery(q, query))) continue;
            for (const source of renderPlaceAnswer(query, context).sources)
              sources.push({
                index: sources.length + 1,
                kind: 'place_data',
                title: source.kind === 'community' ? 'GoGo community' : 'GoGo',
                description: `${source.topic} · ${source.verifiedAt.slice(0, 10)}`,
              });
          }
          const opts = group.options.flatMap((o) => {
            if ('none' in o)
              return [
                {
                  id: o.id,
                  label: locale === 'en' ? 'None of these' : 'Không phải các quán này',
                  text: locale === 'en' ? 'None of these' : 'Không phải các quán này',
                },
              ];
            if ('placeId' in o) {
              const p = context.places.get(o.placeId);
              if (!p?.available) return [];
              const ordinal = group.cards.indexOf(o.placeId) + 1;
              const label = `${ordinal}. ${safeText(p.name)}`.slice(0, 40);
              // A one-candidate confirmation is answered by text that names the
              // candidate and is bound to this message; a bare ordinal is not
              // proof of which chip an old client tapped (shape rev3 §4.5).
              const text =
                group.prompt === 'place_confirm' && group.cards.length === 1
                  ? confirmText(locale, safeText(p.name), row.id, o.placeId)
                  : String(ordinal);
              return [{ id: o.id, label, text }];
            }
            const q = parseAnswerToken(o.query)!;
            const p = context.places.get(q.placeId);
            const a = renderPlaceAnswer(q, context);
            if (!p?.available || !a.eligible) return [];
            const label = TOPIC_LABELS[locale][q.topic];
            return [{ id: o.id, label, text: label }];
          });
          rendered = {
            text:
              group.kind === 'clarification'
                ? `${group.legacyArea ? (locale === 'en' ? 'GoGo does not search by old districts. ' : 'GoGo không tra theo quận/huyện cũ. ') : ''}${locale === 'en' ? 'Did you mean' : group.prompt === 'place_confirm' ? 'Ý bạn là' : 'Bạn muốn hỏi chi nhánh nào'}: ${text}?`
                : text,
            cards: group.cards.map((id) => card(context.places.get(id), id, locale)),
            sources,
            followUps: opts.length
              ? [
                  {
                    field:
                      group.kind === 'clarification'
                        ? (group.prompt ?? 'place_choice')
                        : 'place_topic',
                    label: locale === 'en' ? 'More about this place' : 'Thông tin khác',
                    options: opts,
                  },
                ]
              : [],
            result: unknown ? 'unknown_token' : unavailable ? 'unavailable' : 'ok',
          };
        }
      } catch {
        rendered = empty(LOAD_ERROR[locale], 'read_error');
      }
      if (
        group &&
        !overflow.has(row.id) &&
        Date.now() >= started + allowance &&
        rendered.result !== 'read_error'
      )
        rendered = empty(LOAD_ERROR[locale], 'timeout');
      this.metrics.increment('assistant_place_answer_render_total', {
        mode: surface,
        result: rendered.result,
      });
      out.set(row.id, rendered);
    }
    return out;
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
function empty(text: string, result: RenderedPlaceGroup['result']): RenderedPlaceGroup {
  return { text, cards: [], sources: [], followUps: [], result };
}
function sameQuery(a: AnswerQuery, b: AnswerQuery): boolean {
  return ['placeId', 'locale', 'topic', 'day', 'date', 'd', 'tz', 'k', 's', 'n'].every(
    (k) => a[k as keyof AnswerQuery] === b[k as keyof AnswerQuery],
  );
}
function card(p: PlaceFacts | undefined, id: string, locale: 'vi' | 'en'): PlaceCard {
  if (!p?.available)
    return { kind: 'place', placeId: id, available: false, facts: { name: SAFE_LABEL[locale] } };
  const price = validPrices(p).find(
    (v) => v.evidence.tier === 'verified_current' && v.value.unit === 'per_person',
  )?.value;
  const address =
    eligible(p.facts.address, ['gogo']) && p.facts.address.tier === 'verified_current'
      ? p.facts.address.value
      : undefined;
  const open =
    eligible(p.facts.openNow, ['gogo']) && p.facts.openNow.tier === 'verified_current'
      ? p.facts.openNow.value
      : undefined;
  const provider = p.facts.providerRating;
  const providerEligible =
    provider?.current === true &&
    provider.source.kind === 'google' &&
    Number.isFinite(Date.parse(provider.source.collectedAt)) &&
    Number.isFinite(provider.score) &&
    provider.score >= 0 &&
    provider.score <= 5 &&
    Number.isSafeInteger(provider.count) &&
    provider.count > 0;
  const community = p.facts.rating;
  const communityEligible =
    eligible(community, ['community']) &&
    community.tier === 'verified_current' &&
    community.value.source === 'community' &&
    Number.isSafeInteger(community.value.count) &&
    community.value.count >= 5 &&
    typeof community.value.score === 'number' &&
    Number.isFinite(community.value.score) &&
    community.value.score >= 0 &&
    community.value.score <= 5;
  return {
    kind: 'place',
    placeId: id,
    available: true,
    facts: {
      name: safeText(p.name),
      ...(providerEligible
        ? {
            providerRating: provider.score,
            providerRatingCount: provider.count,
            providerRatingSource: 'google' as const,
          }
        : {}),
      ...(communityEligible
        ? { gogoRating: community.value.score!, gogoRatingCount: community.value.count }
        : {}),
      ...(address ? { addressText: safeText(address) } : {}),
      ...(price ? { priceMin: price.min, priceMax: price.max, currency: price.currency } : {}),
      ...(typeof open === 'boolean' ? { openNow: open } : {}),
    },
  };
}

const TOPIC_LABELS = {
  vi: {
    hours: 'Giờ mở cửa',
    price: 'Giá',
    address: 'Địa chỉ',
    directions: 'Đường đi',
    parking: 'Chỗ đậu xe',
    amenity: 'Tiện ích',
    suitability: 'Mức độ phù hợp',
    rating: 'Đánh giá',
    contact: 'Liên hệ',
    overview: 'Tổng quan',
    out_of_data: 'Thông tin khác',
  },
  en: {
    hours: 'Hours',
    price: 'Price',
    address: 'Address',
    directions: 'Directions',
    parking: 'Parking',
    amenity: 'Amenities',
    suitability: 'Suitability',
    rating: 'Ratings',
    contact: 'Contact',
    overview: 'Overview',
    out_of_data: 'Other information',
  },
} as const;
