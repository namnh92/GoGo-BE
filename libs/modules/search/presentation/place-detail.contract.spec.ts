import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * GoGo-BE#217 (ADR-0028) — the GoGo community rating as the published contract
 * states it. Consumers vendor `openapi/gogo.v1.yaml` and generate their types
 * from it, so a field the API sends but this document does not declare is a
 * field no client can read. The runtime half is
 * `apps/api/test/place-gogo-rating.int.spec.ts`.
 *
 * Deliberately imports nothing from the implementation at module level: run
 * against the contract from before #217, every case here fails on the missing
 * declaration itself.
 */
const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

interface SchemaObject {
  type?: string;
  required?: string[];
  minimum?: number;
  maximum?: number;
  description?: string;
  properties?: Record<string, SchemaObject>;
}
interface Example {
  value: Record<string, unknown>;
}
interface Response200 {
  headers?: Record<string, { description?: string; schema?: SchemaObject }>;
  content: { 'application/json': { examples?: Record<string, Example> } };
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as {
  paths: Record<string, { get: { description?: string; responses: Record<string, Response200> } }>;
  components: { schemas: Record<string, SchemaObject> };
};

const placeDetail = doc.components.schemas['PlaceDetail']!;
const getPlaceDetail = doc.paths['/places/{id}']!.get;
const ok = getPlaceDetail.responses['200']!;

describe('PlaceDetail GoGo rating contract (#217)', () => {
  it('declares gogoRatingCount as a required non-negative integer', () => {
    expect(placeDetail.properties?.['gogoRatingCount']).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(placeDetail.required ?? []).toContain('gogoRatingCount');
  });

  it('declares gogoRating as an optional number on the fixed 1–5 scale', () => {
    expect(placeDetail.properties?.['gogoRating']).toMatchObject({
      type: 'number',
      minimum: 1,
      maximum: 5,
    });
    // Omitted below the threshold — so never required, and never nullable.
    expect(placeDetail.required ?? []).not.toContain('gogoRating');
    expect(placeDetail.properties?.['gogoRating']?.type).not.toContain('null');
  });

  it('keeps the provider rating as its own, unchanged fields', () => {
    expect(placeDetail.properties?.['rating']?.type).toBe('number');
    expect(placeDetail.properties?.['ratingCount']?.type).toBe('integer');
    expect(placeDetail.properties?.['sources']).toBeDefined();
  });

  it('states the threshold the implementation applies', async () => {
    const { GOGO_RATING_MIN_SAMPLE } = await import('../../reviews/domain/gogo-rating.js');
    const text = placeDetail.properties?.['gogoRating']?.description ?? '';
    expect(text).toContain(`below ${GOGO_RATING_MIN_SAMPLE}`);
    expect(text).toContain(`${GOGO_RATING_MIN_SAMPLE} or more`);
  });

  it('declares the no-store header on the 200', () => {
    expect(ok.headers?.['Cache-Control']?.description).toContain('no-store');
  });

  it('publishes consumer examples for counts 0, 4 and 5 that follow the omission rule', () => {
    const examples = Object.values(ok.content['application/json'].examples ?? {}).map(
      (e) => e.value,
    );
    const byCount = new Map(examples.map((v) => [v['gogoRatingCount'], v]));
    expect([...byCount.keys()].sort()).toEqual([0, 4, 5]);
    expect(byCount.get(0)).not.toHaveProperty('gogoRating');
    expect(byCount.get(4)).not.toHaveProperty('gogoRating');
    expect(typeof byCount.get(5)?.['gogoRating']).toBe('number');
    // The provider fact rides alongside, separately, in every example.
    for (const v of examples) expect(v).toHaveProperty('ratingCount');
  });
});
