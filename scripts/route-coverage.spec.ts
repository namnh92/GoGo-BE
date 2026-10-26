import { describe, expect, it } from 'vitest';
import { compareRoutes, plannedOperations, specOperations } from './route-coverage';

const doc = (paths: string) =>
  `openapi: 3.1.0\ninfo:\n  version: 1.0.0\npaths:\n${paths}components: {}\n`;

const SPEC = doc(
  [
    '  /rooms/{id}:',
    '    get:',
    '      operationId: getRoom',
    '  /assistant/status:',
    '    get:',
    '      operationId: getAssistantStatus',
    '      x-gogo-planned: GoGo-BE#713',
    '',
  ].join('\n'),
);

describe('route coverage (BE-BFF-012, GoGo-BE#713 planned operations)', () => {
  it('reads the planned marker per operation, with the issue it names', () => {
    const { planned, malformed } = plannedOperations(SPEC);
    expect([...planned.entries()]).toEqual([['GET /assistant/status', 'GoGo-BE#713']]);
    expect(malformed).toEqual([]);
  });

  it('lets a planned operation be documented but not served', () => {
    const coverage = compareRoutes(
      specOperations(SPEC),
      new Set(['GET /rooms/{id}']),
      plannedOperations(SPEC),
    );
    expect(coverage).toMatchObject({
      ok: true,
      specOnly: [],
      plannedPending: ['GET /assistant/status'],
    });
  });

  it('still fails an unmarked operation that is not served', () => {
    const unmarked = SPEC.replace('      x-gogo-planned: GoGo-BE#713\n', '');
    const coverage = compareRoutes(
      specOperations(unmarked),
      new Set(['GET /rooms/{id}']),
      plannedOperations(unmarked),
    );
    expect(coverage.ok).toBe(false);
    expect(coverage.specOnly).toEqual(['GET /assistant/status']);
  });

  it('fails once a planned operation is served and the marker was left behind', () => {
    const coverage = compareRoutes(
      specOperations(SPEC),
      new Set(['GET /rooms/{id}', 'GET /assistant/status']),
      plannedOperations(SPEC),
    );
    expect(coverage.ok).toBe(false);
    expect(coverage.plannedServed).toEqual(['GET /assistant/status']);
  });

  it('refuses a marker that names no issue', () => {
    const vague = SPEC.replace('GoGo-BE#713', 'later');
    const coverage = compareRoutes(
      specOperations(vague),
      new Set(['GET /rooms/{id}']),
      plannedOperations(vague),
    );
    expect(coverage.ok).toBe(false);
    expect(coverage.plannedMalformed).toEqual(['GET /assistant/status']);
  });

  it('still reports a served route missing from the spec', () => {
    const coverage = compareRoutes(
      specOperations(SPEC),
      new Set(['GET /rooms/{id}', 'POST /rooms']),
      plannedOperations(SPEC),
    );
    expect(coverage.missing).toEqual(['POST /rooms']);
    expect(coverage.ok).toBe(false);
  });
});
