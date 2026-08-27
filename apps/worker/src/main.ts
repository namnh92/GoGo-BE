import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createDb } from '@gogo/database';
import { OutboxDispatcher, PrivacyJobs } from '@gogo/modules';
import { createLogger } from '@gogo/observability';
import { FakePush } from '@gogo/providers';

const OUTBOX_QUEUE = 'gogo-outbox';
const PRIVACY_QUEUE = 'gogo-privacy';

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
  // Real push provider lands with credentials (GoGo-BE#60); fake logs sends.
  const dispatcher = new OutboxDispatcher(db, new FakePush());
  const privacy = new PrivacyJobs(db);

  const outboxQueue = new Queue(OUTBOX_QUEUE, { connection });
  const privacyQueue = new Queue(PRIVACY_QUEUE, { connection });
  await outboxQueue.upsertJobScheduler('outbox-poll', { every: 5000 });
  await privacyQueue.upsertJobScheduler('privacy-daily', {
    pattern: '0 3 * * *',
    tz: 'Asia/Ho_Chi_Minh',
  });

  const outboxWorker = new Worker(
    OUTBOX_QUEUE,
    async () => {
      const handled = await dispatcher.dispatchBatch(100);
      if (handled > 0) logger.info({ handled }, 'outbox batch dispatched');
    },
    { connection, concurrency: 1 },
  );
  const privacyWorker = new Worker(
    PRIVACY_QUEUE,
    async () => {
      const report = await privacy.run(false);
      logger.info({ report }, 'privacy retention run complete');
    },
    { connection, concurrency: 1 },
  );

  outboxWorker.on('failed', (_job, err) => logger.error({ err }, 'outbox job failed'));
  privacyWorker.on('failed', (_job, err) => logger.error({ err }, 'privacy job failed'));
  logger.info('worker booted: outbox poll 5s, privacy daily 03:00 ICT');

  const shutdown = async () => {
    logger.info('worker shutting down');
    await Promise.allSettled([
      outboxWorker.close(),
      privacyWorker.close(),
      outboxQueue.close(),
      privacyQueue.close(),
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
