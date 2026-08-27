import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createDb } from '@gogo/database';
import {
  OutboxDispatcher,
  PlaceDedupService,
  PlaceImportJobService,
  PlaceResolverService,
  PrivacyJobs,
} from '@gogo/modules';
import { LogMetrics, createLogger } from '@gogo/observability';
import {
  FakePush,
  FakeSheets,
  FakePlaceProvider,
  GooglePlacesAdapter,
  GoogleSheetsAdapter,
} from '@gogo/providers';

const OUTBOX_QUEUE = 'gogo-outbox';
const PRIVACY_QUEUE = 'gogo-privacy';
const INGEST_QUEUE = 'gogo-ingest';

/**
 * Dead-man-switch heartbeats (healthchecks.io style): ping ONLY after a
 * successful run, throttled — the monitor alerts when pings stop, covering
 * silent worker death that process-level monitoring misses.
 */
const lastPing = new Map<string, number>();
async function heartbeat(url: string | undefined, throttleMs = 60_000): Promise<void> {
  if (!url) return;
  const now = Date.now();
  if (now - (lastPing.get(url) ?? 0) < throttleMs) return;
  lastPing.set(url, now);
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  } catch {
    // Heartbeat failure must never break job processing.
  }
}

/**
 * Worker process (BE-BFF-010 + DB-010): BullMQ consumers for outbox fan-out
 * and privacy/retention. Jobs are at-least-once; consumers are idempotent
 * (outbox marks published per event; privacy jobs are pure re-runnable SQL).
 */
async function bootstrap(): Promise<void> {
  const logger = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'gogo-worker',
    pretty: process.env.NODE_ENV === 'development',
  });
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL and REDIS_URL are required');
  }

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const { db, pool } = createDb(databaseUrl);
  const metrics = new LogMetrics(logger);
  // Real push provider lands with credentials (GoGo-BE#60); fake logs sends.
  const dispatcher = new OutboxDispatcher(db, new FakePush(), metrics);
  const privacy = new PrivacyJobs(db);

  // PI-BE-015: bulk import chunks run here, not in the API process. The tick
  // polls for jobs an admin has started rather than consuming an enqueue, so a
  // start survives an API restart and no message can strand a job.
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
  const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY || mapsKey;
  const placeProvider = mapsKey
    ? new GooglePlacesAdapter(mapsKey, metrics)
    : new FakePlaceProvider();
  const imports = new PlaceImportJobService(
    db,
    new PlaceResolverService(placeProvider, db),
    new PlaceDedupService(db),
    sheetsKey ? new GoogleSheetsAdapter(sheetsKey) : new FakeSheets(),
    metrics,
  );

  const outboxQueue = new Queue(OUTBOX_QUEUE, { connection });
  const privacyQueue = new Queue(PRIVACY_QUEUE, { connection });
  const ingestQueue = new Queue(INGEST_QUEUE, { connection });
  await outboxQueue.upsertJobScheduler('outbox-poll', { every: 5000 });
  await ingestQueue.upsertJobScheduler('ingest-poll', { every: 5000 });
  await privacyQueue.upsertJobScheduler('privacy-daily', {
    pattern: '0 3 * * *',
    tz: 'Asia/Ho_Chi_Minh',
  });

  const outboxWorker = new Worker(
    OUTBOX_QUEUE,
    async () => {
      const handled = await dispatcher.dispatchBatch(100);
      if (handled > 0) logger.info({ handled }, 'outbox batch dispatched');
      await heartbeat(process.env.HEARTBEAT_URL_OUTBOX);
    },
    { connection, concurrency: 1 },
  );
  const privacyWorker = new Worker(
    PRIVACY_QUEUE,
    async () => {
      const report = await privacy.run(false);
      logger.info({ report }, 'privacy retention run complete');
      await heartbeat(process.env.HEARTBEAT_URL_PRIVACY, 0);
    },
    { connection, concurrency: 1 },
  );

  const ingestWorker = new Worker(
    INGEST_QUEUE,
    async () => {
      const advanced = await imports.processPendingJobs(5);
      if (advanced.length > 0) logger.info({ advanced }, 'place import chunks processed');
      await heartbeat(process.env.HEARTBEAT_URL_INGEST);
    },
    // Serial by design: chunks already batch 50 rows and each row may cost a
    // provider call, so parallel ticks would only race the quota.
    { connection, concurrency: 1 },
  );

  outboxWorker.on('failed', (_job, err) => logger.error({ err }, 'outbox job failed'));
  ingestWorker.on('failed', (_job, err) => logger.error({ err }, 'ingest job failed'));
  privacyWorker.on('failed', (_job, err) => logger.error({ err }, 'privacy job failed'));
  logger.info('worker booted: outbox 5s, ingest 5s, privacy daily 03:00 ICT');

  const shutdown = async () => {
    logger.info('worker shutting down');
    await Promise.allSettled([
      outboxWorker.close(),
      privacyWorker.close(),
      ingestWorker.close(),
      outboxQueue.close(),
      privacyQueue.close(),
      ingestQueue.close(),
    ]);
    await pool.end();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
