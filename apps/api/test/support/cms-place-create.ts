import { randomUUID } from 'node:crypto';

/**
 * GoGo-BE#440 — what every `POST /v1/cms/places` now needs beyond the facts:
 * an `Idempotency-Key`, and an independent source reference for each supplied
 * canonical fact. Tests that are about something else (administrative mapping,
 * duplicates, identity) use these so the body they assert on stays readable.
 */
const FACT_KEYS = [
  'description',
  'areaKey',
  'city',
  'district',
  'provinceCode',
  'communeCode',
] as const;

/**
 * GoGo-BE#280 — the three contact fields take structured evidence under
 * `provenance`, never a `sourceReferences` key.
 */
const CONTACT_KEYS = ['addressText', 'phone', 'website'] as const;
export const CONTACT_EVIDENCE = {
  sourceType: 'editorial',
  sourceReference: 'Gọi điện chủ quán 2026-09-30',
  collectedAt: '2026-09-30T02:00:00Z',
} as const;

/**
 * Fills `sourceReferences` for every supplied fact, and `provenance` for every
 * supplied contact value, unless the test set the object itself.
 */
export function withSourceReferences(payload: Record<string, unknown>): Record<string, unknown> {
  const out = withContactProvenance(payload);
  if ('sourceReferences' in out) return out;
  payload = out;
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

function withContactProvenance(payload: Record<string, unknown>): Record<string, unknown> {
  if ('provenance' in payload) return payload;
  const provenance: Record<string, unknown> = {};
  for (const key of CONTACT_KEYS) {
    if (payload[key] !== undefined && payload[key] !== null) provenance[key] = CONTACT_EVIDENCE;
  }
  return Object.keys(provenance).length > 0 ? { ...payload, provenance } : payload;
}
