import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { components } from '../../../../openapi/gogo.v1';
import { evaluate, parseExceptions } from '../../../../scripts/check-contract-compat';

const root = path.resolve(__dirname, '../../../..');
const bytes = readFileSync(path.join(root, 'openapi/gogo.v1.yaml'));
const doc = parse(bytes.toString());
const entry = parseExceptions(
  readFileSync(path.join(root, '.github/oasdiff-exceptions.json'), 'utf8'),
).find((e) => e.id === 'BE-822-provider-photos-path-removed')!;

describe('ADR-0052 contract and exception guard (synthetic matcher fixture, not fresh oasdiff)', () => {
  it('declares the additive MINOR, retains the gallery removal and preview schemas', () => {
    expect(doc.info.version).toBe('10.2.0-alpha.1');
    expect(doc.paths['/places/{id}/provider-photos']).toBeUndefined();
    expect(doc.paths['/places/google-provider-photo/{googlePlaceId}']).toBeDefined();
    expect(doc.components.schemas.PlaceProviderPhotos).toBeDefined();
    expect(doc.components.schemas.PlaceProviderPhoto).toBeDefined();
    expect(doc.paths['/cms/places'].post.description).toContain('acquires one');
    expect(doc.paths['/cms/places'].post.description).not.toContain('calls no Google provider');
  });
  it('explicitly permits photo on strict detail and keeps the deprecated nested photo optional', () => {
    const value: components['schemas']['MyPlaceSubmissionDetail'] = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'rejected',
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-09T00:00:00Z',
      updateDeadline: '2026-11-16T00:00:00Z',
      photo: {
        id: '22222222-2222-4222-8222-222222222222',
        url: 'https://assets.test/places/provider/cover.jpg',
        source: 'google',
        attribution: 'Google Maps',
        authorAttributions: [{ displayName: 'Lan', uri: null, photoUri: null }],
      },
    };
    const s = doc.components.schemas;
    expect(s.MyPlaceSubmissionDetail.additionalProperties).toBe(false);
    expect(Object.keys(value).every((key) => key in s.MyPlaceSubmissionDetail.properties)).toBe(
      true,
    );
    for (const schema of ['SubmissionResult', 'MyPlaceSubmission', 'MyPlaceSubmissionDetail'])
      expect(s[schema].properties.photo.$ref).toBe('#/components/schemas/PlacePhoto');
    for (const schema of ['PlaceSubmissionSummary', 'PlaceSubmissionDetail'])
      expect(s[schema].properties.providerPhoto.$ref).toBe('#/components/schemas/PlacePhoto');
    expect(s.SubmissionProviderDisplay.required).not.toContain('photo');
    expect(s.SubmissionProviderDisplay.properties.photo.deprecated).toBe(true);
    expect(s.MyPlaceSubmissionDetail.properties.informationRemoved).toBeUndefined();
  });
  it('scopes the historical removal waiver to its recorded pair and rejects current revision drift', () => {
    const currentRevisionSha256 = createHash('sha256').update(bytes).digest('hex');
    const input = {
      report: `1 changes: 1 error, 0 warning, 0 info\n${entry.diagnostic}\n`,
      baseSha256: entry.baseSha256,
      revisionSha256: entry.revisionSha256,
      exceptions: [entry],
      oasdiffOutcome: 'success',
      expect: entry.id,
    };
    expect(evaluate(input).ok).toBe(true);
    // PR4 builds on the removal already shipped in 9.0.0. Keep its historical
    // waiver unchanged; it must not authorize a removal against the 9.1.0 bytes.
    expect(evaluate({ ...input, revisionSha256: currentRevisionSha256 }).ok).toBe(false);
    expect(evaluate({ ...input, revisionSha256: 'different' }).ok).toBe(false);
    expect(
      evaluate({
        ...input,
        report: `2 changes: 2 error, 0 warning, 0 info\n${entry.diagnostic}\nerror [unapproved] in API GET /other\n`,
      }).ok,
    ).toBe(false);
    expect(
      evaluate({
        ...input,
        report: `2 changes: 2 error, 0 warning, 0 info\n${entry.diagnostic}\n${entry.diagnostic}\n`,
      }).ok,
    ).toBe(false);
  });
});
