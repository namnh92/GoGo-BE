import { normalizeVietnamese } from '../../search/domain/normalize';
import { mapLegacyHeader } from './normalize-row';

/**
 * PI-BE-013 — header → canonical field resolution (spec §4.3 + §4.4).
 * An explicit wizard mapping always wins; the legacy GOGO sheet headers are
 * recognised automatically so the existing sheet imports without setup.
 */

export const CANONICAL_FIELDS = [
  'source_row_id',
  'name',
  'city',
  'district',
  'google_maps_url',
  'google_maps_query',
  'google_place_id',
  'category',
  'category_raw',
  'price_min',
  'price_max',
  'price_unit',
  'price_raw',
  'audiences',
  'audiences_raw',
  'vibes',
  'vibes_raw',
  'highlight',
  'note',
  /**
   * PI-BE-025 — GoGo-owned columns the schema has always had and the file could
   * never set. An operator with a phone number had to create the place, open
   * the editor and type it again, one place at a time.
   */
  'phone',
  'website',
  'avg_visit_minutes',
  'is_lodging',
  'curated_rank',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

const CANONICAL_SET = new Set<string>(CANONICAL_FIELDS);

export function isCanonicalField(value: unknown): value is CanonicalField {
  return typeof value === 'string' && CANONICAL_SET.has(value);
}

/** One offending column, so the caller can point at the row that is wrong. */
export type InvalidMappingEntry = { header: string; value: string };

export class InvalidColumnMappingError extends Error {
  constructor(readonly entries: InvalidMappingEntry[]) {
    super(
      `mapping có canonical field không hợp lệ: ${entries
        .map((e) => `${e.header} → ${e.value}`)
        .join(', ')}`,
    );
    this.name = 'InvalidColumnMappingError';
  }
}

/**
 * Legacy field names the shipped CMS wizard emitted, and where they belong.
 *
 * Audited, not guessed: `MAPPABLE_FIELDS` and `HEADER_HINTS` in GoGo-CMS are
 * identical across every commit that has ever contained them (`3efb5bd`,
 * `fa951e6`, `e33cfc6`, `origin/develop`), and between them they emit exactly
 * eleven values. Five were already canonical; these three differ from a real
 * canonical field only in spelling.
 *
 * Compatibility only. They are not offered as choices anywhere, and nothing
 * new should ever be added here — a new client writes canonical names.
 */
export const LEGACY_FIELD_ALIASES: Readonly<Record<string, CanonicalField>> = {
  googleMapsUrl: 'google_maps_url',
  priceMin: 'price_min',
  priceMax: 'price_max',
};

/**
 * Shipped mapping values that never had anywhere to go: no canonical field, no
 * column on `places`, nothing downstream that could store them.
 *
 * `phone` and `website` were here until PI-BE-025 and are not any more — they
 * are canonical fields now, with columns, normalization and provenance, so
 * mapping a header onto them stores a value instead of dropping one. `address`
 * stays: `places.address_text` is written from the provider's formatted
 * address, and a sheet's own address string has no writer and no meaning
 * beside it.
 *
 * `/v1` answered 200 and ignored them, so turning them into a hard 400 would
 * be a behavioural break for the sake of tidiness. They stay accepted and the
 * column is skipped — but the header is now reported in `unmappedHeaders`, so
 * the outcome is visible instead of silent. Whether GoGo should hold this data
 * at all is a catalog question, not an import one.
 */
export const RETIRED_FIELDS: readonly string[] = ['address'];

export type ColumnMappingResult = {
  mapping: Record<string, CanonicalField>;
  /** Normalised from a legacy spelling. Worth logging, not worth failing. */
  normalizedLegacy: { header: string; from: string; to: CanonicalField }[];
  /** Accepted for compatibility, mapped nowhere; the column is skipped. */
  retired: { header: string; value: string }[];
  /**
   * A value in no vocabulary at all — a typo, or a client's invented name.
   * `/v1` accepted these, so they stay accepted; the column they claimed is
   * left unmapped rather than auto-detected, so the mistake is visible.
   */
  unknown: { header: string; value: string }[];
};

/**
 * Headers an explicit mapping claimed but could not use. Auto-detection must
 * not run for these: the operator did choose something, and quietly detecting
 * a different field would hide the mistake exactly the way the old silent
 * fall-through did.
 */
export function unusableHeaders(result: ColumnMappingResult): Set<string> {
  return new Set(result.unknown.map((entry) => entry.header));
}

/**
 * Validates a wizard-supplied mapping against the canonical vocabulary.
 *
 * `resolveMapping` used to skip any explicit choice it did not recognise and
 * quietly fall through to auto-detection, so a client sending its own
 * vocabulary (`googleMapsUrl` for `google_maps_url`) got a successful import
 * in which its mapping screen had done nothing at all.
 *
 * Nothing here rejects a mapping. `/v1` answered 200 for every value a client
 * could put in this object, so it still does: canonical values are used, the
 * three legacy spellings normalise, and everything else — the three retired
 * fields and any unknown value — leaves its column unmapped. Strict rejection
 * of an unknown value is a `/v2` change.
 *
 * What is no longer true is that an unusable choice silently becomes a
 * different field: the column stays unmapped, is reported, and is counted.
 *
 * A mapping that is not an object at all is still a bad request — that was a
 * 400 in `/v1` too, from the schema layer above this one.
 */
export function parseColumnMapping(raw: unknown): ColumnMappingResult {
  const result: ColumnMappingResult = {
    mapping: {},
    normalizedLegacy: [],
    retired: [],
    unknown: [],
  };
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidColumnMappingError([{ header: '(mapping)', value: String(raw) }]);
  }

  for (const [header, value] of Object.entries(raw as Record<string, unknown>)) {
    const trimmed = header.trim();
    // A blank header maps nothing; an empty value is how a wizard says
    // "ignore this column", which is not an error.
    if (!trimmed || value === '' || value === null || value === undefined) continue;

    if (isCanonicalField(value)) {
      result.mapping[trimmed] = value;
      continue;
    }
    const alias = typeof value === 'string' ? LEGACY_FIELD_ALIASES[value] : undefined;
    if (alias) {
      // Behaves exactly like an explicit canonical mapping from here on.
      result.mapping[trimmed] = alias;
      result.normalizedLegacy.push({ header: trimmed, from: value as string, to: alias });
      continue;
    }
    if (typeof value === 'string' && RETIRED_FIELDS.includes(value)) {
      result.retired.push({ header: trimmed, value });
      continue;
    }
    result.unknown.push({ header: trimmed, value: String(value) });
  }
  return result;
}

/** Canonical headers as they appear in the published template. */
const TEMPLATE_ALIASES: Record<string, CanonicalField> = {
  'source row id': 'source_row_id',
  id: 'source_row_id',
  'ten dia diem': 'name',
  'thanh pho': 'city',
  city: 'city',
  'quan/huyen': 'district',
  district: 'district',
  'google maps url': 'google_maps_url',
  'google maps': 'google_maps_url',
  'google place id': 'google_place_id',
  'place id': 'google_place_id',
  'ma dia diem google': 'google_place_id',
  category: 'category',
  'gia min': 'price_min',
  'gia max': 'price_max',
  'don vi gia': 'price_unit',
  'doi tuong': 'audiences',
  vibes: 'vibes',
  'so dien thoai': 'phone',
  'dien thoai': 'phone',
  phone: 'phone',
  website: 'website',
  'thoi luong ghe': 'avg_visit_minutes',
  'luu tru': 'is_lodging',
  'thu tu tuyen chon': 'curated_rank',
  highlight: 'highlight',
  'ghi chu': 'note',
};

export type MappingResult = {
  /** Raw header → canonical field. Headers absent from this map are ignored. */
  mapping: Record<string, CanonicalField>;
  unmapped: string[];
  /** Canonical fields not covered by any header. */
  missing: CanonicalField[];
};

export function resolveMapping(
  headers: string[],
  explicit?: Record<string, CanonicalField> | null,
  /** Headers whose explicit choice was unusable — see `unusableHeaders`. */
  unusable?: ReadonlySet<string> | null,
): MappingResult {
  const mapping: Record<string, CanonicalField> = {};
  const unmapped: string[] = [];

  for (const header of headers) {
    const trimmed = header.trim();
    if (!trimmed) continue;

    // Resolved by `parseColumnMapping` at the edge, so an explicit choice is
    // authoritative: auto-detection only ever runs for a column the caller did
    // not name.
    const chosen = explicit?.[trimmed] ?? explicit?.[normalizeVietnamese(trimmed)];
    if (chosen) {
      mapping[trimmed] = chosen;
      continue;
    }
    // The caller named this column but the value was unusable. Detecting some
    // other field for it would hide the mistake all over again.
    if (unusable?.has(trimmed)) {
      unmapped.push(trimmed);
      continue;
    }
    const normalized = normalizeVietnamese(trimmed);
    const snake = normalized.replace(/[\s-]+/g, '_');
    if (CANONICAL_SET.has(snake)) {
      mapping[trimmed] = snake as CanonicalField;
      continue;
    }
    const alias = TEMPLATE_ALIASES[normalized] ?? (mapLegacyHeader(trimmed) as CanonicalField);
    if (alias && CANONICAL_SET.has(alias)) {
      mapping[trimmed] = alias;
      continue;
    }
    unmapped.push(trimmed);
  }

  const covered = new Set(Object.values(mapping));
  /**
   * ADR-0019 §7b — `city` is a search hint, and a sheet that identifies its
   * places outright has no text search to narrow.
   *
   * Requiring it there said, in the one screen an operator reads before
   * importing, that GoGo files places under a city. It does not: the
   * administrative identity comes from the coordinate the identity resolves to.
   *
   * PI-BE-024 adds `google_place_id` to that set. A Place ID is the strongest
   * identity a sheet can carry — it needs no search at all — so demanding a
   * city beside it would be the same mistake, spelled differently.
   */
  const linked =
    covered.has('google_maps_url') ||
    covered.has('google_maps_query') ||
    covered.has('google_place_id');
  const required: CanonicalField[] = linked
    ? ['source_row_id', 'category']
    : ['source_row_id', 'city', 'category'];
  const missing = required.filter((f) => !covered.has(f));
  return { mapping, unmapped, missing };
}

/** Row cells → canonical record. Extra cells beyond the header are dropped. */
export function applyMapping(
  headers: string[],
  cells: string[],
  mapping: Record<string, CanonicalField>,
): Partial<Record<CanonicalField, string>> {
  const out: Partial<Record<CanonicalField, string>> = {};
  headers.forEach((header, i) => {
    const field = mapping[header.trim()];
    if (!field) return;
    const value = (cells[i] ?? '').trim();
    if (value) out[field] = value;
  });
  return out;
}
