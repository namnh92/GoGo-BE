import type { IngestMessage } from '@gogo/database';
import { parseMapsUrl } from './maps-url';
import { parseAudiences, parsePrice, parseVibes, type PriceUnit } from './normalize-row';
import type { CanonicalField } from './column-mapping';
import { INGEST_LIMITS } from './tabular/limits';

/**
 * PI-BE-011/013 — template validation + normalization (spec §4.3).
 *
 * Errors block the row; warnings let it through for an editor to resolve.
 * Nothing here touches the network or the catalog: it is a pure function of
 * the row, so dry-run costs nothing and a retry repeats identically.
 */

const PRICE_UNITS: PriceUnit[] = ['per_person', 'per_group', 'per_item', 'free', 'unknown'];

export type NormalizedImportRow = {
  sourceRowId: string;
  name: string | null;
  city: string | null;
  district: string | null;
  googleMapsUrl: string | null;
  /** Set when the sheet holds a place name instead of a link (spec §4.4). */
  googleMapsQuery: string | null;
  /**
   * PI-BE-024 — the Google Place ID the sheet named outright.
   *
   * The strongest identity a row can carry: no redirect hop, no text search, no
   * scoring. It is also the provider dedup key, so a sheet that has one is
   * saying exactly which catalogue row its place is or would be.
   *
   * Kept apart from `googleMapsUrl` rather than folded into it. An operator who
   * has an id should write the id; making them wrap it in a
   * `google.com/maps?place_id=…` URL to be understood was asking them to
   * construct a fake link to state a plain fact.
   */
  googlePlaceId: string | null;
  categoryKey: string | null;
  categoryRaw: string | null;
  priceMin: number | null;
  priceMax: number | null;
  priceUnit: PriceUnit;
  audiences: string[];
  vibes: string[];
  highlight: string | null;
  note: string | null;
};

export type ValidatedRow = {
  normalized: NormalizedImportRow;
  errors: IngestMessage[];
  warnings: IngestMessage[];
};

export type ValidationContext = {
  defaultCity?: string | null;
  /** Taxonomy keys that exist today. Unknown keys never create taxonomy. */
  knownCategoryKeys?: ReadonlySet<string>;
  knownVibeKeys?: ReadonlySet<string>;
  knownAudienceKeys?: ReadonlySet<string>;
  /**
   * Identity of last resort for a sheet with no `source_row_id` column.
   *
   * **Positional, therefore not stable.** `Tab#12` names whatever row sits
   * twelfth today; insert a row above it and the same place imports under a
   * different id, while `Tab#12` now points at its neighbour. Re-importing an
   * edited sheet is the case that breaks: `(job_id, source_row_id)` no longer
   * lines up with the previous job, so `update_existing` re-resolves rows it
   * had already matched.
   *
   * A caller passing this is saying "positional identity beats refusing the
   * file" — true for a first import, false for a sheet meant to be re-synced.
   * Callers must bound it to 100 chars; it is not length-checked here.
   *
   * Intended precedence once the stronger sources are wired (issue #274):
   * explicit `source_row_id` > Google Place ID > normalized Maps URL identity
   * > this positional fallback.
   */
  fallbackRowId?: string | null;
};

const msg = (code: string, field: string, message: string): IngestMessage => ({
  code,
  field,
  message,
});

function parseInteger(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const digits = raw.replace(/[.,\s]/g, '');
  if (!/^\d+$/.test(digits)) return NaN;
  return Number(digits);
}

export function validateRow(
  raw: Partial<Record<CanonicalField, string>>,
  ctx: ValidationContext = {},
): ValidatedRow {
  const errors: IngestMessage[] = [];
  const warnings: IngestMessage[] = [];

  // The sheet's own id wins whenever it has one; the fallback only fills a gap.
  // Length is checked on the authored value only — a derived id is constructed
  // by the caller within the limit, and truncating it here would silently make
  // two rows share an identity.
  let sourceRowId = (raw.source_row_id ?? '').trim();
  if (sourceRowId) {
    if (sourceRowId.length > 100) {
      errors.push(msg('ROW_ID_TOO_LONG', 'source_row_id', 'source_row_id tối đa 100 ký tự'));
    }
  } else {
    const fallback = ctx.fallbackRowId?.trim() || null;
    if (fallback) {
      sourceRowId = fallback;
      warnings.push(
        msg(
          'ROW_ID_DERIVED',
          'source_row_id',
          `source_row_id suy ra từ vị trí dòng: ${fallback}. ` +
            `Thêm cột source_row_id nếu sheet này còn được import lại — ` +
            `chèn hoặc đổi thứ tự dòng sẽ đổi định danh.`,
        ),
      );
    } else {
      errors.push(msg('ROW_ID_MISSING', 'source_row_id', 'source_row_id là bắt buộc'));
    }
  }

  const name = raw.name?.trim() || null;
  const city = raw.city?.trim() || ctx.defaultCity?.trim() || null;

  /**
   * PI-BE-024 — the same shape `placeCreateSchema` accepts, and the same shape
   * Google's own share links carry. Validated here rather than at resolve time
   * so a typo costs no provider request.
   */
  let googlePlaceId: string | null = raw.google_place_id?.trim() || null;
  if (googlePlaceId && !/^[\w-]{6,255}$/.test(googlePlaceId)) {
    errors.push(
      msg('PLACE_ID_INVALID', 'google_place_id', `Google Place ID không hợp lệ: ${googlePlaceId}`),
    );
    googlePlaceId = null;
  }

  // A row must be resolvable: a Place ID, a maps link, or a name to search with.
  let googleMapsUrl: string | null = null;
  let googleMapsQuery: string | null = raw.google_maps_query?.trim() || null;
  const rawUrl = raw.google_maps_url?.trim();
  if (rawUrl) {
    if (/^https?:\/\//i.test(rawUrl)) {
      const parsed = parseMapsUrl(rawUrl);
      if (parsed.ok) googleMapsUrl = rawUrl;
      else {
        errors.push(
          msg('URL_INVALID', 'google_maps_url', `Link không hợp lệ: ${parsed.reasonCode}`),
        );
      }
    } else {
      // Legacy sheets put a plain place name in the link column.
      googleMapsQuery = rawUrl;
    }
  }

  /**
   * ADR-0019 §7b — `city` is a **search hint**, and a row that already names the
   * place outright does not need one.
   *
   * It was required unconditionally, which read as though GoGo filed places
   * under it. It does not: the administrative identity comes from the
   * coordinate. What the string is actually for is narrowing a provider text
   * search, so it is required exactly where a text search is what will happen —
   * a row with no link and no explicit query — and not where the row carries a
   * Google Maps link that names the place by id.
   */
  if (!city && !googleMapsUrl && !googleMapsQuery && !googlePlaceId) {
    errors.push(
      msg(
        'CITY_REQUIRED',
        'city',
        'city là bắt buộc khi dòng không có link Google Maps hoặc Google Place ID — ' +
          'nó là gợi ý để tìm địa điểm',
      ),
    );
  }
  // Anything the resolver can turn into a provider lookup: an id, a link, an
  // explicit query, or a name it can search for.
  const resolvable = Boolean(googlePlaceId || googleMapsUrl || googleMapsQuery || name);
  if (!resolvable) {
    errors.push(
      msg('NAME_REQUIRED', 'name', 'Cần name, google_maps_url hoặc google_place_id để resolve'),
    );
  }

  const categoryRaw = raw.category_raw?.trim() || null;
  let categoryKey = raw.category?.trim() || null;
  if (!categoryKey && !categoryRaw) {
    // PI-BE-023 — a row that names a place Google can find does not need an
    // operator to guess a category for it: `types[]` says what the place is,
    // and resolution happens a few steps later in this same job. Blocking here
    // was what made every sheet carry a category column, which is what made
    // editors write `rooftop` and `attraction` — values from GoGo's `setting`
    // taxonomy and from no taxonomy at all — into a `category` field.
    //
    // Still an error for a row nothing can be resolved from, and still an
    // error later if Google turns out to describe the place in terms GoGo has
    // no category for. The requirement did not go away; it moved to the point
    // where it can be answered.
    if (resolvable) {
      warnings.push(
        msg(
          'CATEGORY_PENDING_PROVIDER',
          'category',
          'category để trống — sẽ suy ra từ dữ liệu Google khi resolve',
        ),
      );
    } else {
      errors.push(msg('CATEGORY_REQUIRED', 'category', 'category là bắt buộc'));
    }
  }
  if (categoryKey && ctx.knownCategoryKeys && !ctx.knownCategoryKeys.has(categoryKey)) {
    errors.push(msg('CATEGORY_UNKNOWN', 'category', `Taxonomy key không tồn tại: ${categoryKey}`));
    categoryKey = null;
  }
  if (!categoryKey && categoryRaw) {
    // Free-text category needs an editor decision — never auto-created.
    warnings.push(msg('CATEGORY_UNMAPPED', 'category_raw', `Chưa map được: ${categoryRaw}`));
  }

  let priceMin = parseInteger(raw.price_min);
  let priceMax = parseInteger(raw.price_max);
  let priceUnit: PriceUnit = 'unknown';

  if (Number.isNaN(priceMin) || Number.isNaN(priceMax)) {
    errors.push(msg('PRICE_INVALID', 'price_min', 'Giá phải là số nguyên VND'));
    priceMin = null;
    priceMax = null;
  }
  const unitRaw = raw.price_unit?.trim();
  if (unitRaw) {
    if (PRICE_UNITS.includes(unitRaw as PriceUnit)) priceUnit = unitRaw as PriceUnit;
    else
      errors.push(msg('PRICE_UNIT_INVALID', 'price_unit', `price_unit không hợp lệ: ${unitRaw}`));
  }
  if (priceMin === null && priceMax === null && raw.price_raw) {
    const parsed = parsePrice(raw.price_raw);
    priceMin = parsed.min;
    priceMax = parsed.max;
    if (priceUnit === 'unknown') priceUnit = parsed.unit;
    if (parsed.min === null) {
      warnings.push(msg('PRICE_UNPARSED', 'price_raw', `Không đọc được giá: ${raw.price_raw}`));
    }
  }
  if (priceMin !== null && priceMax !== null && priceMax < priceMin) {
    errors.push(msg('PRICE_RANGE_INVALID', 'price_max', 'price_max phải >= price_min'));
  }
  if ((priceMin !== null && priceMin < 0) || (priceMax !== null && priceMax < 0)) {
    errors.push(msg('PRICE_INVALID', 'price_min', 'Giá không được âm'));
  }

  const audiences = collectKeys(
    raw.audiences,
    raw.audiences_raw,
    parseAudiences,
    ctx.knownAudienceKeys,
    'audiences',
    warnings,
  );
  const vibes = collectKeys(
    raw.vibes,
    raw.vibes_raw,
    parseVibes,
    ctx.knownVibeKeys,
    'vibes',
    warnings,
  );

  for (const [field, value] of Object.entries(raw)) {
    if (value && value.length > INGEST_LIMITS.maxCellChars) {
      errors.push(msg('CELL_TOO_LONG', field, `Ô ${field} vượt quá độ dài cho phép`));
    }
  }

  return {
    normalized: {
      sourceRowId,
      name,
      city,
      district: raw.district?.trim() || null,
      googleMapsUrl,
      googleMapsQuery,
      googlePlaceId,
      categoryKey,
      categoryRaw,
      priceMin,
      priceMax,
      priceUnit,
      audiences,
      vibes,
      highlight: raw.highlight?.trim() || null,
      note: raw.note?.trim() || null,
    },
    errors,
    warnings,
  };
}

function collectKeys(
  explicit: string | undefined,
  legacy: string | undefined,
  parse: (raw: string) => { keys: string[]; unknown: string[] },
  known: ReadonlySet<string> | undefined,
  field: string,
  warnings: IngestMessage[],
): string[] {
  if (!explicit && !legacy) return [];
  const parsed = explicit
    ? {
        keys: explicit
          .split(/[|,;]/)
          .map((s) => s.trim())
          .filter(Boolean),
        unknown: [] as string[],
      }
    : parse(legacy!);

  const accepted: string[] = [];
  for (const key of parsed.keys) {
    if (known && !known.has(key)) {
      warnings.push(msg(`${field.toUpperCase()}_UNKNOWN`, field, `Key không tồn tại: ${key}`));
      continue;
    }
    if (!accepted.includes(key)) accepted.push(key);
  }
  for (const token of parsed.unknown) {
    warnings.push(msg(`${field.toUpperCase()}_UNKNOWN`, field, `Chưa map được: ${token}`));
  }
  return accepted;
}
