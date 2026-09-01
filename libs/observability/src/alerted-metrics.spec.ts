import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALERTED_METRICS } from './alerted-metrics';

const repoRoot = path.resolve(__dirname, '../../..');

/**
 * PI-SRE-001 (#120) — the alert test.
 *
 * An alert rule matching a series nobody emits any more looks exactly like an
 * alert that is quiet because nothing is wrong. These fail on a rename, which
 * is the only moment the difference is cheap to notice.
 */
describe('alerted metrics', () => {
  // Whole source rather than a call-site pattern: `observe(` often wraps onto
  // the next line, and a regex that only matched the single-line form reported
  // a metric as missing while it was being emitted two lines down.
  const emitted = execFileSync(
    'grep',
    [
      '-rhoE',
      "'[a-z_]+'",
      '--include=*.ts',
      '--exclude=alerted-metrics.ts',
      '--exclude=*.spec.ts',
      'libs',
      'apps',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  it.each(ALERTED_METRICS)('%s is still emitted somewhere', (metric) => {
    // Source-level rather than runtime: driving every one of these through its
    // endpoint would be nine integration tests to catch a rename, and a rename
    // is the failure mode worth catching.
    expect(emitted).toContain(`'${metric}'`);
  });

  it('every alert in infrastructure.md names a metric on this list', () => {
    const doc = readFileSync(path.join(repoRoot, 'docs/infrastructure.md'), 'utf8');
    // The *alert* table only. §3b also carries the inventory table of every
    // metric GoGo emits, and those are two different claims: "this series
    // exists" and "an alert fires on this series". Scanning the whole section
    // conflated them, so completing the inventory (#319) turned every
    // uninstrumented-but-real metric into a failure here.
    const section = doc.slice(doc.indexOf('Alert đề xuất'), doc.indexOf('## 3c.'));
    // The first backticked token of each table row. Scanning the whole
    // section picked up `duration_ms`, which is a *label* of
    // places_provider_requests_total sitting in the label column — a real
    // identifier, just not a metric.
    const named = section
      .split('\n')
      .filter((line) => line.trimStart().startsWith('|'))
      .map((line) => /`([a-z_]+)`/.exec(line)?.[1])
      .filter(
        (name): name is string => Boolean(name) && /_(total|ms|units|hours|bucket)$/.test(name!),
      );
    expect(named.length).toBeGreaterThan(0);
    for (const metric of new Set(named)) {
      // A doc naming a metric the code does not know about is a rule that will
      // never fire, written down as though it will.
      expect(ALERTED_METRICS).toContain(metric);
    }
  });
});
