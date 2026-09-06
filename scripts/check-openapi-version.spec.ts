import { describe, expect, it } from 'vitest';
import { checkVersionBump, declaredVersion } from './check-openapi-version';

const spec = (version: string, body = 'paths:\n  /health:\n    get: {}\n') =>
  `openapi: 3.1.0\ninfo:\n  title: GoGo\n  version: ${version}\n${body}`;

describe('openapi version gate', () => {
  it('reads the document version, not a version nested in a schema', () => {
    const withNestedVersion = spec(
      '1.0.0-alpha.1',
      'components:\n  schemas:\n    Plan:\n      properties:\n        version: { type: integer }\n',
    );
    expect(declaredVersion(withNestedVersion)).toBe('1.0.0-alpha.1');
  });

  it('passes when the spec did not change', () => {
    const same = spec('1.0.0-alpha.1');
    expect(checkVersionBump(same, same)).toEqual({
      ok: true,
      reason: 'unchanged',
      version: '1.0.0-alpha.1',
    });
  });

  it('passes when a changed spec carries a new version', () => {
    const base = spec('1.0.0-alpha.1');
    const head = spec(
      '1.0.0-alpha.2',
      'paths:\n  /health:\n    get: {}\n  /share-links:\n    post: {}\n',
    );
    expect(checkVersionBump(base, head)).toEqual({
      ok: true,
      reason: 'bumped',
      version: '1.0.0-alpha.2',
    });
  });

  it('fails when paths are added under the same version — the case that shipped', () => {
    const base = spec('1.0.0-alpha.1');
    const head = spec(
      '1.0.0-alpha.1',
      'paths:\n  /health:\n    get: {}\n  /share-links:\n    post: {}\n',
    );
    expect(checkVersionBump(base, head)).toEqual({ ok: false, version: '1.0.0-alpha.1' });
  });

  it('does not demand a bump for trailing-whitespace-only churn', () => {
    const base = spec('1.0.0-alpha.1');
    expect(checkVersionBump(base, `${base}\n\n`).ok).toBe(true);
  });

  it('fails loudly when the spec has no info.version at all', () => {
    const head = 'openapi: 3.1.0\npaths: {}\n';
    expect(checkVersionBump(spec('1.0.0-alpha.1'), head)).toEqual({ ok: false, version: '(none)' });
  });
});
