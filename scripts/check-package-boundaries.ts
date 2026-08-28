/**
 * FND-003 (#13) — the dependency direction, enforced.
 *
 * Acceptance is "no reverse import from an app into a package". A package that
 * reaches back into an app stops being publishable: consumers get a module
 * graph that only resolves inside this repo, and the failure shows up in
 * *their* build rather than in ours.
 *
 * Two directions are checked, because only one of them is obvious:
 *
 * 1. `libs/**` must not import from `apps/**`.
 * 2. The lower libs (`database`, `observability`, `providers`) must not import
 *    from `modules`. They are the leaves; `modules` composes them. A cycle
 *    here is what makes a package impossible to extract later.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

/** Every .ts file under libs, excluding build output. */
function sources(): string[] {
  return execFileSync(
    'find',
    ['libs', '-name', '*.ts', '-not', '-path', '*/dist/*', '-not', '-path', '*/node_modules/*'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

const LEAF_PACKAGES = ['libs/database', 'libs/observability', 'libs/providers'];

type Violation = { file: string; line: number; statement: string; rule: string };

function violationsIn(file: string): Violation[] {
  const text = readFileSync(path.join(repoRoot, file), 'utf8');
  const found: Violation[] = [];

  text.split('\n').forEach((line, index) => {
    const match = /^\s*(?:import|export)[^'"]*['"]([^'"]+)['"]/.exec(line);
    if (!match) return;
    const specifier = match[1]!;

    const resolved = specifier.startsWith('.')
      ? path.normalize(path.join(path.dirname(file), specifier))
      : specifier;

    if (resolved.startsWith('apps/') || specifier.startsWith('@gogo/api')) {
      found.push({
        file,
        line: index + 1,
        statement: specifier,
        rule: 'libs must not import apps',
      });
    }

    const leaf = LEAF_PACKAGES.find((pkg) => file.startsWith(`${pkg}/`));
    if (leaf && (resolved.startsWith('libs/modules') || specifier === '@gogo/modules')) {
      found.push({
        file,
        line: index + 1,
        statement: specifier,
        rule: `${leaf} is a leaf and must not import modules`,
      });
    }
  });

  return found;
}

function main(): void {
  const violations = sources().flatMap(violationsIn);

  console.log(`checked ${sources().length} files under libs/`);
  if (violations.length === 0) {
    console.log('OK: no package imports an app, and no leaf package imports modules.');
    process.exit(0);
  }

  console.error(`\n${violations.length} boundary violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.statement}\n    ${v.rule}`);
  }
  process.exit(1);
}

main();
