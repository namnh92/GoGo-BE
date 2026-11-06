import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import { SearchRepository } from './search.repository';
import {
  CheckedInGroupCounts,
  CHECKED_IN_GROUP_COUNT_CACHE_SIZE,
  CHECKED_IN_GROUP_COUNT_TTL_MS,
} from './checked-in-group-counts';

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

describe('checked-in group count cache (#785)', () => {
  it('keeps detail facts fresh while reusing only the count aggregate', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'place', gogo_rating_count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ group_count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'place', gogo_rating_count: 3 }] });
    const repo = new SearchRepository({ execute } as unknown as Db);
    expect(await repo.placeDetail('place')).toMatchObject({
      gogo_rating_count: 4,
      checked_in_group_count: 5,
    });
    expect(await repo.placeDetail('place')).toMatchObject({
      gogo_rating_count: 3,
      checked_in_group_count: 5,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('does not fill or return a cached count for a place that is no longer public', async () => {
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
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent reads and isolates places', async () => {
    const { cache, execute } = setup();
    await Promise.all([cache.get('a'), cache.get('a'), cache.get('b')]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('refreshes both public and suppressed values at 60 seconds, including a deletion', async () => {
    vi.useFakeTimers();
    const { cache, execute } = setup(4);
    expect(await cache.get('a')).toBeNull();
    execute.mockResolvedValue({ rows: [{ group_count: 5 }] });
    vi.advanceTimersByTime(CHECKED_IN_GROUP_COUNT_TTL_MS - 1);
    expect(await cache.get('a')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await cache.get('a')).toBe(5);
    execute.mockResolvedValue({ rows: [{ group_count: 4 }] });
    vi.advanceTimersByTime(CHECKED_IN_GROUP_COUNT_TTL_MS);
    expect(await cache.get('a')).toBeNull();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('does not extend the freshness window by query duration', async () => {
    vi.useFakeTimers();
    const { cache, execute } = setup();
    let resolve!: (value: unknown) => void;
    execute.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const pending = cache.get('a');
    vi.advanceTimersByTime(CHECKED_IN_GROUP_COUNT_TTL_MS);
    resolve({ rows: [{ group_count: 5 }] });
    await pending;
    await cache.get('a');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('bounds retained entries and evicts the oldest', async () => {
    const { cache, execute } = setup();
    for (let n = 0; n <= CHECKED_IN_GROUP_COUNT_CACHE_SIZE; n++) await cache.get(`${n}`);
    await cache.get('0');
    expect(execute).toHaveBeenCalledTimes(CHECKED_IN_GROUP_COUNT_CACHE_SIZE + 2);
  });

  it('propagates errors to concurrent callers and retries on the next request', async () => {
    const { cache, execute, increment } = setup();
    execute.mockRejectedValueOnce(new Error('database unavailable'));
    const results = await Promise.allSettled([cache.get('a'), cache.get('a')]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await cache.get('a')).toBe(5);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(increment).toHaveBeenCalledWith('place_checkin_group_cache_total', { outcome: 'error' });
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
      ['place_checkin_group_cache_total', { outcome: 'miss' }],
      ['place_checkin_group_count_total', { outcome: 'suppressed' }],
      ['place_checkin_group_cache_total', { outcome: 'hit' }],
    ]);
  });
});
