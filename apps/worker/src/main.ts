import os from 'node:os';
import { createDb } from '@gogo/database';
import {
  CampaignDispatcher,
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
  warnFakedProviders,
} from '@gogo/providers';
import { AdvisoryLock, startPeriodic } from './periodic';

/**
 * Poll intervals, in milliseconds.
 *
 * Each tick is a Postgres query to find work, so the interval is the ceiling
 * on dispatch latency and the floor on idle database load — nothing else. It
 * used to also be the dominant Redis cost of the worker, back when a BullMQ
 * scheduler created and completed a job every tick; the worker no longer holds
 * a Redis connection at all (see periodic.ts).
 *
 * The trade is dispatch latency: at 60s a notification waits up to a minute
 * before the outbox relay picks it up. Acceptable on DEV, tuned down for
 * production through the same variables.
 */
const pollIntervalMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1000) {
    throw new Error(`${name} must be a number of milliseconds >= 1000, received "${raw}"`);
  }
  return value;
};

const OUTBOX_POLL_MS = pollIntervalMs('OUTBOX_POLL_MS', 5000);
const INGEST_POLL_MS = pollIntervalMs('INGEST_POLL_MS', 5000);
const PRIVACY_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * How often this process says it is alive. Its own job, on its own cadence:
 * tying it to a business tick would make "worker alive" mean "outbox tick
 * ran", and those stop being the same thing the day the outbox tick hangs.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

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
 * Worker process (BE-BFF-010 + DB-010): periodic processors for outbox
 * fan-out, place import and privacy/retention. Each tick is at-least-once and
 * idempotent (outbox marks published per event; import advances chunks it
 * finds pending; privacy jobs are pure re-runnable SQL), and a Postgres
 * advisory lock keeps two replicas from running the same tick together.
 */
async function bootstrap(): Promise<void> {
  const logger = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'gogo-worker',
    pretty: process.env.NODE_ENV === 'development',
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const { db, pool } = createDb(databaseUrl);
  // The container id under compose, the machine name elsewhere. Stable for the
  // life of the process, which is what makes one row per process work.
  const WORKER_ID = process.env.HOSTNAME || os.hostname();
  const STARTED_AT = new Date();
  const metrics = new LogMetrics(logger);
  // Real push provider lands with credentials (GoGo-BE#60); fake logs sends.
  const push = new FakePush();
  const dispatcher = new OutboxDispatcher(db, push, metrics);
  // BE-CMS-G4e (#226): campaigns are sent here, never from a request. Same
  // tick as the outbox rather than a schedule of their own.
  const campaigns = new CampaignDispatcher(db, push, metrics);
  const privacy = new PrivacyJobs(db);

  // PI-BE-015: bulk import chunks run here, not in the API process. The tick
  // polls for jobs an admin has started rather than consuming an enqueue, so a
  // start survives an API restart and no message can strand a job.
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
  const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY || mapsKey;
  // PI-BE-021: the worker runs the import chunks, so a missing Sheets key
  // strands jobs here as surely as it rejects them in the API. Same warning,
  // because this process makes the same choice from its own copy of the env.
  warnFakedProviders(
    {
      GOOGLE_MAPS_API_KEY: mapsKey,
      GOOGLE_SHEETS_API_KEY: process.env.GOOGLE_SHEETS_API_KEY ?? '',
    },
    (meta, message) => logger.warn(meta, message),
  );
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

  const periodic = startPeriodic(
    [
      {
        name: 'gogo:worker:outbox',
        schedule: { everyMs: OUTBOX_POLL_MS },
        run: async () => {
          const handled = await dispatcher.dispatchBatch(100);
          if (handled > 0) logger.info({ handled }, 'outbox batch dispatched');
          const sent = await campaigns.tick();
          if (sent.campaigns > 0 || sent.testSends > 0) logger.info(sent, 'campaigns dispatched');
          await heartbeat(process.env.HEARTBEAT_URL_OUTBOX);
        },
      },
      {
        name: 'gogo:worker:ingest',
        schedule: { everyMs: INGEST_POLL_MS },
        // Serial by design: chunks already batch 50 rows and each row may cost
        // a provider call, so parallel ticks would only race the quota.
        run: async () => {
          const advanced = await imports.processPendingJobs(5);
          if (advanced.length > 0) logger.info({ advanced }, 'place import chunks processed');
          await heartbeat(process.env.HEARTBEAT_URL_INGEST);
        },
      },
      {
        name: 'gogo:worker:privacy',
        // Every six hours rather than nightly at 03:00. The sweep is due-work
        // — `delete … where day < current_date - 90` — so each run touches
        // only what crossed the line since the last one, and a restart delays
        // it by at most six hours instead of skipping a day.
        schedule: { everyMs: PRIVACY_INTERVAL_MS },
        run: async () => {
          const report = await privacy.run(false);
          logger.info({ report }, 'privacy retention run complete');
          // #255 — a lapsed review date is a person's job, not the job's. It is
          // never auto-released or auto-deleted; it is made loud.
          if (report.privacyHoldReviewsOverdue > 0) {
            logger.warn(
              { count: report.privacyHoldReviewsOverdue },
              'privacy retention holds past review date — HOLD_REVIEW_OVERDUE',
            );
          }
          await heartbeat(process.env.HEARTBEAT_URL_PRIVACY, 0);
        },
      },
      {
        name: 'gogo:worker:heartbeat',
        schedule: { everyMs: HEARTBEAT_INTERVAL_MS },
        run: async () => {
          await pool.query(
            `insert into worker_heartbeats (worker_id, started_at, last_seen_at)
             values ($1, $2, now())
             on conflict (worker_id) do update set last_seen_at = now()`,
            [WORKER_ID, STARTED_AT],
          );
        },
      },
    ],
    { lock: new AdvisoryLock(pool), logger },
  );

  logger.info(
    { outboxPollMs: OUTBOX_POLL_MS, ingestPollMs: INGEST_POLL_MS },
    'worker booted: privacy sweep every 6h',
  );

  const shutdown = async () => {
    logger.info('worker shutting down');
    await periodic.stop();
    await pool.end();
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
