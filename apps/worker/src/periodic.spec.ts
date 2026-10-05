import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPeriodic, type JobLock, type PeriodicLogger } from './periodic';

const logger: PeriodicLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * BE#539 — a lease, not a bare release function. `lose()` simulates the case
 * the advisory lock could not express: the lease going while the job runs.
 */
function lock(granted = true): JobLock & {
  acquired: number;
  released: number;
  lose: () => void;
} {
  let controller: AbortController | null = null;
  let held = true;
  const l = {
    acquired: 0,
    released: 0,
    lose: () => {
      held = false;
      controller?.abort();
    },
    async tryAcquire() {
      if (!granted) return null;
      l.acquired += 1;
      controller = new AbortController();
      held = true;
      return {
        signal: controller.signal,
        isHeld: () => held,
        release: async () => {
          l.released += 1;
        },
      };
    },
  };
  return l;
}

/**
 * #362 — keyed by `periodic_job`, never `job`: Prometheus renames an exported
 * `job` to `exported_job` on scrape, so a `job` label is a query that matches
 * nothing. Reading any other key here makes every count below come out empty.
 */
function recorder() {
  const counts: Record<string, number> = {};
  const durations: string[] = [];
  return {
    counts,
    durations,
    increment(name: string, labels?: Record<string, string | number | undefined>) {
      const key = `${name}{${labels?.periodic_job as string},${labels?.result as string}}`;
      counts[key] = (counts[key] ?? 0) + 1;
    },
    observe(name: string, _value: number, labels?: Record<string, string | number | undefined>) {
      durations.push(`${name}{${labels?.periodic_job as string}}`);
    },
  };
}

describe('startPeriodic', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs an interval job every interval, taking and releasing the lock each time', async () => {
    const l = lock();
    const runs: number[] = [];
    const handle = startPeriodic(
      [{ name: 'a', schedule: { everyMs: 1_000 }, run: async () => void runs.push(Date.now()) }],
      { lock: l, logger },
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runs).toHaveLength(3);
    expect(l.acquired).toBe(3);
    expect(l.released).toBe(3);
    await handle.stop();
  });

  it('skips the tick when another replica holds the lock', async () => {
    const runs: number[] = [];
    const handle = startPeriodic(
      [{ name: 'a', schedule: { everyMs: 1_000 }, run: async () => void runs.push(1) }],
      { lock: lock(false), logger },
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runs).toHaveLength(0);
    await handle.stop();
  });

  it('never overlaps a slow tick with the next one', async () => {
    let finish: (() => void) | undefined;
    let started = 0;
    const handle = startPeriodic(
      [
        {
          name: 'slow',
          schedule: { everyMs: 1_000 },
          run: () =>
            new Promise<void>((resolve) => {
              started += 1;
              finish = resolve;
            }),
        },
      ],
      { lock: lock(), logger },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toBe(1); // still running; no second start

    finish?.();
    await vi.advanceTimersByTimeAsync(1_000); // next tick is one interval after the END
    expect(started).toBe(2);
    finish?.();
    await handle.stop();
  });

  it('a failing run releases the lock and the schedule continues', async () => {
    const l = lock();
    let calls = 0;
    const handle = startPeriodic(
      [
        {
          name: 'flaky',
          schedule: { everyMs: 1_000 },
          run: async () => {
            calls += 1;
            if (calls === 1) throw new Error('boom');
          },
        },
      ],
      { lock: l, logger },
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(2);
    expect(l.released).toBe(2);
    await handle.stop();
  });

  it('stop waits for the tick in flight and schedules nothing after', async () => {
    let finish: (() => void) | undefined;
    let started = 0;
    const handle = startPeriodic(
      [
        {
          name: 'a',
          schedule: { everyMs: 1_000 },
          run: () =>
            new Promise<void>((resolve) => {
              started += 1;
              finish = resolve;
            }),
        },
      ],
      { lock: lock(), logger },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); // still waiting on the run
    finish?.();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toBe(1);
  });

  it('reports each tick — a scheduled job that stops ticking is otherwise silent (#340)', async () => {
    const metrics = recorder();
    const handle = startPeriodic(
      [{ name: 'refresh', schedule: { everyMs: 1_000 }, run: async () => undefined }],
      { lock: lock(), logger, metrics },
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(metrics.counts['worker_periodic_runs_total{refresh,ok}']).toBe(2);
    expect(metrics.durations).toEqual([
      'worker_periodic_duration_seconds{refresh}',
      'worker_periodic_duration_seconds{refresh}',
    ]);
    await handle.stop();
  });

  it('hands the job a signal that aborts when the lease is lost (BE#539)', async () => {
    const l = lock();
    let sawAbort = false;
    const handle = startPeriodic(
      [
        {
          name: 'j',
          schedule: { everyMs: 1000 },
          run: async (ctx) => {
            l.lose();
            // A job that touches shared work checks between units; this is the
            // check the advisory lock could never offer, because a leaked lock
            // looked identical to a held one.
            sawAbort = ctx.signal.aborted;
          },
        },
      ],
      { lock: l, logger },
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(sawAbort).toBe(true);
    await handle.stop();
  });

  it('does not report success for a tick that lost its lease while running', async () => {
    // Finishing is not the same as having been entitled to finish: another
    // replica has been running it too, and `ok` would hide that.
    const l = lock();
    const metrics = recorder();
    const handle = startPeriodic(
      [{ name: 'j', schedule: { everyMs: 1000 }, run: async () => l.lose() }],
      { lock: l, logger, metrics },
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(metrics.counts['worker_periodic_runs_total{j,lease_lost}']).toBe(1);
    expect(metrics.counts['worker_periodic_runs_total{j,ok}']).toBeUndefined();
    await handle.stop();
  });

  it('counts a run that threw after losing its lease as lease_lost, not failed', async () => {
    const l = lock();
    const metrics = recorder();
    const handle = startPeriodic(
      [
        {
          name: 'j',
          schedule: { everyMs: 1000 },
          run: async () => {
            l.lose();
            throw new Error('aborted');
          },
        },
      ],
      { lock: l, logger, metrics },
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(metrics.counts['worker_periodic_runs_total{j,lease_lost}']).toBe(1);
    expect(metrics.counts['worker_periodic_runs_total{j,failed}']).toBeUndefined();
    await handle.stop();
  });

  it('tells a failed tick apart from one another replica took', async () => {
    const failing = recorder();
    const failed = startPeriodic(
      [
        {
          name: 'refresh',
          schedule: { everyMs: 1_000 },
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
      { lock: lock(), logger, metrics: failing },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failing.counts['worker_periodic_runs_total{refresh,failed}']).toBe(1);
    // The duration is still observed: a tick that failed slowly is the one
    // worth seeing.
    expect(failing.durations).toHaveLength(1);
    await failed.stop();

    const skipping = recorder();
    const skipped = startPeriodic(
      [{ name: 'refresh', schedule: { everyMs: 1_000 }, run: async () => undefined }],
      { lock: lock(false), logger, metrics: skipping },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(skipping.counts['worker_periodic_runs_total{refresh,lock_skipped}']).toBe(1);
    expect(skipping.durations).toHaveLength(0);
    await skipped.stop();
  });
});

/**
 * BE#675 — a failing job reaches the error reporter once per failure streak.
 *
 * A tick has no retry of its own: each one is the last attempt at that work,
 * and the next tick is a fresh run. Reporting every failed tick would spend the
 * Sentry quota on one broken job polling every few seconds, so the runner
 * reports the transition into failing and stays quiet until the job succeeds.
 */
describe('startPeriodic error reporting (BE#675)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function reporter() {
    const captured: { err: unknown; job: string }[] = [];
    return { captured, capture: (err: unknown, job: string) => void captured.push({ err, job }) };
  }

  it('reports a job that keeps failing once, then again after it recovered and failed anew', async () => {
    const errors = reporter();
    const outcomes = ['fail', 'fail', 'fail', 'ok', 'fail', 'fail'];
    let tick = 0;
    const handle = startPeriodic(
      [
        {
          name: 'outbox',
          schedule: { everyMs: 1_000 },
          run: async () => {
            const outcome = outcomes[tick];
            tick += 1;
            if (outcome === 'fail') throw new Error(`boom ${tick}`);
          },
        },
      ],
      { lock: lock(), logger, errors },
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(errors.captured).toHaveLength(1);
    expect(errors.captured[0]).toEqual({ err: new Error('boom 1'), job: 'outbox' });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(tick).toBe(6);
    expect(errors.captured).toHaveLength(2);
    expect(errors.captured[1]).toEqual({ err: new Error('boom 5'), job: 'outbox' });
    await handle.stop();
  });

  it('keeps a streak per job', async () => {
    const errors = reporter();
    const handle = startPeriodic(
      ['a', 'b'].map((name) => ({
        name,
        schedule: { everyMs: 1_000 },
        run: async () => {
          throw new Error(name);
        },
      })),
      { lock: lock(), logger, errors },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(errors.captured.map((c) => c.job).sort()).toEqual(['a', 'b']);
    await handle.stop();
  });

  it('does not report a run that threw after losing its lease', async () => {
    const errors = reporter();
    const l = lock();
    const handle = startPeriodic(
      [
        {
          name: 'j',
          schedule: { everyMs: 1_000 },
          run: async () => {
            l.lose();
            throw new Error('aborted');
          },
        },
      ],
      { lock: l, logger, errors },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(errors.captured).toHaveLength(0);
    await handle.stop();
  });

  it('reports an unreachable lock once per streak, and not a lock another replica holds', async () => {
    const errors = reporter();
    const unreachable: JobLock = {
      tryAcquire: () => Promise.reject(new Error('connection refused')),
    };
    const down = startPeriodic(
      [{ name: 'j', schedule: { everyMs: 1_000 }, run: async () => undefined }],
      { lock: unreachable, logger, errors },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(errors.captured).toEqual([{ err: new Error('connection refused'), job: 'j' }]);
    await down.stop();

    const busy = reporter();
    const held = startPeriodic(
      [{ name: 'j', schedule: { everyMs: 1_000 }, run: async () => undefined }],
      { lock: lock(false), logger, errors: busy },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(busy.captured).toHaveLength(0);
    await held.stop();
  });

  it('a reporter that throws does not stop the schedule', async () => {
    let runs = 0;
    const handle = startPeriodic(
      [
        {
          name: 'j',
          schedule: { everyMs: 1_000 },
          run: async () => {
            runs += 1;
            throw new Error('boom');
          },
        },
      ],
      {
        lock: lock(),
        logger,
        errors: {
          capture: () => {
            throw new Error('reporter down');
          },
        },
      },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runs).toBe(3);
    await handle.stop();
  });
});
