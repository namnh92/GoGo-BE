import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localClock, startPeriodic, type JobLock, type PeriodicLogger } from './periodic';

const logger: PeriodicLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

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

  it('a daily job runs once on its minute in its zone, and again the next day', async () => {
    // 2026-08-31T02:59:30 in Asia/Ho_Chi_Minh (UTC+7) = 2026-08-30T19:59:30Z
    let clock = Date.UTC(2026, 7, 30, 19, 59, 30);
    const runs: string[] = [];
    const handle = startPeriodic(
      [
        {
          name: 'daily',
          schedule: { dailyAt: { hour: 3, timeZone: 'Asia/Ho_Chi_Minh' } },
          run: async () => void runs.push(localClock(clock, 'Asia/Ho_Chi_Minh').date),
        },
      ],
      { lock: lock(), logger, now: () => clock },
    );

    const step = async (ms: number) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };

    await step(60_000); // 03:00:30 — due
    expect(runs).toEqual(['2026-08-31']);
    await step(60_000); // 03:01:30 — not the minute
    await step(60_000 * 60); // 04:01:30 — not the minute
    expect(runs).toEqual(['2026-08-31']);
    await step(60_000 * 60 * 23); // 03:01:30 next day — minute passed, check lands at :01
    // The check lands a minute late because the fake clock stepped by an hour;
    // walk back to the exact minute to model a real minute-by-minute checker.
    clock -= 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(['2026-08-31', '2026-09-01']);
    await handle.stop();
  });
});

describe('localClock', () => {
  it('reads the wall clock of a zone', () => {
    expect(localClock(Date.UTC(2026, 7, 30, 20, 0, 0), 'Asia/Ho_Chi_Minh')).toEqual({
      date: '2026-08-31',
      hour: 3,
      minute: 0,
    });
  });
});
