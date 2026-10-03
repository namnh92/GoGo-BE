import { randomUUID } from 'node:crypto';

/**
 * GoGo-BE#440 — what every `POST /v1/cms/places` now needs beyond the facts:
 * an `Idempotency-Key`, and an independent source reference for each supplied
 * canonical fact. Tests that are about something else (administrative mapping,
 * duplicates, identity) use these so the body they assert on stays readable.
 */
const FACT_KEYS = [
  'description',
  'addressText',
  'areaKey',
  'city',
  'district',
  'phone',
  'website',
  'provinceCode',
  'communeCode',
] as const;

/** Fills `sourceReferences` for every supplied fact, unless the test set it. */
export function withSourceReferences(payload: Record<string, unknown>): Record<string, unknown> {
  if ('sourceReferences' in payload) return payload;
  const refs: Record<string, string> = {};
  if (payload.name !== undefined) refs.name = 'menu tại quán, ảnh chụp 2026-10-01';
  if (payload.lat !== undefined || payload.lng !== undefined) refs.geom = 'khảo sát thực địa';
  for (const key of FACT_KEYS) {
    if (payload[key] !== undefined && payload[key] !== null)
      refs[key] = `xác nhận trực tiếp: ${key}`;
  }
  if (Array.isArray(payload.taxonomyIds) && payload.taxonomyIds.length > 0) {
    refs.taxonomyIds = 'menu tại quán';
  }
  return { ...payload, sourceReferences: refs };
}

/** A fresh key per create attempt, as a console would generate. */
export function idempotencyHeader(key: string = randomUUID()): { 'idempotency-key': string } {
  return { 'idempotency-key': key };
}

/**
 * #440 F-07 — a PATCH that sets an administrative code names its evidence.
 * Fills `sourceReferences` for each explicitly supplied non-null code, unless
 * the test set it.
 */
export function withEditReferences(payload: Record<string, unknown>): Record<string, unknown> {
  if ('sourceReferences' in payload) return payload;
  const refs: Record<string, string> = {};
  for (const key of ['provinceCode', 'communeCode'] as const) {
    if (payload[key] !== undefined && payload[key] !== null)
      refs[key] = `xác nhận trực tiếp: ${key}`;
  }
  return Object.keys(refs).length > 0 ? { ...payload, sourceReferences: refs } : payload;
}
