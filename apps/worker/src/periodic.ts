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
 *
 * Every job is an interval, none is a wall-clock time. A "daily at 03:00"
 * schedule existed briefly and was removed: the jobs here are due-work — each
 * tick processes whatever is due and nothing if nothing is — so running the
 * privacy sweep every few hours is the same work as running it nightly, and a
 * restart can delay it by at most one interval instead of skipping a day.
 */
/**
 * What a job is handed. Existing jobs written as `async () => {}` still
 * satisfy this — a function may ignore arguments — so opting in is per job.
 */
export interface JobContext {
  /**
   * BE#539 — aborts when this tick's lease is lost. A job that touches
   * anything another replica would also touch should check it between units of
   * work; a job that finishes in one statement can ignore it.
   */
  signal: AbortSignal;
}

export interface PeriodicJob {
  /** Names the log line and the lease row. */
  name: string;
  run: (ctx: JobContext) => Promise<void>;
  schedule: { everyMs: number };
}

/**
 * BE#539 — a held lease, not a bare release function.
 *
 * The release function alone could not express the case that actually bit us:
 * a lease that is gone *while the job is still running*. Carrying the signal
 * lets the runner refuse to report success for work it no longer owned, and
 * lets a job stop before doing something a second holder is already doing.
 */
export interface HeldJobLease {
  readonly signal: AbortSignal;
  isHeld(): boolean;
  release(): Promise<void>;
}

/** Returns a held lease when taken, null when someone else holds it. */
export interface JobLock {
  tryAcquire(name: string): Promise<HeldJobLease | null>;
}

export interface PeriodicLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * #340 — what a tick reports about itself.
 *
 * Structural rather than `MetricsPort`, for the same reason the lock is: this
 * file describes a runner, and a runner that imports an observability package
 * to be testable is one more thing to stand up in a test that is about timers.
 */
export interface PeriodicMetrics {
  increment(name: string, labels?: Record<string, string | number | undefined>, by?: number): void;
  observe(name: string, value: number, labels?: Record<string, string | number | undefined>): void;
}

export interface PeriodicOptions {
  lock: JobLock;
  logger: PeriodicLogger;
  /**
   * Optional so existing callers and tests are unchanged, but production
   * passes one: without it the only evidence a scheduled job ran is a log
   * line, and "the refresh job stopped ticking" is not a question a log
   * search should have to answer (plan §2.5).
   */
  metrics?: PeriodicMetrics;
}

export interface PeriodicHandle {
  /** Stops scheduling, waits for any tick already running, then resolves. */
  stop(): Promise<void>;
}

export function startPeriodic(jobs: PeriodicJob[], options: PeriodicOptions): PeriodicHandle {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Map<string, Promise<void>>();
  let stopping = false;

  const delayFor = (job: PeriodicJob): number => job.schedule.everyMs;

  const schedule = (job: PeriodicJob, delayMs: number) => {
    if (stopping) return;
    timers.set(
      job.name,
      setTimeout(() => void tick(job), delayMs),
    );
  };

  const record = (job: PeriodicJob, result: 'ok' | 'failed' | 'lock_skipped' | 'lease_lost') => {
    options.metrics?.increment('worker_periodic_runs_total', { job: job.name, result });
  };

  const tick = async (job: PeriodicJob) => {
    timers.delete(job.name);
    if (stopping || inFlight.has(job.name)) return;

    const work = (async () => {
      const lease = await options.lock.tryAcquire(job.name).catch((err: unknown) => {
        options.logger.error({ err, job: job.name }, 'periodic job could not reach the lock');
        return undefined;
      });
      if (!lease) {
        // Another replica has it this tick, or the lock was unreachable. Both
        // are "this process did not run the job", and a rate that never leaves
        // zero on every replica is how a lock nobody can take looks.
        record(job, 'lock_skipped');
        return;
      }
      const startedAt = Date.now();
      try {
        await job.run({ signal: lease.signal });
        // BE#539: finishing is not the same as having been entitled to finish.
        // If the lease went while the job ran, another replica has been running
        // it too, and reporting `ok` would hide that.
        if (lease.isHeld()) record(job, 'ok');
        else {
          options.logger.warn(
            { job: job.name },
            'periodic job lost its lease while running — another replica may have run it too',
          );
          record(job, 'lease_lost');
        }
      } catch (err) {
        if (lease.isHeld()) {
          options.logger.error({ err, job: job.name }, 'periodic job failed');
          record(job, 'failed');
        } else {
          // An abort caused by losing the lease is the job doing as it was
          // told, not a fault.
          options.logger.warn({ job: job.name }, 'periodic job stopped after losing its lease');
          record(job, 'lease_lost');
        }
      } finally {
        options.metrics?.observe(
          'worker_periodic_duration_seconds',
          (Date.now() - startedAt) / 1000,
          { job: job.name },
        );
        await lease
          .release()
          .catch((err: unknown) =>
            options.logger.warn({ err, job: job.name }, 'periodic job lease release failed'),
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

/**
 * BE#539 — the lock is a row now, not a session.
 *
 * `AdvisoryLock` lived here and was wrong under PgBouncer: advisory locks
 * belong to a session, transaction pooling moves statements between sessions,
 * so the unlock missed and the lock leaked until someone terminated the backend
 * by hand. `WorkerLease` in `@gogo/database` owns the SQL; this is the thin
 * adapter that makes it a `JobLock`.
 */
export type { HeldLease } from '@gogo/database';
export { WorkerLease } from '@gogo/database';
