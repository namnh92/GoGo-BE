import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_SEMANTIC_DIAGNOSTIC,
  evaluate,
  notificationPreferenceBreak,
  parseExceptions,
  sha256,
} from './check-contract-compat';

const base = 'openapi: 3.1.0\ninfo: { version: 7.7.0-alpha.1 }\n';
const revision = (version: string) =>
  `openapi: 3.1.0\ninfo: { version: ${version} }\nx-gogo-notification-preference-semantics: master-and-five-categories-v1\n`;
function judge(version: string, exceptions = false, changedHash = false) {
  const head = revision(version);
  return evaluate({
    report: 'No breaking changes to report, but the specs are different.',
    oasdiffOutcome: 'success',
    baseSha256: sha256(base),
    revisionSha256: sha256(head + (changedHash ? '\n' : '')),
    semanticBreak: notificationPreferenceBreak(base, head),
    exceptions: exceptions
      ? [
          {
            id: 'BE-811',
            issue: '#811',
            decidedAt: '2026-11-08',
            diagnostic: CATEGORY_SEMANTIC_DIAGNOSTIC,
            baseSha256: sha256(base),
            revisionSha256: sha256(head),
            reason: 'Owner semantic MAJOR decision; CODEOWNER review separate',
          },
        ]
      : [],
  });
}
describe('ADR-0050 semantic contract MAJOR gate', () => {
  it('refuses MINOR even if structural oasdiff is clean and an exception exists', () => {
    expect(judge('7.8.0-alpha.1', true)).toMatchObject({
      ok: false,
      lines: [expect.stringContaining('MAJOR')],
    });
  });
  it('requires exact diagnostic and contract hashes for the MAJOR', () => {
    expect(judge('8.0.0-alpha.1')).toMatchObject({ ok: false });
    expect(judge('8.0.0-alpha.1', true, true)).toMatchObject({ ok: false });
    expect(judge('8.0.0-alpha.1', true)).toMatchObject({ ok: true });
  });
  it('does not waive an unrelated structural error', () => {
    const head = revision('8.0.0-alpha.1');
    expect(
      evaluate({
        report: '1 changes: 1 error, 0 warning, 0 info\nERR removed unrelated operation\n',
        baseSha256: sha256(base),
        revisionSha256: sha256(head),
        oasdiffOutcome: 'success',
        semanticBreak: notificationPreferenceBreak(base, head),
        exceptions: [],
      }),
    ).toMatchObject({ ok: false });
  });
  it('records the real semantic diagnostic without claiming CODEOWNER sign-off', () => {
    const entries = parseExceptions(readFileSync('.github/oasdiff-exceptions.json', 'utf8'));
    expect(entries.find((e) => e.id === 'BE-811-category-effective-permission')?.diagnostic).toBe(
      CATEGORY_SEMANTIC_DIAGNOSTIC,
    );
  });
});
