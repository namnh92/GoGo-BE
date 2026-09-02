import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #341 (PR8) — the ephemeral provider-content boundary, enforced on the source
 * tree (ADR-0006 §9.7.3, invariant 3).
 *
 * The type system stops the ephemeral value from reaching a repository method
 * that takes a `ResolvedProviderPlace` (`provider-content.spec.ts`). It cannot
 * stop someone from writing a *new* insert that takes the ephemeral shape by
 * hand — `db.insert(schema.places).values({ name: content.facts.name })`
 * compiles fine. This spec is what refuses that:
 *
 * - Every file that names the boundary's identifiers must be on the carrier
 *   list below. A new carrier is a review decision, made here.
 * - No carrier may contain a write statement — Drizzle or raw SQL. The
 *   boundary's own files fetch, compare, audit (through `writeAudit`, which
 *   takes ids and never a provider object) and return; a write there is a
 *   defect whatever it writes.
 * - The identifiers may never appear under `libs/database`, in any
 *   `infrastructure/` directory, in the worker, or in the services that do
 *   persist provider facts today (R4 debt, §9.7.5). Those files must not even
 *   be able to *see* the ephemeral type.
 *
 * Comments are stripped before scanning, so prose that mentions the service
 * by name (a flag description, a docstring) is not a carrier.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const IDENTIFIERS = [
  'EphemeralProviderContent',
  'ProviderContentAnswer',
  'ProviderContentFacts',
  'toEphemeralProviderContent',
  'ProviderContentService',
  'PROVIDER_CONTENT_KIND',
] as const;

/** Files allowed to name the boundary. Relative to the repo root. */
const CARRIERS = [
  'libs/modules/ingestion/domain/provider-content.ts',
  'libs/modules/ingestion/application/provider-content.service.ts',
  'libs/modules/ingestion/presentation/ingestion.module.ts',
  'libs/modules/cms/application/cms-provider-preview.service.ts',
  'libs/modules/src/index.ts',
] as const;

/** Files that must never see the type, whatever the carrier list says. */
const QUARANTINED = [
  'libs/database/',
  '/infrastructure/',
  'apps/worker/',
  'libs/modules/ingestion/application/place-refresh.service.ts',
  'libs/modules/ingestion/application/place-dedup.service.ts',
  'libs/modules/ingestion/application/place-import-job.service.ts',
  'libs/modules/ingestion/application/place-submission.service.ts',
  'libs/modules/places/application/place-import.service.ts',
] as const;

const WRITE_STATEMENTS: readonly RegExp[] = [
  /\.insert\(/,
  /\.update\(/,
  /\.delete\(/,
  /onConflictDoUpdate/,
  /onConflictDoNothing/,
  /\binsert\s+into\b/i,
  /\bupdate\s+[a-z_"]+\s+set\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\b/i,
];

const SCAN_ROOTS = ['libs', 'apps', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, into);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.spec.ts') || entry.endsWith('.d.ts')) continue;
    into.push(path.relative(REPO_ROOT, full));
  }
  return into;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

function carriersFound(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of SCAN_ROOTS.flatMap((root) => sources(path.join(REPO_ROOT, root)))) {
    const code = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const hits = IDENTIFIERS.filter((id) => code.includes(id));
    if (hits.length > 0) found.set(file, hits);
  }
  return found;
}

describe('ephemeral provider-content boundary (#341, ADR-0006 §9.7.3)', () => {
  const found = carriersFound();

  it('every carrier on the list still exists (a rename must update the list)', () => {
    for (const file of CARRIERS) {
      expect(() => statSync(path.join(REPO_ROOT, file)), file).not.toThrow();
    }
  });

  it('only the listed carriers name the boundary', () => {
    const unlisted = [...found.keys()].filter((f) => !(CARRIERS as readonly string[]).includes(f));
    expect(
      unlisted,
      `unlisted carriers: ${JSON.stringify(Object.fromEntries(unlisted.map((f) => [f, found.get(f)])))}`,
    ).toEqual([]);
  });

  it('nothing quarantined can see the type', () => {
    const leaked = [...found.keys()].filter((f) => QUARANTINED.some((q) => f.includes(q)));
    expect(leaked).toEqual([]);
  });

  it('no carrier contains a write statement', () => {
    const offenders: { file: string; statement: string }[] = [];
    for (const file of CARRIERS) {
      const code = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      for (const pattern of WRITE_STATEMENTS) {
        const match = pattern.exec(code);
        if (match) offenders.push({ file, statement: match[0] });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the boundary files reach the database only through the flag, the reservation and writeAudit', () => {
    // A belt for the braces above: the two services may hold a `Db` for the
    // reads they need, but the only insert-shaped call allowed is the audit.
    for (const file of [
      'libs/modules/ingestion/application/provider-content.service.ts',
      'libs/modules/cms/application/cms-provider-preview.service.ts',
    ]) {
      const code = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      const dbCalls = [...code.matchAll(/\bthis\.db\s*\.\s*([a-zA-Z]+)\s*\(/g)].map((m) => m[1]);
      for (const call of dbCalls) {
        expect(['select', 'execute'], `${file} calls this.db.${call}`).toContain(call);
      }
    }
  });

  it('the CMS controller never sees the boundary; it knows only the CMS service', () => {
    // Controllers hold no business logic (CLAUDE.md); here that also means
    // the answer is shaped into a DTO before it reaches presentation, so a
    // future route cannot pass the ephemeral value anywhere else.
    const code = stripComments(
      readFileSync(
        path.join(REPO_ROOT, 'libs/modules/cms/presentation/cms.controllers.ts'),
        'utf8',
      ),
    );
    expect(IDENTIFIERS.filter((id) => code.includes(id))).toEqual([]);
    expect(code).toContain('CmsProviderPreviewService');
  });
});
