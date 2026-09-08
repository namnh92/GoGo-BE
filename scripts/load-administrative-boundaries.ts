/**
 * ADM-007 (#460) — load a pinned boundary release into PostgreSQL.
 *
 * An operational step, not a migration and not part of API startup: nothing on
 * the request path ever reaches for this archive, and a machine with no network
 * can still run it against a cached or explicitly supplied file.
 *
 *   pnpm db:boundaries
 *   ADMINISTRATIVE_BOUNDARY_ARCHIVE=/path/to/archive.zip pnpm db:boundaries
 *   pnpm db:boundaries --role boundaries-fixture --version fixture-v1
 *
 * Idempotent: re-running against the same archive reports `unchanged` and
 * writes nothing. Running a *different* archive under a version name that is
 * already loaded is refused.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@gogo/database';
import { AdministrativeBoundaryImportService } from '@gogo/modules';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });
  try {
    const service = new AdministrativeBoundaryImportService(db);
    const result = await service.load({
      ...(flag('role') ? { role: flag('role')! } : {}),
      ...(flag('version') ? { boundaryVersion: flag('version')! } : {}),
      ...(flag('archive') ? { archivePath: flag('archive')! } : {}),
    });

    process.stdout.write(
      [
        `${result.outcome}: ${result.boundaryVersion}`,
        `archive     ${result.archive.origin} ${result.archive.path}`,
        `checksum    ${result.archive.sha256}`,
        `loaded      ${result.counts.provinces} provinces, ${result.counts.communes} communes`,
        `promoted    ${result.promotedToMultiPolygon} polygons to MultiPolygon`,
        `validation  ${result.validation.errors} errors, ${result.validation.warnings} warnings`,
        // #491 — `.count`, not `.length`. These are `Anomaly` objects, so
        // `.length` was undefined and this line printed "undefined overlaps,
        // undefined outside the Vietnam envelope" on every real load. The
        // numbers were measured correctly and thrown away at the last step;
        // adding scripts/ to the typecheck graph is what surfaced it.
        `topology    ${result.topology.sharedBoundaryPairs} shared borders, ` +
          `${result.topology.sameLevelOverlaps.count} overlaps, ` +
          `${result.topology.outsideVietnamBbox.count} outside the Vietnam envelope`,
        `duration    ${(result.durationMs / 1000).toFixed(1)}s`,
        '',
        ...result.validation.findings.map(
          (f) => `  ${f.severity} ${f.gate} (${f.count}) ${f.samples.slice(0, 3).join(', ')}`,
        ),
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
