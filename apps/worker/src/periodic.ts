/**
 * Runs a few functions on a schedule, in this process, with nothing between
 * the timer and the work.
 *
 * This replaced three BullMQ queues, three job schedulers and three blocking
 * consumers that existed to do the same thing. Nothing ever enqueued a job —
 * the workers ignored the payload and polled Postgres, which already held the
 * work. BullMQ was a distributed timer paid for in Redis commands: measured on
 * DEV, ~100,000 a day with nothing to do, on a tier billed per command.
 *
 * What BullMQ actually provided here was single-flight per job. That is kept:
 * a tick never overlaps itself in this process (the next one is scheduled from
 * the end of the last), and a Postgres advisory lock keeps two worker replicas
 * from running the same job at once. The lock lives in Postgres because the
 * work does — a database that cannot hand out a lock cannot serve the tick
 * either, and there is no second system to keep alive.
 */
export interface PeriodicJob {
  /** Names the log line and the advisory lock. */
  name: string;
  run: () => Promise<void>;
  schedule: { everyMs: number } | DailySchedule;
}

/** Once a day at a wall-clock time in a zone, however long the process has been up. */
export interface DailySchedule {
  dailyAt: { hour: number; minute?: number; timeZone: string };
}

/** Returns a release function when the lock was taken, null when someone else holds it. */
export interface JobLock {
  tryAcquire(name: string): Promise<(() => Promise<void>) | null>;
}

export interface PeriodicLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PeriodicOptions {
  lock: JobLock;
  logger: PeriodicLogger;
  /** Injected for tests; every timestamp decision goes through this. */
  now?: () => number;
}

export interface PeriodicHandle {
  /** Stops scheduling, waits for any tick already running, then resolves. */
  stop(): Promise<void>;
}

/** How often a daily job checks whether its minute has arrived. */
const DAILY_CHECK_MS = 60_000;

export function startPeriodic(jobs: PeriodicJob[], options: PeriodicOptions): PeriodicHandle {
  const now = options.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Map<string, Promise<void>>();
  const lastDailyRun = new Map<string, string>();
  let stopping = false;

  const delayFor = (job: PeriodicJob): number =>
    'everyMs' in job.schedule ? job.schedule.everyMs : DAILY_CHECK_MS;

  /**
   * A daily job runs on the first check inside its target minute on a local
   * date it has not yet run on. A restart that lands in that minute runs it
   * again — every daily job here is re-runnable SQL, so that is cheap; a
   * restart straddling the minute skips the day, which is the trade for
   * keeping no state outside the process.
   */
  const dueNow = (job: PeriodicJob): boolean => {
    if ('everyMs' in job.schedule) return true;
    const { hour, minute = 0, timeZone } = job.schedule.dailyAt;
    const local = localClock(now(), timeZone);
    if (local.hour !== hour || local.minute !== minute) return false;
    if (lastDailyRun.get(job.name) === local.date) return false;
    lastDailyRun.set(job.name, local.date);
    return true;
  };

  const schedule = (job: PeriodicJob, delayMs: number) => {
    if (stopping) return;
    timers.set(
      job.name,
      setTimeout(() => void tick(job), delayMs),
    );
  };

  const tick = async (job: PeriodicJob) => {
    timers.delete(job.name);
    if (stopping || inFlight.has(job.name)) return;

    const work = (async () => {
      if (!dueNow(job)) return;
      const release = await options.lock.tryAcquire(job.name).catch((err: unknown) => {
        options.logger.error({ err, job: job.name }, 'periodic job could not reach the lock');
        return undefined;
      });
      if (!release) return; // another replica has it this tick, or the lock was unreachable
      try {
        await job.run();
      } catch (err) {
        options.logger.error({ err, job: job.name }, 'periodic job failed');
      } finally {
        await release().catch((err) =>
          options.logger.warn({ err, job: job.name }, 'periodic job lock release failed'),
        );
      }
    })();

    inFlight.set(job.name, work);
    try {
      await work;
    } finally {
      inFlight.delete(job.name);
      // From the end of this tick, never from a timer that fires regardless:
      // a tick that overruns its interval must not stack behind itself.
      schedule(job, delayFor(job));
    }
  };

  for (const job of jobs) schedule(job, delayFor(job));

  return {
    async stop() {
      stopping = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}

/** Date, hour and minute of an instant as seen in a time zone. */
export function localClock(
  epochMs: number,
  timeZone: string,
): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // "24" is how some ICU builds spell midnight with hour12: false.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/**
 * Session-level advisory lock. Held on one pooled connection for the duration
 * of the job and released on that same connection — advisory locks belong to
 * the session that took them, so the client cannot go back to the pool in
 * between.
 */
/** Structural slice of a pg Pool, so the worker does not depend on pg directly. */
export interface LockPool {
  connect(): Promise<{
    query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
    release(): void;
  }>;
}

export class AdvisoryLock implements JobLock {
  constructor(private readonly pool: LockPool) {}

  async tryAcquire(name: string): Promise<(() => Promise<void>) | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        'select pg_try_advisory_lock(hashtext($1)) as ok',
        [name],
      );
      if (!rows[0]?.ok) {
        client.release();
        return null;
      }
    } catch (err) {
      client.release();
      throw err;
    }
    return async () => {
      try {
        await client.query('select pg_advisory_unlock(hashtext($1))', [name]);
      } finally {
        client.release();
      }
    };
  }
}
