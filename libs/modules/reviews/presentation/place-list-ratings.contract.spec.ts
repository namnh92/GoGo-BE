import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  allOf?: SchemaObject[];
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as {
  info: { version: string };
  paths: Record<string, { get?: { operationId: string; parameters?: { name?: string }[] } }>;
  components: { schemas: Record<string, SchemaObject> };
};

describe('GoGo-BE#754 additive place-list and review contract', () => {
  it.each(['PlaceSearchResult', 'SavedItem', 'SuggestionCandidate'])(
    'adds separate optional GoGo score and sample facts to %s',
    (name) => {
      const schema = doc.components.schemas[name]!;
      expect(schema.properties?.gogoRating).toMatchObject({
        type: 'number',
        minimum: 1,
        maximum: 5,
      });
      expect(schema.properties?.gogoRatingCount).toMatchObject({
        type: 'integer',
        minimum: 0,
      });
      expect(schema.required ?? []).not.toContain('gogoRating');
      expect(schema.required ?? []).not.toContain('gogoRatingCount');
      expect(schema.properties?.rating).not.toEqual(schema.properties?.gogoRating);
    },
  );

  it('paginates the legacy review preview and returns the whole-place aggregate', () => {
    const operation = doc.paths['/places/{id}/reviews']!.get!;
    expect(operation.parameters?.map((parameter) => parameter.name).filter(Boolean)).toContain(
      'limit',
    );
    const schema = doc.components.schemas.PlaceReviewPreview!;
    expect(schema.properties?.gogoRatingCount).toMatchObject({ type: 'integer', minimum: 0 });
    expect(schema.properties?.gogoRating).toMatchObject({ minimum: 1, maximum: 5 });
    expect(schema.properties?.nextCursor?.type).toEqual(['string', 'null']);
    expect(schema.required).toEqual(['source', 'order', 'reviews']);
    expect(schema.allOf).toBeUndefined();
    expect(schema.properties?.reviews?.maxItems).toBe(3);
    expect(schema.properties?.items).toMatchObject({
      type: 'array',
      maxItems: 20,
      items: { $ref: '#/components/schemas/PublicPlaceReview' },
    });
    expect(schema.required ?? []).not.toContain('items');
  });

  it('publishes precise visit verification without review-image fields or routes', () => {
    const review = doc.components.schemas.PublicPlaceReview!;
    expect(review.properties?.verifiedVisit?.type).toBe('boolean');
    expect(review.required ?? []).not.toContain('verifiedVisit');
    expect(review.properties?.images).toBeUndefined();
    expect(doc.components.schemas.PublicReviewImage).toBeUndefined();
    expect(doc.paths['/places/{placeId}/reviews/{reviewId}/images/{imageId}']).toBeUndefined();
  });

  it('bumps the alpha contract once', () => {
    expect(doc.info.version).toBe('4.0.0-alpha.6');
  });
});
