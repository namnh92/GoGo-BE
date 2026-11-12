import type { Db } from '@gogo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeQaRead, placeQaTransaction, safePlaceQaReadError } from './place-qa-read';

const fake = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: () => ({ execute: fake.execute }) }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe('S2 bounded read lifetime', () => {
  it('sanitizes database errors rather than exposing SQL, raw names or parameters', () => {
    const error = safePlaceQaReadError({
      message: 'select raw-private-name',
      cause: { code: '22012' },
      params: ['secret span'],
    });
    expect(error.reason).toBe('read_error');
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.message).not.toContain('raw-private-name');
    expect(safePlaceQaReadError({ cause: { code: '57014' } }).reason).toBe('timeout');
  });
  beforeEach(() => {
    fake.execute.mockReset().mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const fixture = () => {
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ release });
    return { db: { $client: { connect } } as unknown as Db, release, connect };
  };
  it('pre-cancel and an exhausted turn deadline never acquire a connection', async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      placeQaRead(f.db, 1000, { signal: controller.signal }, async () => 1),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(
      placeQaRead(f.db, 1000, { deadlineAt: Date.now() - 1 }, async () => 1),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('releases once on success and rolls back on read failure, never maps error to absent', async () => {
    const f = fixture();
    expect(await placeQaRead(f.db, 1000, {}, async () => 'result')).toBe('result');
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    const failed = fixture();
    const error = new Error('read failed');
    await expect(
      placeQaRead(failed.db, 1000, {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(failed.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('deadline includes pool wait and destroys a connection that arrives after timeout', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      queued = deferred<{ release: typeof f.release }>();
    f.connect.mockReturnValue(queued.promise);
    const pending = placeQaRead(f.db, 1000, { deadlineAt: Date.now() + 10 }, async () => 1);
    const assertion = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    queued.resolve({ release: f.release });
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(fake.execute).not.toHaveBeenCalled();
  });
  it('mid-query abort destroys rather than reuses an active transaction', async () => {
    const f = fixture(),
      controller = new AbortController(),
      entered = deferred<void>(),
      gate = deferred<void>();
    const pending = placeQaRead(f.db, 1000, { signal: controller.signal }, async () => {
      entered.resolve();
      await gate.promise;
      return 1;
    });
    const assertion = expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    await entered.promise;
    controller.abort();
    await assertion;
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    gate.resolve();
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});

describe('Astra A5: bounded settlement transaction', () => {
  afterEach(() => vi.useRealTimers());
  it('destroys a connection acquired after the settlement pool deadline', async () => {
    vi.useFakeTimers();
    fake.execute.mockClear();
    const release = vi.fn();
    const queued = deferred<{ release: typeof release }>();
    const db = { $client: { connect: () => queued.promise } } as unknown as Db;
    const work = vi.fn(async () => true);
    const pending = placeQaTransaction(db, 1500, {}, work);
    const assertion = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    queued.resolve({ release });
    await Promise.resolve();
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(work).not.toHaveBeenCalled();
  });
  it('cancels a stalled write, never commits it after cancellation', async () => {
    fake.execute.mockReset().mockResolvedValue({ rows: [] });
    const release = vi.fn(),
      entered = deferred<void>(),
      finish = deferred<void>();
    const db = { $client: { connect: async () => ({ release }) } } as unknown as Db;
    const controller = new AbortController();
    const pending = placeQaTransaction(db, 1500, { signal: controller.signal }, async () => {
      entered.resolve();
      await finish.promise;
      return true;
    });
    const assertion = expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    await entered.promise;
    const statements = fake.execute.mock.calls.length;
    controller.abort();
    await assertion;
    finish.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(fake.execute.mock.calls.length).toBe(statements);
  });
});
