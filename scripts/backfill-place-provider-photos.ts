/** #797 — explicit ops CLI, lifecycle follows backfill-place-addresses.ts. */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@gogo/database';
import { GooglePlacesAdapter, R2StorageAdapter, resolveR2AccountId } from '@gogo/providers';
import { createLogger, LogMetrics, TeeMetrics } from '@gogo/observability';
import {
  backfillProviderPhotos,
  DbPhotoBackfillStore,
  SubmissionPhotoService,
  ProviderPhotosService,
  DbUsageLedger,
  DEFAULT_LEDGER_FLUSH_MS,
} from '@gogo/modules';
import { parseProviderPhotoBackfillArgs } from './place-provider-photo-backfill-args';

async function main(): Promise<void> {
  const options = parseProviderPhotoBackfillArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if ((!options.dryRun || options.probe) && !key)
    throw new Error('GOOGLE_PLACES_API_KEY is required');
  const environment = process.env.APP_ENV ?? 'dev';
  if (!['dev', 'staging', 'prod', 'production'].includes(environment)) {
    throw new Error('Invalid APP_ENV');
  }
  const numeric = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (
      !raw.trim() ||
      !Number.isFinite(value) ||
      value < 0 ||
      (name !== 'PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD' && !Number.isSafeInteger(value))
    )
      throw new Error('Invalid display budget');
    return value;
  };
  const boolean = (name: string, fallback: boolean): boolean => {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (raw !== 'true' && raw !== 'false') throw new Error('Invalid boolean');
    return raw === 'true';
  };
  const config = {
    APP_ENV: environment as 'dev' | 'staging' | 'prod' | 'production',
    FLAG_PLACE_PROVIDER_PHOTOS: boolean('FLAG_PLACE_PROVIDER_PHOTOS', false),
    PROVENANCE_UNIFIED_READS: boolean('PROVENANCE_UNIFIED_READS', true),
    PLACE_DISPLAY_DAILY_MAX_CALLS: numeric('PLACE_DISPLAY_DAILY_MAX_CALLS'),
    PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD: numeric('PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD'),
    PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA: numeric(
      'PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA',
    ),
  };
  const accountId = resolveR2AccountId({
    accountId: process.env.R2_ACCOUNT_ID,
    endpoint: process.env.R2_ENDPOINT,
  });
  const storageConfigured = Boolean(
    accountId &&
    process.env.R2_PUBLIC_BUCKET &&
    process.env.R2_PUBLIC_ACCESS_KEY_ID &&
    process.env.R2_PUBLIC_SECRET_ACCESS_KEY &&
    process.env.MEDIA_PUBLIC_BASE_URL,
  );
  if (!options.dryRun && !storageConfigured) throw new Error('Catalogue storage is required');
  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });
  const base = new LogMetrics(createLogger({ level: 'info', name: 'gogo-place-photo-backfill' }));
  // Dry-run/probe must not write even a usage ledger row. Details are free;
  // apply retains the durable metering/flush lifecycle of the address command.
  const ledger = options.dryRun ? null : new DbUsageLedger(db, { environment, metrics: base });
  const metrics = ledger ? new TeeMetrics([base, ledger]) : base;
  const photos = new ProviderPhotosService(
    db,
    new GooglePlacesAdapter(key ?? '', metrics),
    config,
    metrics,
  );
  const persistence = new SubmissionPhotoService(
    db,
    photos,
    new R2StorageAdapter({
      accountId,
      bucket: process.env.R2_PUBLIC_BUCKET ?? '',
      accessKeyId: process.env.R2_PUBLIC_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_PUBLIC_SECRET_ACCESS_KEY ?? '',
    }),
    storageConfigured,
  );
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
    if (!ledger || stop.signal.aborted || scheduledFlush !== null) return;
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
      const counts = await backfillProviderPhotos(
        new DbPhotoBackfillStore(db, persistence, config.PROVENANCE_UNIFIED_READS),
        photos,
        persistence,
        {
          ...options,
          signal: stop.signal,
          reportCandidate: options.dryRun
            ? (id) => process.stdout.write(`${JSON.stringify({ candidateId: id })}\n`)
            : undefined,
        },
      );
      process.stdout.write(
        `${JSON.stringify({ mode: options.dryRun ? (options.probe ? 'probe' : 'dry-run') : 'apply', ...counts })}\n`,
      );
      if (counts.errors > 0) process.exitCode = 1;
    } finally {
      clearInterval(timer);
      await scheduledFlush;
      try {
        await ledger?.stop();
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

export async function runProviderPhotoBackfillCli(): Promise<void> {
  try {
    await main();
  } catch {
    // Never echo arbitrary errors: pg/provider messages may contain sensitive data.
    process.stderr.write(
      'Place provider photo backfill failed; check configuration and count logs.\n',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) void runProviderPhotoBackfillCli();
