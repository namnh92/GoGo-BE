import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * GoGo-BE#703 F-02 (Sol, confirm round): the command line used to drop every
 * option it did not recognise and ignore extra positionals. `--expect <id>`
 * written as two arguments, a misspelled flag, the legacy fifth-positional
 * exceptions file or a bare `--` all left `expect` undefined — and a clean
 * historical replay exited 0 looking guarded.
 *
 * These run the real entry point the way ci.yml does, so the wiring in `main`
 * is covered and not only `parseArgs`. A spawn costs ~0.4 s.
 */
const ROOT = path.resolve(__dirname, '..');
const ID = 'BE-694-room-events-resync-oneof';

let dir: string;
let positionals: string[];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'contract-compat-cli-'));
  const base = path.join(dir, 'base.yaml');
  const revision = path.join(dir, 'revision.yaml');
  const report = path.join(dir, 'report.txt');
  writeFileSync(base, 'openapi: 3.1.0\ninfo: { version: 1.0.0-alpha.1 }\n');
  writeFileSync(revision, 'openapi: 3.1.0\ninfo: { version: 1.0.0-alpha.2 }\n');
  // A clean report is the one input a lost `--expect` turns into a false pass.
  writeFileSync(report, 'No breaking changes to report, but the specs are different.\n');
  positionals = [base, revision, report, 'success'];
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(
    'node',
    ['-r', '@swc-node/register', 'scripts/check-contract-compat.ts', ...args],
    {
      cwd: ROOT,
      env: { ...process.env, SWC_NODE_PROJECT: './tsconfig.base.json' },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
}

describe('check-contract-compat command line (#703 F-02)', () => {
  it('accepts both forms ci.yml uses', () => {
    expect(run(positionals).status).toBe(0);
    // `--expect=` on a clean report is a policy failure: proof the flag was read.
    const replay = run([...positionals, `--expect=${ID}`]);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain(`must admit ${ID}`);
  }, 90_000);

  it.each([
    [
      '--expect split from its value',
      ['--expect', ID],
      '--expect takes its value as --expect=<exception-id>',
    ],
    ['a misspelled option', [`--expct=${ID}`], 'unknown option --expct'],
    [
      'the legacy fifth-positional exceptions file',
      ['.github/oasdiff-exceptions.json'],
      'not a fifth positional',
    ],
    ['a bare --', ['--'], 'bare `--`'],
  ])(
    'refuses %s as a usage error instead of passing a clean replay',
    (_label, extra, reason) => {
      const result = run([...positionals, ...extra]);
      expect(result.stdout).not.toContain('✔ no breaking change');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(reason);
      expect(result.stderr).toContain('usage:');
    },
    90_000,
  );
});
