import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
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
});
