/**
 * GoGo-BE#449 — the contract version has to move when the contract does.
 *
 * Every consumer repo vendors this file and checks its own copy against the
 * version it declares. That check proves nothing while the version never
 * changes: GoGo-CMS and GoGo-MobileApp both sat 14 paths behind `develop` while
 * all three declared `1.0.0-alpha.1` and every drift gate stayed green. The
 * shape of the mistake is not "someone forgot to sync" — it is that syncing was
 * unobservable.
 *
 * So: if `openapi/gogo.v1.yaml` differs from the base branch's copy, `info.version`
 * must differ too. What the new version *is* stays a human decision (MAJOR for a
 * breaking change is already policed by oasdiff); this only refuses the case
 * where the document moved and its name for itself did not.
 */
import { readFileSync } from 'node:fs';

export type VersionCheck =
  { ok: true; reason: 'unchanged' | 'bumped'; version: string } | { ok: false; version: string };

/** `info.version` — the top-level one, not a version nested inside a schema. */
export function declaredVersion(spec: string): string | null {
  // The document's own version sits at two-space indent under `info:`; anything
  // deeper belongs to a schema and must not be mistaken for it.
  const info = /^info:\s*$/m.exec(spec);
  if (!info) return null;
  const after = spec.slice(info.index);
  const match = /^ {2}version:\s*(\S+)\s*$/m.exec(after);
  return match ? match[1]! : null;
}

export function checkVersionBump(base: string, head: string): VersionCheck {
  const headVersion = declaredVersion(head) ?? '(none)';
  // Normalising trailing whitespace keeps a reformat-only commit from demanding
  // a version bump it does not deserve.
  const same = base.trimEnd() === head.trimEnd();
  if (same) return { ok: true, reason: 'unchanged', version: headVersion };

  const baseVersion = declaredVersion(base);
  if (baseVersion === null || headVersion === '(none)') return { ok: false, version: headVersion };
  return baseVersion === headVersion
    ? { ok: false, version: headVersion }
    : { ok: true, reason: 'bumped', version: headVersion };
}

function main(): void {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error('usage: check-openapi-version.ts <base-spec> <head-spec>');
    process.exit(2);
  }

  const result = checkVersionBump(readFileSync(basePath, 'utf8'), readFileSync(headPath, 'utf8'));
  if (result.ok) {
    console.log(
      result.reason === 'unchanged'
        ? `✔ OpenAPI unchanged (${result.version})`
        : `✔ OpenAPI version bumped to ${result.version}`,
    );
    return;
  }

  console.error(
    [
      `✖ openapi/gogo.v1.yaml changed but info.version is still ${result.version}.`,
      '',
      '  GoGo-CMS and GoGo-MobileApp vendor this file and compare their copy against',
      '  the version it declares, so an unchanged version tells them a changed contract',
      '  is the one they already have.',
      '',
      '  Bump info.version, then run `pnpm api:types`.',
    ].join('\n'),
  );
  process.exit(1);
}

if (require.main === module) main();
