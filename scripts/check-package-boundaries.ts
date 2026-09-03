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
 *    `cost-observability` (#388) is held to the same rule for the same reason:
 *    `modules` re-exports it, so an import back would be a cycle.
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

/**
 * COST-BE-029 (#388) — packages that sit *above* the leaves but still below
 * `modules`, and are subject to the same rule.
 *
 * `@gogo/cost-observability` depends on all three leaves; it is not one. What
 * it must not do is import `modules`, because `modules` re-exports it — the
 * cycle that would make the package impossible to extract, which is the whole
 * point of moving it out. The audit writer it used to reach for is inverted
 * into `ports/audit.port.ts` for exactly this reason.
 */
const NON_MODULE_PACKAGES = [...LEAF_PACKAGES, 'libs/cost-observability'];

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

    const pkg = NON_MODULE_PACKAGES.find((p) => file.startsWith(`${p}/`));
    if (pkg && (resolved.startsWith('libs/modules') || specifier === '@gogo/modules')) {
      found.push({
        file,
        line: index + 1,
        statement: specifier,
        rule: LEAF_PACKAGES.includes(pkg)
          ? `${pkg} is a leaf and must not import modules`
          : `${pkg} is re-exported by modules and must not import it back`,
      });
    }
  });

  return found;
}

function main(): void {
  const violations = sources().flatMap(violationsIn);

  console.log(`checked ${sources().length} files under libs/`);
  if (violations.length === 0) {
    console.log('OK: no package imports an app, and nothing below modules imports modules.');
    process.exit(0);
  }

  console.error(`\n${violations.length} boundary violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.statement}\n    ${v.rule}`);
  }
  process.exit(1);
}

main();
