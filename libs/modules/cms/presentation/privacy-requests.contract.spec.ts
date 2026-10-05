import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * PR #677 S-F-15 — a refusal the API performs but the contract does not declare
 * is a refusal no generated client has a branch for. Executing an export
 * request answers `503 EXPORT_UNAVAILABLE` when secure export is not
 * configured; alpha.67 declared it on the direct user export and on the
 * self-service routes but not on `execute`. Read from the published document,
 * as the generated client is.
 */
const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

type Responses = Record<string, { description?: string } | undefined>;
type Doc = { paths: Record<string, { post?: { responses?: Responses } }> };

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as Doc;

describe('secure export contract: 503 EXPORT_UNAVAILABLE', () => {
  it.each([
    '/cms/privacy-requests/{id}/execute',
    '/cms/users/{id}/export',
    '/me/exports',
    '/me/exports/{id}/download',
  ])('%s declares the 503 error envelope', (route) => {
    const responses = doc.paths[route]?.post?.responses;
    expect(responses, route).toBeDefined();
    const unavailable = responses!['503'];
    expect(unavailable, `${route} 503`).toBeDefined();
    expect(unavailable!.description).toContain('EXPORT_UNAVAILABLE');
  });
});
