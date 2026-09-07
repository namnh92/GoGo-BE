import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_LABELS, TIMED_LABEL } from './metric-labels';

const repoRoot = path.resolve(__dirname, '../../..');

/**
 * #319 — the cardinality test.
 *
 * Source-level, like the alert test beside it, and for the same reason: the
 * failure being caught is somebody adding a label, and that is visible in
 * source without standing up nine integration tests to provoke each emitter.
 *
 * What this cannot check is whether a label's *values* are finite — only a
 * human reading `METRIC_LABELS` can say that. What it does check is that the
 * set of keys never grows without someone opening that file and being asked
 * the question.
 */

type Emission = { file: string; metric: string; labels: string[] };

/** Index of the `)` closing the `(` at `open`, skipping strings. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The first `{…}` inside a call — the label object, wherever it sits. */
function firstObject(call: string): string | null {
  const open = call.indexOf('{');
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < call.length; i += 1) {
    if (call[i] === '{') depth += 1;
    else if (call[i] === '}') {
      depth -= 1;
      if (depth === 0) return call.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Replace the *contents* of every string literal with spaces, keeping offsets.
 *
 * Without this, `action: \`${method} ${url}\`` reads as a shorthand key named
 * `method` — a `${…}` interpolation is a brace-wrapped identifier and looks
 * exactly like one to a regex. The first run of this spec duly reported a
 * label that does not exist.
 */
function blankStrings(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      if (c === quote) {
        quote = null;
        out += c;
      } else out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

function labelKeys(objectSrc: string): string[] {
  const object = blankStrings(objectSrc);
  const keys = new Set<string>();
  // `key: value` and bare shorthand `key`, at any depth. Label values are
  // scalars, so there is no nesting to confuse this.
  for (const m of object.matchAll(/(?:^|[,{])\s*(\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\s*([:,}]|$)/g)) {
    // A spread cannot be resolved from source. Recorded so the assertion
    // below fails loudly rather than passing over it.
    keys.add(m[1] ? `...${m[2]}` : m[2]!);
  }
  return [...keys];
}

function collect(): Emission[] {
  const files = execFileSync(
    'grep',
    ['-rlE', '\\.(increment|observe|time|gauge)\\(', '--include=*.ts', 'libs', 'apps'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\n')
    .filter((f) => f && !f.endsWith('.spec.ts'));

  const out: Emission[] = [];
  for (const file of files) {
    const src = readFileSync(path.join(repoRoot, file), 'utf8');
    for (const m of src.matchAll(/\.(increment|observe|time|gauge)\(\s*'([a-z_]+)'/g)) {
      const open = src.indexOf('(', m.index! + 1);
      const close = matchParen(src, open);
      if (close === -1) continue;
      const object = firstObject(src.slice(open, close));
      out.push({ file, metric: m[2]!, labels: object ? labelKeys(object) : [] });
    }
  }
  return out;
}

describe('metric label contract', () => {
  const emissions = collect();

  it('finds the emission sites at all', () => {
    // A regex that silently matches nothing would make every assertion below
    // pass while checking exactly nothing.
    expect(emissions.length).toBeGreaterThan(20);
  });

  it('every emitted metric is declared in METRIC_LABELS', () => {
    const undeclared = emissions
      .filter((e) => !(e.metric in METRIC_LABELS))
      .map((e) => `${e.metric} (${e.file})`);
    expect(undeclared).toEqual([]);
  });

  it('no emission passes a label the contract does not allow', () => {
    const violations: string[] = [];
    for (const e of emissions) {
      const allowed = METRIC_LABELS[e.metric];
      if (!allowed) continue;
      for (const key of e.labels) {
        if (key === TIMED_LABEL) continue;
        if (!allowed.includes(key)) violations.push(`${e.metric}{${key}} in ${e.file}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('declares no metric that nothing emits', () => {
    const emitted = new Set(emissions.map((e) => e.metric));
    // A contract entry for a metric nobody writes is a stale line that makes
    // the audit look more complete than it is.
    expect([...Object.keys(METRIC_LABELS)].filter((m) => !emitted.has(m))).toEqual([]);
  });

  it('rejects the two labels that already had to be removed', () => {
    // #313 and #319 by name. A regression here is not hypothetical — both of
    // these shipped once.
    for (const [metric, labels] of Object.entries(METRIC_LABELS)) {
      expect(labels, `${metric} must not carry a raw duration`).not.toContain('duration_ms');
      expect(labels, `${metric} must not carry operator free text`).not.toContain('field');
    }
  });

  it('documents every contracted metric in infrastructure.md §3b', () => {
    const doc = readFileSync(path.join(repoRoot, 'docs/infrastructure.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 3b.'), doc.indexOf('## 3c.'));
    const undocumented = Object.keys(METRIC_LABELS).filter((m) => !section.includes(`\`${m}\``));
    // The table in §3b is what an operator reads before writing a query. A
    // metric missing from it is a series nobody knows exists.
    expect(undocumented).toEqual([]);
  });
});
