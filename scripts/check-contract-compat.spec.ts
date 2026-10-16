import { describe, expect, it } from 'vitest';
import { evaluate, parseReport, type OasdiffException } from './check-contract-compat';

const BASE = '2cac78cc74ffb26e183a4ca3ce84143c83fbf9e411e7ca69ff084d32de403359';
const REVISION = 'a807224b19b05452bf4c1f2a8f6df12365dcdf6be38c7c30da25d747717016c5';
const DIAGNOSTIC =
  'in API GET /rooms/{id}/events the response body was restructured into a oneOf, so a field that was previously guaranteed may no longer be present';

const exception: OasdiffException = {
  id: 'BE-694-room-events-resync-oneof',
  issue: 'https://github.com/namnh92/GoGo-BE/issues/694',
  decidedAt: '2026-10-16',
  baseSha256: BASE,
  revisionSha256: REVISION,
  diagnostic: DIAGNOSTIC,
  reason: 'ADR-0027 resync frame',
};

/** The shape oasdiff prints: severity first, message indented under it. */
const historicalReport = [
  `error\t[response-body-became-oneof] at openapi/gogo.v1.yaml`,
  `\t${DIAGNOSTIC}`,
  '',
  '1 breaking changes: 1 error, 0 warning',
].join('\n');

/**
 * The real report, byte for byte, from CI run 38940032360 replaying the
 * recorded transition: the summary carries an `info` count, the check id is
 * `response-body-wrapped-in-one-of`, and the message is wrapped over two
 * indented lines.
 */
const historicalReportAsOasdiffPrintsIt = [
  '1 changes: 1 error, 0 warning, 0 info',
  'error\t[response-body-wrapped-in-one-of] at .oasdiff-hist-head.yaml',
  '\tin API GET /rooms/{id}/events',
  '\t\tthe response body was restructured into a oneOf, so a field that was previously guaranteed may no longer be present',
].join('\n');

const other = (text: string) =>
  [
    `error\t[request-parameter-removed] at openapi/gogo.v1.yaml`,
    `\t${text}`,
    '',
    '1 breaking changes: 1 error, 0 warning',
  ].join('\n');

const run = (over: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({
    report: historicalReport,
    baseSha256: BASE,
    revisionSha256: REVISION,
    exceptions: [exception],
    oasdiffOutcome: 'failure',
    ...over,
  });

describe('parseReport', () => {
  it('reads the severity and keeps the message with its finding', () => {
    const parsed = parseReport(historicalReport);
    expect(parsed.summary).toEqual({ error: 1, warning: 0, info: 0 });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.severity).toBe('error');
    expect(parsed.findings[0]!.text).toContain(DIAGNOSTIC);
  });

  it('does not count a warning as an error', () => {
    const parsed = parseReport(
      [
        'warning\t[optional-response-header-removed] at openapi/gogo.v1.yaml',
        '\tsomething softer',
        '',
        '1 breaking changes: 0 error, 1 warning',
      ].join('\n'),
    );
    expect(parsed.summary).toEqual({ error: 0, warning: 1, info: 0 });
    expect(parsed.findings.map((f) => f.severity)).toEqual(['warning']);
  });
});

describe('evaluate', () => {
  it('admits it in the wrapped text oasdiff actually prints', () => {
    const verdict = run({ report: historicalReportAsOasdiffPrintsIt });
    expect(verdict.ok).toBe(true);
    expect(verdict.lines.join('\n')).toContain('BE-694-room-events-resync-oneof');
  });

  it('still refuses that wrapped finding on other bytes', () => {
    expect(
      run({ report: historicalReportAsOasdiffPrintsIt, revisionSha256: '0'.repeat(64) }),
    ).toMatchObject({ ok: false, code: 1 });
  });

  it('admits the recorded change on the exact contract bytes it was decided for', () => {
    const verdict = run();
    expect(verdict.ok).toBe(true);
    expect(verdict.lines.join('\n')).toContain('BE-694-room-events-resync-oneof');
  });

  it('refuses the same diagnostic on any other base', () => {
    const verdict = run({ baseSha256: 'f'.repeat(64) });
    expect(verdict).toMatchObject({ ok: false, code: 1 });
  });

  it('refuses the same diagnostic on any other revision — a later contract is not covered', () => {
    const verdict = run({ revisionSha256: '0'.repeat(64) });
    expect(verdict).toMatchObject({ ok: false, code: 1 });
  });

  it('refuses a different breaking change on the admitted bytes', () => {
    const verdict = run({
      report: other('in API GET /rooms/{id} a required request parameter was removed'),
    });
    expect(verdict).toMatchObject({ ok: false, code: 1 });
  });

  it('refuses when a second finding rides along with the admitted one', () => {
    const report = [
      `error\t[response-body-became-oneof] at openapi/gogo.v1.yaml`,
      `\t${DIAGNOSTIC}`,
      `error\t[api-removed-without-deprecation] at openapi/gogo.v1.yaml`,
      `\tin API GET /rooms/{id}/plan the endpoint was removed without deprecation`,
      '',
      '2 breaking changes: 2 error, 0 warning',
    ].join('\n');
    const verdict = run({ report });
    expect(verdict).toMatchObject({ ok: false, code: 1 });
    expect(verdict.ok === false && verdict.lines.join('\n')).toContain(
      'api-removed-without-deprecation',
    );
  });

  it('passes a clean diff, in either wording oasdiff uses', () => {
    expect(run({ report: 'No breaking changes', oasdiffOutcome: 'success' })).toMatchObject({
      ok: true,
    });
    // Observed in CI run 38938515737 on a version-only change: oasdiff says
    // more than "No breaking changes", and prints no summary line.
    expect(
      run({
        report: 'No breaking changes to report, but the specs are different.\n',
        oasdiffOutcome: 'success',
      }),
    ).toMatchObject({ ok: true });
    expect(run({ report: '', oasdiffOutcome: 'success' })).toMatchObject({ ok: true });
  });

  it('fails closed on a report it cannot read — no summary line', () => {
    const verdict = run({ report: 'error\t[something] at openapi/gogo.v1.yaml\n\tsome text' });
    expect(verdict).toMatchObject({ ok: false, code: 2 });
  });

  it('fails closed when the summary and the findings disagree', () => {
    const verdict = run({
      report: [
        `error\t[x] at openapi/gogo.v1.yaml`,
        `\t${DIAGNOSTIC}`,
        '',
        '2 breaking changes: 2 error, 0 warning',
      ].join('\n'),
    });
    expect(verdict).toMatchObject({ ok: false, code: 2 });
  });

  it('fails closed when oasdiff failed but reported no error', () => {
    const verdict = run({ report: 'No breaking changes', oasdiffOutcome: 'failure' });
    expect(verdict).toMatchObject({ ok: false, code: 2 });
  });

  it('fails closed when the oasdiff step did not reach a verdict', () => {
    expect(run({ oasdiffOutcome: '' })).toMatchObject({ ok: false, code: 2 });
    expect(run({ oasdiffOutcome: 'cancelled' })).toMatchObject({ ok: false, code: 2 });
  });

  it('does not let an info finding lend its diagnostic to an unrelated error (#703 F-01)', () => {
    const report = [
      '2 changes: 1 error, 0 warning, 1 info',
      'error\t[api-removed-without-deprecation] at openapi/gogo.v1.yaml',
      '\tin API GET /rooms/{id}/plan the endpoint was removed without deprecation',
      'info\t[response-body-wrapped-in-one-of] at openapi/gogo.v1.yaml',
      `\t${DIAGNOSTIC}`,
    ].join('\n');
    const verdict = run({ report });
    expect(verdict).toMatchObject({ ok: false, code: 1 });
    expect(verdict.ok === false && verdict.lines.join('\n')).toContain(
      'api-removed-without-deprecation',
    );
  });

  it('counts an info finding against the summary', () => {
    const parsed = parseReport(
      [
        '1 changes: 0 error, 0 warning, 1 info',
        'info\t[x] at openapi/gogo.v1.yaml',
        '\tjust saying',
      ].join('\n'),
    );
    expect(parsed.summary).toEqual({ error: 0, warning: 0, info: 1 });
    expect(parsed.findings.map((f) => f.severity)).toEqual(['info']);
  });

  it('spends an exception once — a second identical error is refused (#703 F-02)', () => {
    const report = [
      '2 changes: 2 error, 0 warning, 0 info',
      'error\t[response-body-wrapped-in-one-of] at openapi/gogo.v1.yaml',
      `\t${DIAGNOSTIC}`,
      'error\t[response-body-wrapped-in-one-of] at openapi/gogo.v1.yaml',
      `\t${DIAGNOSTIC}`,
    ].join('\n');
    expect(run({ report })).toMatchObject({ ok: false, code: 1 });
  });

  it('replay: refuses a clean report when an id was expected (#703 F-02)', () => {
    const verdict = run({
      report: 'No breaking changes to report, but the specs are different.',
      oasdiffOutcome: 'success',
      expect: 'BE-694-room-events-resync-oneof',
    });
    expect(verdict).toMatchObject({ ok: false, code: 1 });
    expect(verdict.ok === false && verdict.lines.join('\n')).toContain(
      'no longer describes anything',
    );
  });

  it('replay: passes when the expected id is admitted exactly once', () => {
    expect(
      run({
        report: historicalReportAsOasdiffPrintsIt,
        expect: 'BE-694-room-events-resync-oneof',
      }),
    ).toMatchObject({ ok: true });
  });

  it('replay: refuses when a different exception admitted the finding', () => {
    expect(
      run({ report: historicalReportAsOasdiffPrintsIt, expect: 'BE-999-some-other-decision' }),
    ).toMatchObject({ ok: false, code: 1 });
  });

  it('refuses a warning-only report with no exception — nothing to admit, nothing to fail', () => {
    const verdict = run({
      report: [
        'warning\t[x] at openapi/gogo.v1.yaml',
        '\tsofter',
        '',
        '1 breaking changes: 0 error, 1 warning',
      ].join('\n'),
      oasdiffOutcome: 'success',
    });
    expect(verdict).toMatchObject({ ok: true });
  });
});
