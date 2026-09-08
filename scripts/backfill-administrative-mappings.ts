/**
 * ADM-008 (#461) — geometry-only enrichment of existing places.
 *
 * Dry run is the default. Writing requires `--execute`, every time.
 *
 *   pnpm admin:backfill                                   # dry run, whole catalogue
 *   pnpm admin:backfill --execute --batch 500 --max 10000
 *   pnpm admin:backfill --execute --places <uuid>,<uuid>
 *   pnpm admin:backfill --execute --resume <runId>
 *   pnpm admin:backfill --execute --resume <runId> --retry conflicts
 *   pnpm admin:backfill --abandon <runId> --reason "boundaries moved to v5.1.0"
 *
 * There is **no rematch flag**, by decision rather than omission. Reopening a
 * reviewer's `REJECTED` mapping needs a named person to attribute it to, and no
 * command in this repository authenticates one — every CLI-originated audit row
 * here is written as `system` with a null actor id. A bulk switch that could
 * reopen rejections while recording "system" as who asked would be worse than
 * having no switch. Rematch lives in the authenticated CMS workflow (#462).
 *
 * No provider is called at any point: the evidence is stored geometry, GoGo's
 * pinned boundaries and GoGo's own unit data. A run is pinned to the dataset
 * and boundary versions it started against, and it writes only while those are
 * still the active ones.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@gogo/database';
import { createLogger, LogMetrics } from '@gogo/observability';
import {
  AdministrativeBackfillService,
  AdministrativeResolverRepository,
  AdministrativeResolverService,
} from '@gogo/modules';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 4 });
  const db = drizzle(pool, { schema });
  try {
    // #491 — the same wiring the API uses. This read `new LogMetrics()`, and
    // LogMetrics needs an AppLogger for every method it has, so the CLI threw
    // `Cannot read properties of undefined (reading 'info')` on its first metric
    // — before touching the database, on every invocation.
    const metrics = new LogMetrics(
      createLogger({ level: process.env.LOG_LEVEL ?? 'info', name: 'gogo-admin-backfill' }),
    );
    const resolver = new AdministrativeResolverService(
      db,
      new AdministrativeResolverRepository(db),
      metrics,
    );
    const service = new AdministrativeBackfillService(db, resolver, metrics);

    const abandon = flag('abandon');
    if (abandon) {
      const reason = flag('reason');
      if (!reason?.trim()) throw new Error('--abandon requires --reason "<why>"');
      await service.abandon(abandon, reason);
      process.stdout.write(`abandoned ${abandon}: ${reason}\n`);
      return;
    }

    const places = flag('places');
    const result = await service.run({
      dryRun: !has('execute'),
      ...(flag('batch') ? { batchSize: Number(flag('batch')) } : {}),
      ...(flag('max') ? { maxRows: Number(flag('max')) } : {}),
      ...(places ? { placeIds: places.split(',').map((id) => id.trim()) } : {}),
      ...(flag('resume') ? { resumeRunId: flag('resume')! } : {}),
      ...(flag('retry') ? { retry: flag('retry') as 'conflicts' | 'failures' } : {}),
    });

    const c = result.counters;
    process.stdout.write(
      [
        `${result.dryRun ? 'DRY RUN' : 'EXECUTED'} ${result.status}  run ${result.runId}`,
        `dataset     ${result.datasetVersion}`,
        `boundaries  ${result.boundaryVersion ?? '(none pinned)'}`,
        `scanned     ${c.scanned}  eligible ${c.eligible}  already current ${c.alreadyCurrent}`,
        `resolved    AUTO_MATCHED ${c.autoMatched}  NEEDS_REVIEW ${c.needsReview}  UNMAPPED ${c.unmapped}`,
        result.dryRun
          ? `would write ${c.wouldWrite}  no-op ${c.noop}`
          : `written     ${c.written}  no-op ${c.noop}`,
        `protected   VERIFIED ${c.protectedVerified}  REJECTED ${c.protectedRejected}`,
        `conflicts   ${c.conflicts}  failures ${c.failures}`,
        `provider    ${result.providerRequests} requests, $${result.estimatedProviderCostUsd} — ` +
          `${result.upstashCommands} Upstash commands`,
        `duration    ${(result.durationMs / 1000).toFixed(1)}s`,
        '',
        ...result.samples
          .slice(0, 10)
          .map(
            (s) =>
              `  ${s.outcome.padEnd(18)} ${s.placeId} ${s.status} ${s.communeCode ?? '-'} ${s.reason ?? ''}`,
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
