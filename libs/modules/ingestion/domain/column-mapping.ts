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
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

const CANONICAL_SET = new Set<string>(CANONICAL_FIELDS);

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
  category: 'category',
  'gia min': 'price_min',
  'gia max': 'price_max',
  'don vi gia': 'price_unit',
  'doi tuong': 'audiences',
  vibes: 'vibes',
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
  explicit?: Record<string, string> | null,
): MappingResult {
  const mapping: Record<string, CanonicalField> = {};
  const unmapped: string[] = [];

  for (const header of headers) {
    const trimmed = header.trim();
    if (!trimmed) continue;

    const chosen = explicit?.[trimmed] ?? explicit?.[normalizeVietnamese(trimmed)];
    if (chosen && CANONICAL_SET.has(chosen)) {
      mapping[trimmed] = chosen as CanonicalField;
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
  const missing = (['source_row_id', 'city', 'category'] as CanonicalField[]).filter(
    (f) => !covered.has(f),
  );
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
