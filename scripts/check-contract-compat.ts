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
 * on both sides hash to the pair recorded with the decision, only for the
 * recorded diagnostic, and only once per entry. It cannot admit the same kind
 * of change on a later contract, and it cannot admit a second finding that
 * happens to ride along. Anything this script does not understand fails the
 * build — an unreadable report is a tool failure, not a pass.
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

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** This finding's own lines, as oasdiff printed them — never the next one's. */
  text: string;
}

export interface ParsedReport {
  summary: Record<Severity, number> | null;
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

/** `1 changes: 1 error, 0 warning, 0 info` (CI run 38940032360). */
const SUMMARY = /(\d+)\s+errors?,\s*(\d+)\s+warnings?(?:,\s*(\d+)\s+infos?)?/i;

/** A finding opens with its severity as the first word of the line. */
const FINDING = /^(error|warning|info)\b/i;

/**
 * oasdiff's text report. Every severity opens a finding, so a lower-severity
 * line can never be read as the continuation of the finding above it — an
 * `info` carrying an admitted diagnostic must not lend it to an unrelated
 * `error` (GoGo-BE#703 F-01). The check id is deliberately not parsed: a
 * renamed check must not silently widen an exception.
 */
export function parseReport(report: string): ParsedReport {
  const findings: Finding[] = [];
  let summary: ParsedReport['summary'] = null;

  for (const line of report.split('\n')) {
    const trimmed = line.trim();

    const opens = FINDING.exec(trimmed);
    if (opens) {
      findings.push({ severity: opens[1]!.toLowerCase() as Severity, text: line });
      continue;
    }

    // The summary can only be a line that opens no finding; `0 info` in it must
    // not be mistaken for an `info` finding, hence the order here.
    const counts = SUMMARY.exec(trimmed);
    if (counts) {
      summary = {
        error: Number(counts[1]),
        warning: Number(counts[2]),
        info: counts[3] === undefined ? 0 : Number(counts[3]),
      };
      continue;
    }

    // A continuation line belongs to the finding above it; a line before any
    // finding (the header) belongs to nothing.
    const current = findings[findings.length - 1];
    if (current && trimmed !== '') current.text += `\n${line}`;
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
  /**
   * `steps.<id>.outcome` of the oasdiff step, which runs **without** `--fail-on`
   * so that measuring and judging stay separate: finding a breaking change is
   * not a failure of the tool, so the only reason that step can fail is the
   * tool or the runner. `success` is therefore required — anything else is a
   * tool failure, even if a report was written (GoGo-BE#703 Astra F-01: with
   * `--fail-on ERR` behind `continue-on-error`, an action that wrote a matching
   * report and then died of an unrelated error was indistinguishable from the
   * expected breaking-change exit, and the waiver admitted it).
   */
  oasdiffOutcome: string;
  /**
   * Replay mode: the id this comparison must admit, exactly once. Without it a
   * replay of the recorded transition would also pass when upstream stops
   * reporting the finding, leaving a dead entry that looks guarded
   * (GoGo-BE#703 F-02).
   */
  expect?: string | undefined;
}): Verdict {
  const { report, baseSha256, revisionSha256, exceptions, oasdiffOutcome, expect } = input;

  if (oasdiffOutcome !== 'success') {
    return {
      ok: false,
      code: 2,
      lines: [
        `✖ the oasdiff step did not complete (outcome: ${oasdiffOutcome || '(empty)'}).`,
        '  It runs without `--fail-on`, so a breaking change does not fail it: the only',
        '  reasons left are the tool or the runner, and neither is a passing contract',
        '  gate — not even when a report was written before the failure.',
      ],
    };
  }

  const empty = report.trim() === '' || NO_BREAKING.test(report.trimStart());
  const parsed = empty
    ? { summary: { error: 0, warning: 0, info: 0 }, findings: [] }
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

  const counted: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of parsed.findings) counted[finding.severity] += 1;

  const disagree = (['error', 'warning', 'info'] as const).filter(
    (severity) => counted[severity] !== parsed.summary![severity],
  );
  if (disagree.length > 0) {
    return {
      ok: false,
      code: 2,
      lines: [
        '✖ the oasdiff report disagrees with itself. Refusing to guess which half is right:',
        ...disagree.map(
          (severity) =>
            `  · summary says ${parsed.summary![severity]} ${severity}, ${counted[severity]} parsed`,
        ),
      ],
    };
  }

  const errors = parsed.findings.filter((f) => f.severity === 'error');

  if (errors.length === 0) {
    if (expect !== undefined) {
      return {
        ok: false,
        code: 1,
        lines: [
          `✖ this comparison must admit ${expect}, and oasdiff reported no breaking change at all.`,
          '  The entry in .github/oasdiff-exceptions.json no longer describes anything:',
          '  either the specs it names moved, or oasdiff stopped reporting the finding.',
          '  Re-record the decision deliberately; do not leave a dead entry in place.',
        ],
      };
    }
    return { ok: true, lines: ['✔ no breaking change in /v1.'] };
  }

  // One entry admits one finding. Without consuming the match, two identical
  // ERRs would both ride on a single recorded decision (GoGo-BE#703 F-02).
  const pool = [...exceptions];
  const admitted: OasdiffException[] = [];
  const refused: string[] = [];

  for (const finding of errors) {
    const index = pool.findIndex(
      (e) =>
        e.baseSha256 === baseSha256 &&
        e.revisionSha256 === revisionSha256 &&
        normaliseSpace(finding.text).includes(normaliseSpace(e.diagnostic)),
    );
    if (index === -1) refused.push(`  · ${normaliseSpace(finding.text)}`);
    else admitted.push(...pool.splice(index, 1));
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

  if (expect !== undefined) {
    const used = admitted.filter((e) => e.id === expect).length;
    if (used !== 1) {
      return {
        ok: false,
        code: 1,
        lines: [
          `✖ this comparison must admit ${expect} exactly once; it was used ${used} time(s).`,
          ...admitted.map((e) => `  · admitted ${e.id}`),
        ],
      };
    }
  }

  return {
    ok: true,
    lines: [
      `✔ ${admitted.length} breaking change(s), all admitted by a recorded owner decision:`,
      ...admitted.map((e) => `  · ${e.id} (${e.issue}, decided ${e.decidedAt})`),
    ],
  };
}

export interface CliArgs {
  basePath: string;
  revisionPath: string;
  reportPath: string;
  oasdiffOutcome: string;
  exceptionsPath: string;
  expect?: string | undefined;
}

const USAGE =
  'usage: check-contract-compat.ts <base-spec> <revision-spec> <oasdiff-report> <oasdiff-outcome> [--exceptions=<path>] [--expect=<exception-id>]';

const OPTIONS = ['--exceptions', '--expect'] as const;
type Option = (typeof OPTIONS)[number];

/**
 * Strict on purpose. The first version dropped every option it did not
 * recognise and ignored extra positionals, so `--expect <id>` written as two
 * arguments, a misspelled flag or the legacy fifth-positional exceptions file
 * all left `expect` undefined — and a clean historical replay passed, looking
 * guarded (GoGo-BE#703 F-02). A parser that guesses is the gate's failure in
 * miniature. Options take `--name=value` only: a separate value argument could
 * never be told apart from a file path once a shell variable comes up empty.
 */
export function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const options = new Map<Option, string>();

  for (const [index, arg] of argv.entries()) {
    if (arg === '') throw new Error(`argument ${index + 1} is empty`);
    if (arg === '--') {
      throw new Error(
        'a bare `--` is not accepted: options are written --name=value, nothing follows them',
      );
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const known = OPTIONS.find((option) => option === name);
    if (known === undefined) {
      throw new Error(
        `unknown option ${name}: the only options are ${OPTIONS.map((o) => `${o}=`).join(' and ')}`,
      );
    }
    if (eq === -1) {
      throw new Error(
        `${known} takes its value as ${known}=<${known === '--expect' ? 'exception-id' : 'path'}>; a separate argument would be read as a file path`,
      );
    }
    const value = arg.slice(eq + 1);
    if (value === '') throw new Error(`${known}= has no value`);
    if (options.has(known)) throw new Error(`${known} given twice`);
    options.set(known, value);
  }

  const slots = '<base-spec> <revision-spec> <oasdiff-report> <oasdiff-outcome>';
  if (positionals.length < 4) {
    throw new Error(`expected 4 positional arguments (${slots}), got ${positionals.length}`);
  }
  if (positionals.length > 4) {
    throw new Error(
      `unexpected extra argument(s): ${positionals.slice(4).join(' ')} — the exceptions file is --exceptions=<path>, not a fifth positional`,
    );
  }

  const [basePath, revisionPath, reportPath, oasdiffOutcome] = positionals as [
    string,
    string,
    string,
    string,
  ];
  const expect = options.get('--expect');
  return {
    basePath,
    revisionPath,
    reportPath,
    oasdiffOutcome,
    exceptionsPath: options.get('--exceptions') ?? '.github/oasdiff-exceptions.json',
    ...(expect === undefined ? {} : { expect }),
  };
}

const REQUIRED: ReadonlyArray<keyof OasdiffException> = [
  'id',
  'baseSha256',
  'revisionSha256',
  'diagnostic',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The exceptions file, checked for the shape `evaluate` depends on. An id must
 * be unique: `--expect=<id>` presumes it names one decision, and "used N
 * time(s)" would lie about a file where it names two. A duplicate is not a
 * bypass — admission is keyed on the hashes and the diagnostic — but it is a
 * file this gate cannot read unambiguously, and it refuses those.
 */
export function parseExceptions(json: string): OasdiffException[] {
  const parsed: unknown = JSON.parse(json);
  const list = isRecord(parsed) ? parsed.exceptions : undefined;
  if (!Array.isArray(list)) throw new Error('expected a JSON object with an `exceptions` array');

  const seen = new Set<string>();
  return list.map((entry: unknown, index): OasdiffException => {
    if (!isRecord(entry)) throw new Error(`exceptions[${index}] is not an object`);
    for (const key of REQUIRED) {
      const value = entry[key];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`exceptions[${index}].${key} must be a non-empty string`);
      }
    }
    const id = entry.id as string;
    if (seen.has(id)) {
      throw new Error(
        `exception id ${id} appears more than once — --expect names one decision, so an id must name exactly one entry`,
      );
    }
    seen.add(id);
    return entry as unknown as OasdiffException;
  });
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`✖ ${(error as Error).message}`);
    console.error(USAGE);
    process.exit(2);
  }
  const { basePath, revisionPath, reportPath, oasdiffOutcome, exceptionsPath, expect } = args;

  if (!existsSync(reportPath)) {
    console.error(
      `✖ the oasdiff step wrote no report at ${reportPath} — treating that as a failure.`,
    );
    process.exit(2);
  }

  let exceptions: OasdiffException[];
  try {
    exceptions = parseExceptions(readFileSync(exceptionsPath, 'utf8'));
  } catch (error) {
    console.error(`✖ could not read ${exceptionsPath}: ${(error as Error).message}`);
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
    exceptions,
    oasdiffOutcome,
    expect,
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
