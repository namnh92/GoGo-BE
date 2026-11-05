import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as {
  paths: Record<
    string,
    {
      get: {
        responses: Record<string, { content: Record<string, { schema: SchemaObject }> }>;
      };
    }
  >;
  components: { schemas: Record<string, SchemaObject> };
};

describe('GET /me/reviews contract (#752)', () => {
  it('returns MyReview rows without changing mutation Review responses', () => {
    const response = doc.paths['/me/reviews']!.get.responses['200']!;
    expect(response.content['application/json']!.schema.items?.$ref).toBe(
      '#/components/schemas/MyReview',
    );
    expect(doc.components.schemas.Review?.required).toEqual(['id', 'rating', 'status']);
  });

  it('keeps the base response requirements at the item schema path', () => {
    const myReview = doc.components.schemas.MyReview;
    expect(myReview).toBeDefined();
    if (!myReview) throw new Error('MyReview schema is missing');
    expect(myReview.type).toBe('object');
    expect(myReview.required).toEqual(['id', 'rating', 'status', 'helpfulCount']);
    expect(myReview.properties?.id).toEqual(doc.components.schemas.Review?.properties?.id);
    expect(myReview.properties?.rating).toEqual(doc.components.schemas.Review?.properties?.rating);
    expect(myReview.properties?.status).toEqual(doc.components.schemas.Review?.properties?.status);
  });

  it('declares target, moderation and helpful facts as additive fields', () => {
    const myReview = doc.components.schemas.MyReview;
    expect(myReview).toBeDefined();
    if (!myReview) throw new Error('MyReview schema is missing');
    expect(myReview.properties?.helpfulCount).toMatchObject({ type: 'integer', minimum: 0 });
    expect(myReview.properties?.placeName?.type).toBe('string');
    expect(myReview.properties?.placeAddressText?.type).toBe('string');
    expect(myReview.properties?.planTitle?.type).toBe('string');
    expect(myReview.properties?.planScheduledDate).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
    expect(myReview.properties?.rejectionReason?.type).toBe('string');
    for (const optional of [
      'placeName',
      'placeAddressText',
      'planTitle',
      'planScheduledDate',
      'rejectionReason',
    ]) {
      expect(myReview.required ?? []).not.toContain(optional);
    }
  });
});
