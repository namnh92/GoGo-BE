import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

interface SchemaObject {
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as {
  components: { schemas: Record<string, SchemaObject> };
};

describe('GoGo-BE#756 travel facts contract', () => {
  it('adds optional origin legs to suggestions and next legs to plan stops', () => {
    const current = doc.components.schemas.SuggestionsCurrent!;
    const candidate = doc.components.schemas.SuggestionCandidate!;
    const stop = doc.components.schemas.PlanStop!;

    expect(current.properties?.travelEstimated?.type).toBe('boolean');
    expect(candidate.properties?.travelMinutesFromOrigin).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(candidate.properties?.travelDistanceMFromOrigin).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(stop.properties?.travelMinutesToNext?.type).toEqual(['integer', 'null']);
    expect(stop.properties?.travelDistanceMToNext?.type).toEqual(['integer', 'null']);

    expect(current.required ?? []).not.toContain('travelEstimated');
    expect(candidate.required ?? []).not.toContain('travelMinutesFromOrigin');
    expect(candidate.required ?? []).not.toContain('travelDistanceMFromOrigin');
    expect(stop.required ?? []).not.toContain('travelMinutesToNext');
    expect(stop.required ?? []).not.toContain('travelDistanceMToNext');
  });
});

describe('GoGo-BE#755 suggestion option facts contract', () => {
  it('adds optional normalized match score and liked-member count facts', () => {
    const candidate = doc.components.schemas.SuggestionCandidate!;

    expect(candidate.properties?.matchScore).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 1,
    });
    expect(candidate.properties?.likedByCount).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(candidate.required ?? []).not.toContain('matchScore');
    expect(candidate.required ?? []).not.toContain('likedByCount');
  });
});

describe('GoGo-BE#760 per-member vote status contract', () => {
  it('adds an optional member list with required identity and status facts', () => {
    const current = doc.components.schemas.SuggestionsCurrent!;
    const votes = current.properties?.votes;
    const members = votes?.properties?.members;

    expect(members?.type).toBe('array');
    expect(members?.items?.required).toEqual(['memberId', 'displayName', 'hasVoted']);
    expect(members?.items?.properties?.memberId?.type).toBe('string');
    expect(members?.items?.properties?.displayName?.type).toBe('string');
    expect(members?.items?.properties?.hasVoted?.type).toBe('boolean');
    expect(votes?.required ?? []).not.toContain('members');
  });
});
