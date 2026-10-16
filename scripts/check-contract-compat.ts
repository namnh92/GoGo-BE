/**
 * GoGo-BE#694 — the breaking-change gate has to be able to go green on a
 * breaking change the owner accepted, and on nothing else.
 *
 * What went wrong: PR #666 (BE#638, ADR-0027) restructured the SSE response of
 * `GET /rooms/{id}/events` into a `oneOf`, because the `resync` control frame
 * has no `RoomEvent` envelope. oasdiff called that breaking — correctly — so
 * `contract-compat` was red on the PR head, and the job is `pull_request`-only,
 * so the push to `develop` skipped it. The change landed without the gate ever
 * being green on any head (GoGo-BE#694).
 *
 * Recording the decision in an ADR is not enough: the gate must be able to
 * prove it. So the oasdiff step now only produces a report, and this script
 * judges it against `.github/oasdiff-exceptions.json`.
 *
 * The exception is deliberately almost useless: it matches only when the bytes
 * on both sides hash to the pair recorded with the decision, and only for the
 * recorded diagnostic. It cannot admit the same kind of change on a later
 * contract, and it cannot admit a second finding that happens to ride along.
 * Anything this script does not understand fails the build — an unreadable
 * report is a tool failure, not a pass.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface OasdiffException {
  id: string;
  issue: string;
  decidedAt: string;
  baseSha256: string;
  revisionSha256: string;
  diagnostic: string;
  reason: string;
}

export interface Finding {
  severity: 'error' | 'warning';
  /** The finding line plus its continuation lines, as oasdiff printed them. */
  text: string;
}

export interface ParsedReport {
  summary: { errors: number; warnings: number } | null;
  findings: Finding[];
}

/**
 * No breaking changes at all. oasdiff has more than one wording here — an
 * identical pair says "No breaking changes", a pair that differs without
 * breaking anything says "No breaking changes to report, but the specs are
 * different." (observed in CI run 38938515737) — so the family is matched by
 * its opening, not by an exact string. There is no summary line in this case.
 */
const NO_BREAKING = /^\s*no breaking changes\b/i;

/**
 * oasdiff's text report. The first field of a finding line is the severity, and
 * the message may continue on following lines; the tail carries a summary like
 * `1 breaking changes: 1 error, 0 warning`. We read severities and the summary,
 * never the check id — a renamed check must not silently widen an exception.
 */
export function parseReport(report: string): ParsedReport {
  const lines = report.split('\n');
  const findings: Finding[] = [];
  let summary: ParsedReport['summary'] = null;

  for (const line of lines) {
    const counts = /(\d+)\s+error[s]?,\s*(\d+)\s+warning[s]?/i.exec(line);
    if (counts) {
      summary = { errors: Number(counts[1]), warnings: Number(counts[2]) };
      continue;
    }
    const severity = /^(error|warning)\b/i.exec(line.trim());
    if (severity) {
      findings.push({
        severity: severity[1]!.toLowerCase() as Finding['severity'],
        text: line,
      });
      continue;
    }
    // A continuation line belongs to the finding above it; a line before any
    // finding (the header) belongs to nothing.
    const current = findings[findings.length - 1];
    if (current && line.trim() !== '') current.text += `\n${line}`;
  }

  return { summary, findings };
}

/**
 * oasdiff's text report wraps one message over several indented lines (CI run
 * 38940032360: `in API GET /rooms/{id}/events` then a deeper-indented `the
 * response body was restructured into a oneOf, …`), while its GitHub
 * annotation prints the same sentence joined. Matching is therefore done on
 * whitespace-collapsed text: the wording still has to be the recorded one,
 * character for character, but where oasdiff chose to break the line does not
 * decide whether a recorded decision applies.
 */
export function normaliseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

export type Verdict = { ok: true; lines: string[] } | { ok: false; code: 1 | 2; lines: string[] };

export function evaluate(input: {
  report: string;
  baseSha256: string;
  revisionSha256: string;
  exceptions: OasdiffException[];
  /** `steps.<id>.outcome` of the oasdiff step: it ran with `--fail-on ERR`. */
  oasdiffOutcome: string;
}): Verdict {
  const { report, baseSha256, revisionSha256, exceptions, oasdiffOutcome } = input;

  if (oasdiffOutcome !== 'success' && oasdiffOutcome !== 'failure') {
    return {
      ok: false,
      code: 2,
      lines: [
        `✖ the oasdiff step did not run to a verdict (outcome: ${oasdiffOutcome || '(empty)'}).`,
        '  A tool or infrastructure failure is not a passing contract gate.',
      ],
    };
  }

  const empty = report.trim() === '' || NO_BREAKING.test(report.trimStart());
  const parsed = empty
    ? { summary: { errors: 0, warnings: 0 }, findings: [] }
    : parseReport(report);

  if (parsed.summary === null) {
    return {
      ok: false,
      code: 2,
      lines: [
        '✖ could not read the oasdiff report: no `N error, M warning` summary line.',
        '  The report format changed, or the step wrote nothing. Refusing to guess.',
      ],
    };
  }

  const errors = parsed.findings.filter((f) => f.severity === 'error');
  if (errors.length !== parsed.summary.errors) {
    return {
      ok: false,
      code: 2,
      lines: [
        `✖ the oasdiff report disagrees with itself: summary says ${parsed.summary.errors} error(s),`,
        `  ${errors.length} error finding(s) parsed. Refusing to guess which is right.`,
      ],
    };
  }

  if (errors.length === 0) {
    if (oasdiffOutcome === 'failure') {
      return {
        ok: false,
        code: 2,
        lines: [
          '✖ oasdiff failed but its report carries no error finding.',
          '  Treating that as a pass would hide the reason it failed.',
        ],
      };
    }
    return { ok: true, lines: ['✔ no breaking change in /v1.'] };
  }

  const admitted: string[] = [];
  const refused: string[] = [];

  for (const finding of errors) {
    const match = exceptions.find(
      (e) =>
        e.baseSha256 === baseSha256 &&
        e.revisionSha256 === revisionSha256 &&
        normaliseSpace(finding.text).includes(normaliseSpace(e.diagnostic)),
    );
    if (match) admitted.push(`  · ${match.id} (${match.issue}, decided ${match.decidedAt})`);
    else refused.push(`  · ${normaliseSpace(finding.text)}`);
  }

  if (refused.length > 0) {
    return {
      ok: false,
      code: 1,
      lines: [
        `✖ breaking change in /v1 — ${refused.length} finding(s) with no exception for these exact contract bytes:`,
        ...refused,
        '',
        `  base sha256:     ${baseSha256}`,
        `  revision sha256: ${revisionSha256}`,
        '',
        '  A breaking change needs the policy invoked (BE-BFF-012): an ADR, a MAJOR',
        '  contract version, a consumer note in openapi/CHANGELOG.md, and the',
        '  CODEOWNER on openapi/gogo.v1.yaml. An entry in .github/oasdiff-exceptions.json',
        '  records that decision afterwards; it is not a way to skip it.',
      ],
    };
  }

  return {
    ok: true,
    lines: [
      `✔ ${admitted.length} breaking change(s), all admitted by a recorded owner decision:`,
      ...admitted,
    ],
  };
}

function main(): void {
  const [basePath, revisionPath, reportPath, outcome, exceptionsPath] = process.argv.slice(2);
  if (!basePath || !revisionPath || !reportPath || !outcome) {
    console.error(
      'usage: check-contract-compat.ts <base-spec> <revision-spec> <oasdiff-report> <oasdiff-outcome> [exceptions.json]',
    );
    process.exit(2);
  }

  const exceptionsFile = exceptionsPath ?? '.github/oasdiff-exceptions.json';
  if (!existsSync(reportPath)) {
    console.error(
      `✖ the oasdiff step wrote no report at ${reportPath} — treating that as a failure.`,
    );
    process.exit(2);
  }

  const report = readFileSync(reportPath, 'utf8');
  console.log('--- oasdiff report (unmodified) ---');
  console.log(report.trimEnd());
  console.log('--- end of report ---');

  const verdict = evaluate({
    report,
    baseSha256: sha256(readFileSync(basePath)),
    revisionSha256: sha256(readFileSync(revisionPath)),
    exceptions: JSON.parse(readFileSync(exceptionsFile, 'utf8')).exceptions as OasdiffException[],
    oasdiffOutcome: outcome,
  });

  const out = verdict.lines.join('\n');
  if (verdict.ok) {
    console.log(out);
    return;
  }
  console.error(out);
  process.exit(verdict.code);
}

if (require.main === module) main();
