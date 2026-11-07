import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components } from '../../../../openapi/gogo.v1';
const doc = parse(
  readFileSync(path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'),
);
describe('contribution wizard additive contract (#796)', () => {
  it('keeps legacy submission valid and pins additive version', () => {
    expect(doc.info.version).toBe('7.5.0-alpha.1');
    const submit =
      doc.paths['/place-submissions'].post.requestBody.content['application/json'].schema;
    expect(submit.required).toEqual(['googlePlaceId']);
    expect(submit.properties.enrichment.$ref).toContain('ContributionEnrichment');
  });
  it('exposes owner drafts, strict photo references and fact-only proposal', () => {
    expect(Object.keys(doc.paths['/place-contribution-drafts/{id}'])).toEqual(
      expect.arrayContaining(['get', 'put', 'delete']),
    );
    const s = doc.components.schemas;
    expect(s.ContributionEnrichmentDraft.properties.photos.maxItems).toBe(5);
    expect(s.ContributionEnrichmentDraft.properties.photos.items.additionalProperties).toBe(false);
    expect(s.ContributionRating.properties.rating).toMatchObject({ minimum: 1, maximum: 5 });
    expect(s.ContributionEnrichmentDraft.description.toLowerCase()).toContain('unverified');
    expect(s.ContributionDraft.properties.verificationStatus.enum).toEqual(['unverified']);
  });
  it('keeps CMS taxonomy keys open for every wizard kind', () => {
    const enrichment = doc.components.schemas.ContributionEnrichmentDraft.properties;
    for (const field of ['purposeKeys', 'vibeKeys']) {
      expect(enrichment[field].items.type).toBe('string');
      expect(enrichment[field].items).not.toHaveProperty('enum');
      expect(enrichment[field].items['x-extensible']).toBe(true);
    }
    expect(enrichment.amenities.additionalProperties).toEqual({ type: 'boolean' });
    expect(enrichment.amenities).not.toHaveProperty('properties');
    expect(doc.components.schemas.ContributionRating.properties.chipKeys.items).not.toHaveProperty(
      'enum',
    );
  });
  it('allows bonus approval credits and keeps CMS ledger deltas extensible', () => {
    const delta = doc.components.schemas.CmsAssistantCreditEntry.properties.delta;
    expect(delta.type).toBe('integer');
    expect(delta['x-extensible-enum']).toEqual([50, 70, -1]);
    expect(delta).not.toHaveProperty('enum');
    expectTypeOf<
      components['schemas']['CmsAssistantCreditEntry']['delta']
    >().toEqualTypeOf<number>();
  });
});
