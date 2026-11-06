/** #776 — follows scripts/backfill-administrative-mappings.ts (explicit ops CLI). */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@gogo/database';
import { GooglePlacesAdapter } from '@gogo/providers';
import { createLogger, LogMetrics, TeeMetrics } from '@gogo/observability';
import { backfillPlaceAddresses, DbAddressBackfillStore, DbUsageLedger } from '@gogo/modules';
import { parseAddressBackfillArgs } from './place-address-backfill-args';

async function main(): Promise<void> {
  const options = parseAddressBackfillArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!options.dryRun && !key) throw new Error('GOOGLE_PLACES_API_KEY is required');
  const environment = process.env.APP_ENV ?? 'dev';
  if (!['dev', 'staging', 'prod', 'production'].includes(environment)) {
    throw new Error('Invalid APP_ENV');
  }
  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });
  const base = new LogMetrics(createLogger({ level: 'info', name: 'gogo-place-address-backfill' }));
  // Same metrics tee + durable usage ledger as ProvidersModule. Always enabled
  // for this paid ops command; preview emits no usage. Flush before closing DB.
  const ledger = new DbUsageLedger(db, { environment, metrics: base });
  ledger.start();
  try {
    const counts = await backfillPlaceAddresses(
      new DbAddressBackfillStore(db),
      new GooglePlacesAdapter(key ?? '', new TeeMetrics([base, ledger])),
      options,
    );
    process.stdout.write(
      `${JSON.stringify({ mode: options.dryRun ? 'dry-run' : 'execute', ...counts })}\n`,
    );
    if (counts.errors > 0) process.exitCode = 1;
  } finally {
    try {
      await ledger.stop();
    } finally {
      await pool.end();
    }
  }
}

void main().catch(() => {
  // Never echo arbitrary errors: pg/provider messages may contain sensitive data.
  process.stderr.write('Place address backfill failed; check configuration and count logs.\n');
  process.exitCode = 1;
});
