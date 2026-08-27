import { normalizeVietnamese } from '../../search/domain/normalize';

/**
 * PI-BE-014 / spec §4.4 — parse the Vietnamese free-text columns of the
 * legacy GOGO sheet into structured facts. Unknown taxonomy keys never create
 * taxonomy; they surface as warnings for an editor to resolve.
 */

export type PriceUnit = 'per_person' | 'per_group' | 'per_item' | 'free' | 'unknown';

export type ParsedPrice = {
  min: number | null;
  max: number | null;
  unit: PriceUnit;
  raw: string;
};

const K = 1_000;
const M = 1_000_000;

function toVnd(numText: string, suffix: string | undefined): number {
  const n = Number(numText.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  if (Number.isNaN(n)) return NaN;
  const s = (suffix ?? '').toLowerCase();
  if (s.startsWith('tr') || s === 'm') return Math.round(n * M);
  if (s === 'k' || s.startsWith('ng')) return Math.round(n * K);
  // Bare numbers under 1000 in a price column mean thousands ("45 - 75").
  return n < 1000 ? Math.round(n * K) : Math.round(n);
}

/**
 * Handles: "45 - 75k", "250k - 800k/món", "~100k", "Miễn phí", "200.000",
 * "1tr2" style inputs. Unit hints come from the same string.
 */
export function parsePrice(raw: string): ParsedPrice {
  const text = (raw ?? '').trim();
  const out: ParsedPrice = { min: null, max: null, unit: 'unknown', raw: text };
  if (!text) return out;

  const norm = normalizeVietnamese(text);
  if (/(mien phi|free|0d|0 dong)/.test(norm)) {
    return { min: 0, max: 0, unit: 'free', raw: text };
  }

  if (/(\/|per\s*)(mon|item|dish)/.test(norm)) out.unit = 'per_item';
  else if (/(nhom|group|ban|table)/.test(norm)) out.unit = 'per_group';
  else out.unit = 'per_person';

  const num = String.raw`(\d+(?:[.,]\d+)?)\s*(tr|trieu|k|ngan|nghin|m)?`;
  const range = new RegExp(`${num}\\s*(?:-|–|—|đến|den|tới|toi)\\s*${num}`, 'i');
  const r = range.exec(norm);
  if (r) {
    // "45 - 75k": a bare first number inherits the second number's suffix.
    const suffixA = r[2] || r[4];
    const a = toVnd(r[1]!, suffixA);
    const b = toVnd(r[3]!, r[4]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      out.min = Math.min(a, b);
      out.max = Math.max(a, b);
      return out;
    }
  }

  const single = new RegExp(num, 'i').exec(norm);
  if (single) {
    const v = toVnd(single[1]!, single[2]);
    if (!Number.isNaN(v)) {
      out.min = v;
      out.max = v;
    }
  }
  return out;
}

const AUDIENCE_MAP: Record<string, string> = {
  'cap doi': 'couple',
  couple: 'couple',
  'nguoi yeu': 'couple',
  'ban be': 'group',
  nhom: 'group',
  group: 'group',
  'gia dinh': 'family',
  family: 'family',
  'mot minh': 'solo',
  solo: 'solo',
  'dong nghiep': 'group',
};

const VIBE_MAP: Record<string, string> = {
  'yen tinh': 'quiet',
  quiet: 'quiet',
  chill: 'chill',
  'thu gian': 'chill',
  'soi dong': 'energetic',
  energetic: 'energetic',
  'nang dong': 'energetic',
  'lang man': 'romantic',
  romantic: 'romantic',
  'am cung': 'cozy',
  cozy: 'cozy',
  'rieng tu': 'private',
  private: 'private',
  playful: 'playful',
  'vui nhon': 'playful',
  'sang trong': 'upscale',
};

export type MappedKeys = { keys: string[]; unknown: string[] };

function mapTokens(raw: string, dict: Record<string, string>): MappedKeys {
  const keys: string[] = [];
  const unknown: string[] = [];
  for (const part of (raw ?? '').split(/[|,;/]+/)) {
    const token = normalizeVietnamese(part);
    if (!token) continue;
    const hit = dict[token] ?? Object.entries(dict).find(([k]) => token.includes(k))?.[1];
    if (hit) {
      if (!keys.includes(hit)) keys.push(hit);
    } else {
      unknown.push(part.trim());
    }
  }
  return { keys, unknown };
}

export function parseAudiences(raw: string): MappedKeys {
  return mapTokens(raw, AUDIENCE_MAP);
}

export function parseVibes(raw: string): MappedKeys {
  return mapTokens(raw, VIBE_MAP);
}

/** Legacy GOGO sheet headers → canonical import fields (spec §4.4). */
export const LEGACY_COLUMN_MAPPING: Record<string, string> = {
  'ten dia diem': 'name',
  'loai hinh': 'category_raw',
  'khu vuc (quan/huyen)': 'district',
  'khu vuc': 'district',
  'khoang gia/nguoi': 'price_raw',
  'khoang gia': 'price_raw',
  'di cung ai?': 'audiences_raw',
  'di cung ai': 'audiences_raw',
  'vibe/bau khong khi': 'vibes_raw',
  vibe: 'vibes_raw',
  'mon highlight/hoat dong chinh': 'highlight',
  'mon highlight': 'highlight',
  'link google maps': 'google_maps_url',
  'ghi chu': 'note',
};

export function mapLegacyHeader(header: string): string | undefined {
  return LEGACY_COLUMN_MAPPING[normalizeVietnamese(header)];
}
