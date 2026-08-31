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
 * Validates a wizard-supplied mapping against the canonical vocabulary.
 *
 * This is the only gate. `resolveMapping` used to skip any explicit choice it
 * did not recognise and quietly fall through to auto-detection, so a client
 * sending its own vocabulary (`googleMapsUrl` for `google_maps_url`) got a
 * successful import in which its mapping screen had done nothing at all. A
 * mapping the server cannot honour is now a rejected request, not a silent
 * downgrade — auto-detection is for columns the caller said nothing about.
 */
export function parseColumnMapping(raw: unknown): Record<string, CanonicalField> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidColumnMappingError([{ header: '(mapping)', value: String(raw) }]);
  }

  const out: Record<string, CanonicalField> = {};
  const invalid: InvalidMappingEntry[] = [];
  for (const [header, value] of Object.entries(raw as Record<string, unknown>)) {
    const trimmed = header.trim();
    // A blank header maps nothing; an empty value is how a wizard says
    // "ignore this column", which is not an error.
    if (!trimmed || value === '' || value === null || value === undefined) continue;
    if (isCanonicalField(value)) out[trimmed] = value;
    else invalid.push({ header: trimmed, value: String(value) });
  }
  if (invalid.length > 0) throw new InvalidColumnMappingError(invalid);
  return out;
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
  explicit?: Record<string, CanonicalField> | null,
): MappingResult {
  const mapping: Record<string, CanonicalField> = {};
  const unmapped: string[] = [];

  for (const header of headers) {
    const trimmed = header.trim();
    if (!trimmed) continue;

    // Already validated by `parseColumnMapping` at the edge, so an explicit
    // choice is authoritative: auto-detection only ever runs for a column the
    // caller did not name.
    const chosen = explicit?.[trimmed] ?? explicit?.[normalizeVietnamese(trimmed)];
    if (chosen) {
      mapping[trimmed] = chosen;
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
