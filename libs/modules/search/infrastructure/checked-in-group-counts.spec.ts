import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import { SearchRepository } from './search.repository';
import { CheckedInGroupCounts } from './checked-in-group-counts';

function setup(count: unknown = 5) {
  const execute = vi.fn().mockResolvedValue({ rows: [{ group_count: count }] });
  const increment = vi.fn();
  const cache = new CheckedInGroupCounts(
    { execute } as unknown as Db,
    { increment } as unknown as MetricsPort,
  );
  return { cache, execute, increment };
}

afterEach(() => vi.useRealTimers());

describe('checked-in group count reads (#785)', () => {
  it('F-01: suppresses 5→4 immediately in every repository instance before TTL expiry', async () => {
    vi.useFakeTimers();
    const { cache, execute, increment } = setup(5);
    const otherProcess = new CheckedInGroupCounts(
      { execute } as unknown as Db,
      { increment } as unknown as MetricsPort,
    );
    expect(await cache.get('place')).toBe(5);
    expect(await otherProcess.get('place')).toBe(5);

    // A deletion/cascade/merge commits through another connection; time has not advanced.
    execute.mockResolvedValue({ rows: [{ group_count: 4 }] });
    expect(await cache.get('place')).toBeNull();
    expect(await otherProcess.get('place')).toBeNull();
  });

  it('F-01: a request after deletion cannot join an older in-flight fill', async () => {
    vi.useFakeTimers();
    const { cache, execute } = setup(5);
    let resolve!: (value: unknown) => void;
    execute.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const beforeCommit = cache.get('place');

    execute.mockResolvedValue({ rows: [{ group_count: 4 }] });
    const afterCommit = cache.get('place');
    resolve({ rows: [{ group_count: 5 }] });
    await beforeCommit;
    expect(await afterCommit).toBeNull();
  });

  it('F-01: a fill finishing after deletion cannot retain its pre-deletion snapshot', async () => {
    vi.useFakeTimers();
    const { cache, execute } = setup(5);
    let resolve!: (value: unknown) => void;
    execute.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const beforeCommit = cache.get('place');

    execute.mockResolvedValue({ rows: [{ group_count: 4 }] });
    resolve({ rows: [{ group_count: 5 }] });
    await beforeCommit;
    expect(await cache.get('place')).toBeNull();
  });

  it('reads both detail facts and the count aggregate on each request', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'place', gogo_rating_count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ group_count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'place', gogo_rating_count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ group_count: 4 }] });
    const repo = new SearchRepository({ execute } as unknown as Db);
    expect(await repo.placeDetail('place')).toMatchObject({
      gogo_rating_count: 4,
      checked_in_group_count: 5,
    });
    expect(await repo.placeDetail('place')).toMatchObject({
      gogo_rating_count: 3,
      checked_in_group_count: null,
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('does not read a count for a place that is no longer public', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'place' }] })
      .mockResolvedValueOnce({ rows: [{ group_count: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    const repo = new SearchRepository({ execute } as unknown as Db);
    expect(await repo.placeDetail('place')).toMatchObject({ checked_in_group_count: 5 });
    expect(await repo.placeDetail('place')).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1, 4, 5, 8])('suppresses populations below five: %i', async (n) => {
    const { cache, execute } = setup(n);
    expect(await cache.get('place')).toBe(n < 5 ? null : n);
    expect(await cache.get('place')).toBe(n < 5 ? null : n);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reads concurrently requested places independently', async () => {
    const { cache, execute } = setup();
    await Promise.all([cache.get('a'), cache.get('a'), cache.get('b')]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('reflects both suppressed and public populations without waiting for a TTL', async () => {
    vi.useFakeTimers();
    const { cache, execute } = setup(4);
    expect(await cache.get('a')).toBeNull();
    execute.mockResolvedValue({ rows: [{ group_count: 5 }] });
    expect(await cache.get('a')).toBe(5);
    execute.mockResolvedValue({ rows: [{ group_count: 4 }] });
    expect(await cache.get('a')).toBeNull();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('propagates errors to concurrent callers and retries on the next request', async () => {
    const { cache, execute, increment } = setup();
    execute.mockRejectedValueOnce(new Error('database unavailable'));
    execute.mockRejectedValueOnce(new Error('database unavailable'));
    const results = await Promise.allSettled([cache.get('a'), cache.get('a')]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await cache.get('a')).toBe(5);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(increment).toHaveBeenCalledWith('place_checkin_group_count_total', { outcome: 'error' });
  });

  it.each([undefined, null, '5', -1, 1.5, NaN])('rejects malformed aggregates: %s', async (n) => {
    const { cache, execute } = setup(n);
    if (n === undefined) execute.mockResolvedValue({ rows: [] });
    await expect(cache.get('a')).rejects.toThrow('Invalid checked-in group aggregate');
  });

  it('emits only bounded outcomes, without place, room, member or raw count labels', async () => {
    const { cache, increment } = setup(4);
    await cache.get('private-place');
    await cache.get('private-place');
    expect(increment.mock.calls).toEqual([
      ['place_checkin_group_count_total', { outcome: 'suppressed' }],
      ['place_checkin_group_count_total', { outcome: 'suppressed' }],
    ]);
  });
});
