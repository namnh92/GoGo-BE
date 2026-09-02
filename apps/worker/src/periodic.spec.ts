import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPeriodic, type JobLock, type PeriodicLogger } from './periodic';

const logger: PeriodicLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function lock(granted = true): JobLock & { acquired: number; released: number } {
  const l = {
    acquired: 0,
    released: 0,
    async tryAcquire() {
      if (!granted) return null;
      l.acquired += 1;
      return async () => {
        l.released += 1;
      };
    },
  };
  return l;
}

function recorder() {
  const counts: Record<string, number> = {};
  const durations: string[] = [];
  return {
    counts,
    durations,
    increment(name: string, labels?: Record<string, string | number | undefined>) {
      const key = `${name}{${labels?.job as string},${labels?.result as string}}`;
      counts[key] = (counts[key] ?? 0) + 1;
    },
    observe(name: string, _value: number, labels?: Record<string, string | number | undefined>) {
      durations.push(`${name}{${labels?.job as string}}`);
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
