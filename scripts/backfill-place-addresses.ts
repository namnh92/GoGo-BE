/** #776 — follows scripts/backfill-administrative-mappings.ts (explicit ops CLI). */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@gogo/database';
import { GooglePlacesAdapter } from '@gogo/providers';
import { createLogger, LogMetrics, TeeMetrics } from '@gogo/observability';
import {
  backfillPlaceAddresses,
  DbAddressBackfillStore,
  DbUsageLedger,
  DEFAULT_LEDGER_FLUSH_MS,
} from '@gogo/modules';
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
  const stop = new AbortController();
  let signalExitCode = 0;
  let flushFailed = false;
  let scheduledFlush: Promise<void> | null = null;
  const onSignal = (code: number) => {
    if (signalExitCode === 0) signalExitCode = code;
    stop.abort();
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  // Own the timer here: DbUsageLedger.start() discards a rejected flush promise.
  // flush() restores failed counts; stop() retries them after the current place.
  const timer = setInterval(() => {
    if (stop.signal.aborted || scheduledFlush !== null) return;
    scheduledFlush = ledger
      .flush()
      .catch(() => {
        flushFailed = true;
        stop.abort();
      })
      .finally(() => {
        scheduledFlush = null;
      });
  }, DEFAULT_LEDGER_FLUSH_MS);
  timer.unref();
  try {
    try {
      const counts = await backfillPlaceAddresses(
        new DbAddressBackfillStore(db),
        new GooglePlacesAdapter(key ?? '', new TeeMetrics([base, ledger])),
        { ...options, signal: stop.signal },
      );
      process.stdout.write(
        `${JSON.stringify({ mode: options.dryRun ? 'dry-run' : 'execute', ...counts })}\n`,
      );
      if (counts.errors > 0) process.exitCode = 1;
    } finally {
      clearInterval(timer);
      await scheduledFlush;
      try {
        await ledger.stop();
      } finally {
        await pool.end();
      }
    }
    if (flushFailed) throw new Error('Usage ledger flush failed');
    if (signalExitCode !== 0) process.exitCode = signalExitCode;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

export async function runAddressBackfillCli(): Promise<void> {
  try {
    await main();
  } catch {
    // Never echo arbitrary errors: pg/provider messages may contain sensitive data.
    process.stderr.write('Place address backfill failed; check configuration and count logs.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) void runAddressBackfillCli();
