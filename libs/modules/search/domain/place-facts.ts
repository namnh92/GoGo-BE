import type {
  PlaceFacts,
  PlaceFactContext,
  PriceFact,
  ScheduleFact,
  VerifiedFact,
} from '../../assistant/domain/place-qa/place-facts';
import { renderPlaceAnswer, validPrices } from '../../assistant/domain/place-qa/templates';
import type { AnswerQuery, AnswerTopic } from '../../assistant/domain/place-qa/tokens';
import {
  contactOwnership,
  normalizeAddress,
  normalizePhone,
  validateEvidence,
} from '../../shared/place-contact';
import { toGogoRating } from '../../reviews/domain/gogo-rating';

type Fact<T> =
  | {
      tier: 'absent';
      reason:
        'missing' | 'unverified' | 'provenance' | 'malformed' | 'policy_missing' | 'unsupported';
    }
  | { tier: 'verified_current'; value: T; source: 'gogo'; policy: 'ADR-0028' }
  | {
      tier: 'verified_reference';
      value: T;
      source: 'editor' | 'bill_checkin' | 'gogo';
      verifiedAt: string;
      collectedAt?: string;
      warning: 'confirm_with_place';
    };
type PlacePriceFact = PriceFact & {
  confidence: number;
};
export type ProvenanceRow = {
  field: string;
  source_type: string;
  source_reference: string | null;
  collected_at: string | null;
  verified_at: string | null;
};
export type HoursFactRow = {
  day_of_week: number;
  entry_kind: string;
  open_minute: number;
  close_minute: number;
  is_overnight: boolean;
  source: string;
  verified_at: string | null;
};
export type PriceFactRow = {
  price_min: string | number | null;
  price_max: string | number | null;
  currency: string | null;
  unit: string | null;
  confidence: string | number | null;
  source: string;
  verified_at: string | null;
};
export type PlaceFactRow = {
  id: string;
  status: string;
  provider_closed: boolean;
  name: string;
  lat: number;
  lng: number;
  area_summary: unknown;
  province_name?: string | null;
  address_text: string | null;
  phone: string | null;
  provenance: ProvenanceRow[];
  hours: HoursFactRow[];
  prices: PriceFactRow[];
  /** Read for policy evaluation; these tables have no verified assignment path. */
  taxonomies?: { kind: string; key: string; active: boolean }[];
  suitability?: Record<string, number> | null;
  provider_sources?: {
    provider: string;
    rating: string | null;
    rating_count: number | null;
    fetched_at: string;
    refresh_after: string | null;
    attribution: unknown;
  }[];
  gogo_rating_count: number;
  gogo_rating_mean: string | null;
  gogo_rating_verified_at?: string | null;
  gogo_rating_collected_at?: string | null;
  /** Newest moderation/collection instants across ALL published reviews. */
  gogo_rating_latest_verified_at?: string | null;
  gogo_rating_latest_collected_at?: string | null;
};
const absent = (reason: Extract<Fact<never>, { tier: 'absent' }>['reason']): Fact<never> => ({
  tier: 'absent',
  reason,
});
const instant = (raw: string | null, now: Date): string | undefined => {
  if (!raw) return;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) && date <= now ? date.toISOString() : undefined;
};
function reference<T>(
  value: T,
  source: 'editor' | 'bill_checkin' | 'gogo',
  verifiedAt: string,
): Fact<T> {
  return { tier: 'verified_reference', value, source, verifiedAt, warning: 'confirm_with_place' };
}
function contact(
  value: string | null,
  evidence: ProvenanceRow | undefined,
  field: 'address_text' | 'phone',
  now: Date,
): Fact<string> {
  if (!value) return absent('missing');
  const normalized = field === 'phone' ? normalizePhone(value) : normalizeAddress(value);
  if (!normalized.ok) return absent('malformed');
  if (!evidence || contactOwnership(evidence) !== 'gogo') return absent('provenance');
  const checked = validateEvidence(
    {
      sourceType: evidence.source_type,
      sourceReference: evidence.source_reference,
      collectedAt: evidence.collected_at,
    },
    { sourceType: 'sourceType', sourceReference: 'sourceReference', collectedAt: 'collectedAt' },
    now,
  );
  if (!checked.ok) return absent('provenance');
  const verifiedAt = instant(evidence.verified_at, now);
  if (!verifiedAt) return absent('unverified');
  return {
    ...reference(normalized.value, 'gogo', verifiedAt),
    collectedAt: checked.value.collectedAt,
  } as Fact<string>;
}
const safeMinor = (raw: string | number | null): number | undefined => {
  if (raw === null || (typeof raw === 'string' && !/^\d+$/.test(raw))) return;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};
export function priceFact(row: PriceFactRow, now: Date): Fact<PlacePriceFact> {
  const min = safeMinor(row.price_min),
    max = safeMinor(row.price_max);
  const confidence = row.confidence === null ? NaN : Number(row.confidence);
  if (
    min === undefined ||
    max === undefined ||
    max < min ||
    !['per_person', 'per_item', 'per_hour', 'per_night'].includes(row.unit ?? '') ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return absent('malformed');
  // ADR-0006: stored provider prices are not independently verified GoGo prices.
  if (row.source !== 'editor' && row.source !== 'bill_checkin') return absent('provenance');
  const verifiedAt = instant(row.verified_at, now);
  if (!verifiedAt) return absent('unverified');
  // No authoritative QA freshness/TTL policy exists. Never substitute the place date.
  const fact = reference(
    { min, max, currency: row.currency!, unit: row.unit as PlacePriceFact['unit'], confidence },
    row.source,
    verifiedAt,
  );
  // Reuse S1's complete price validation, including its supported-currency set.
  const bundle = verifiedReference(fact);
  return bundle &&
    validPrices({
      id: '',
      name: '',
      available: true,
      facts: { price: [{ ...bundle, value: [bundle.value] }] },
    }).length
    ? fact
    : absent('malformed');
}
function verifiedReference<T>(fact: Fact<T>): VerifiedFact<T> | undefined {
  if (fact.tier !== 'verified_reference') return;
  return {
    tier: fact.tier,
    value: fact.value,
    verifiedAt: fact.verifiedAt,
    // For editor/bill verification rows, this dates the stored verification
    // evidence event itself, not an inferred original observation. Contacts
    // carry their separate, independently validated collection timestamp.
    source: { kind: 'gogo', collectedAt: fact.collectedAt ?? fact.verifiedAt },
  };
}
function hoursFact(rows: HoursFactRow[], now: Date): ScheduleFact['intervals'] | undefined {
  if (!rows.length) return undefined;
  if (
    rows.some(
      (h) =>
        !['interval', 'closed', 'open_24h'].includes(h.entry_kind) ||
        !Number.isInteger(h.open_minute) ||
        !Number.isInteger(h.close_minute) ||
        h.open_minute < 0 ||
        h.open_minute > 1439 ||
        h.close_minute < 0 ||
        h.close_minute > 1439 ||
        typeof h.is_overnight !== 'boolean' ||
        (h.entry_kind !== 'interval'
          ? rows.length !== 1 || h.open_minute !== 0 || h.close_minute !== 0 || h.is_overnight
          : h.is_overnight
            ? h.open_minute <= h.close_minute
            : h.open_minute >= h.close_minute),
    )
  )
    return undefined;
  const sorted = [...rows].sort((a, b) => a.open_minute - b.open_minute);
  if (
    sorted.some(
      (h, i) =>
        i > 0 && (sorted[i - 1]!.is_overnight || sorted[i - 1]!.close_minute > h.open_minute),
    )
  )
    return undefined;
  if (rows.some((h) => h.source !== 'editor')) return undefined;
  const dates = rows.map((h) => instant(h.verified_at, now));
  if (dates.some((d) => !d)) return undefined;
  return sorted.map((h) => {
    const verifiedAt = instant(h.verified_at, now)!;
    return {
      tier: 'verified_reference',
      verifiedAt,
      source: { kind: 'gogo', collectedAt: verifiedAt },
      value: {
        kind: h.entry_kind as 'interval' | 'closed' | 'open_24h',
        ...(h.entry_kind === 'interval'
          ? { openMinute: h.open_minute, closeMinute: h.close_minute, overnight: h.is_overnight }
          : {}),
      },
    };
  });
}

/** No raw unconfirmed value survives this boundary. Ownership is never verification. */
export function projectPlaceFacts(row: PlaceFactRow, now: Date): PlaceFacts {
  if (row.status !== 'published' || row.provider_closed)
    return { id: row.id, available: false, name: '', facts: {} };
  const hours: Record<number, ScheduleFact['intervals'] | undefined> = {};
  for (let day = 0; day < 7; day++)
    hours[day] = hoursFact(
      row.hours.filter((h) => h.day_of_week === day),
      now,
    );
  if (
    row.hours.some(
      (h) => !Number.isInteger(h.day_of_week) || h.day_of_week < 0 || h.day_of_week > 6,
    )
  )
    for (let day = 0; day < 7; day++) hours[day] = undefined;
  // Check cross-midnight overlap against the next day's regular intervals.
  for (let day = 0; day < 7; day++) {
    const overnight = row.hours.filter(
      (h) => h.day_of_week === day && h.entry_kind === 'interval' && h.is_overnight,
    );
    const next = (day + 1) % 7;
    if (
      overnight.some((h) =>
        row.hours.some(
          (n) =>
            n.day_of_week === next &&
            (n.entry_kind === 'open_24h' ||
              (n.entry_kind === 'closed' && h.close_minute > 0) ||
              (n.entry_kind === 'interval' && n.open_minute < h.close_minute)),
        ),
      )
    ) {
      hours[day] = undefined;
      hours[next] = undefined;
    }
  }
  const community = toGogoRating(row.gogo_rating_count, row.gogo_rating_mean);
  if (community.gogoRating !== undefined && (community.gogoRating < 1 || community.gogoRating > 5))
    throw new Error('Invalid community rating aggregate');
  const schedules: ScheduleFact[] = [];
  for (let day = 0; day < 7; day++) {
    const intervals = hours[day];
    if (intervals) schedules.push({ day, intervals });
  }
  const prices: VerifiedFact<readonly PriceFact[]>[] = row.prices.flatMap((p) => {
    const fact = verifiedReference(priceFact(p, now));
    if (!fact) return [];
    const { min, max, currency, unit } = fact.value;
    return [{ ...fact, value: [{ min, max, currency, unit }] }];
  });
  const address = verifiedReference(
    contact(
      row.address_text,
      row.provenance.find((p) => p.field === 'address_text'),
      'address_text',
      now,
    ),
  );
  const phone = verifiedReference(
    contact(
      row.phone,
      row.provenance.find((p) => p.field === 'phone'),
      'phone',
      now,
    ),
  );
  const ratingVerified = instant(row.gogo_rating_verified_at ?? null, now);
  const ratingCollected = instant(row.gogo_rating_collected_at ?? null, now);
  // The count/mean cover every published review, so every one of them needs
  // past-dated evidence: the oldest row cannot vouch for a future-dated one.
  // Judged on the same clock as every other fact, never the database's.
  const ratingEvidenceComplete =
    !!instant(row.gogo_rating_latest_verified_at ?? null, now) &&
    !!instant(row.gogo_rating_latest_collected_at ?? null, now);
  return {
    id: row.id,
    available: true,
    name: row.name,
    ...(row.area_summary &&
    typeof row.area_summary === 'object' &&
    'label' in row.area_summary &&
    typeof row.area_summary.label === 'string'
      ? {
          areaLabel: [
            ...new Set([row.area_summary.label, row.province_name].filter((v): v is string => !!v)),
          ].join(', '),
        }
      : {}),
    facts: {
      ...(schedules.length ? { hours: schedules } : {}),
      ...(prices.length ? { price: prices } : {}),
      ...(address ? { address } : {}),
      ...(phone ? { contact: phone } : {}),
      // Use actual review moderation/collection evidence only. Legacy/missing
      // dates cannot be replaced with the snapshot time or place freshness.
      ...(ratingVerified && ratingCollected && ratingEvidenceComplete
        ? {
            rating: {
              tier: 'verified_current' as const,
              value: {
                source: 'community' as const,
                count: community.gogoRatingCount,
                score: community.gogoRating ?? null,
              },
              verifiedAt: ratingVerified,
              source: { kind: 'community' as const, collectedAt: ratingCollected },
            },
          }
        : {}),
      // No assignment verification, present-time policy, or safe provider prose
      // attribution path exists: omit those fields in S1's contract.
    },
  };
}
export function placeTopicEligible(
  facts: PlaceFacts,
  topic: AnswerTopic,
  args: { day?: number; key?: string; capacity?: number } = {},
): boolean {
  if (!facts.available || (topic === 'hours' && args.day === undefined)) return false;
  // Use exactly the renderer's evidence/value gates for every offered topic.
  const query: AnswerQuery = {
    placeId: facts.id,
    topic,
    locale: 'vi',
    ...(topic === 'hours' ? { day: 'weekday' as const, d: args.day } : {}),
    ...(args.key ? { k: args.key, s: args.key } : {}),
    ...(args.capacity !== undefined ? { n: args.capacity } : {}),
  };
  return renderPlaceAnswer(query, { places: new Map([[facts.id, facts]]) }).eligible;
}

/** Reference values require date + warning; compact dynamic card fields require current. */
export function factForSurface<T>(
  fact: Fact<T> | VerifiedFact<T>,
  surface: 'prose' | 'card',
  canShowReferenceWarning: boolean,
): Fact<T> | VerifiedFact<T> {
  return fact.tier === 'verified_reference' && (surface === 'card' || !canShowReferenceWarning)
    ? absent('policy_missing')
    : fact;
}

export function freezeFactContext(places: ReadonlyMap<string, PlaceFacts>): PlaceFactContext {
  function freeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  const snapshot = new Map([...places].map(([id, place]) => [id, freeze(place)]));
  // Object.freeze(Map) still allows .set/.delete. Expose only a read-only view.
  const view: ReadonlyMap<string, PlaceFacts> = Object.freeze({
    size: snapshot.size,
    get: snapshot.get.bind(snapshot),
    has: snapshot.has.bind(snapshot),
    entries: snapshot.entries.bind(snapshot),
    keys: snapshot.keys.bind(snapshot),
    values: snapshot.values.bind(snapshot),
    [Symbol.iterator]: snapshot[Symbol.iterator].bind(snapshot),
    forEach: (
      callback: (value: PlaceFacts, key: string, map: ReadonlyMap<string, PlaceFacts>) => void,
      thisArg?: unknown,
    ) => snapshot.forEach((value, key) => callback.call(thisArg, value, key, view)),
  });
  return Object.freeze({ places: view });
}
