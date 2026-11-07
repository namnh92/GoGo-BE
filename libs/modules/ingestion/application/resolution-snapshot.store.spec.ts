import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResolutionSnapshotStore } from './resolution-snapshot.store';
import { MetricsRegistry } from '@gogo/observability';

afterEach(() => vi.useRealTimers());

function record() {
  const verifiedAt = new Date().toISOString();
  return {
    googlePlaceId: 'resolved-place',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    snapshot: {
      source: 'google_places' as const,
      fetchedAt: verifiedAt,
      name: 'Resolved café',
      addressShort: 'Hà Nội',
      googleMapsUri: null,
      googleRating: 4.5,
      googleRatingCount: 500,
      openingHours: [],
      attributions: ['Google Maps'],
      photo: 'private photo',
      raw: 'private payload',
    },
  };
}

describe('#801 resolution snapshot lifetime and binding', () => {
  it('retains only allowlisted facts and expires exactly with the token, including untouched records', async () => {
    vi.useFakeTimers();
    const store = new ResolutionSnapshotStore(null);
    const data = record();
    const id = randomUUID();
    const expected = { ...data, verifiedAt: data.snapshot.fetchedAt };
    await store.put(id, data);
    const snapshot = await store.get(id, expected);
    expect(snapshot).toMatchObject({
      name: data.snapshot.name,
      fetchedAt: data.snapshot.fetchedAt,
    });
    expect(snapshot).not.toHaveProperty('photo');
    expect(snapshot).not.toHaveProperty('raw');
    await vi.advanceTimersByTimeAsync(599_999);
    expect(await store.get(id, expected)).toEqual(snapshot);
    await vi.advanceTimersByTimeAsync(1);
    expect(await store.get(id, expected)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    store.onModuleDestroy();
  });

  it('shares records across instances with an absolute Redis expiry and never consumes them on retry', async () => {
    const records = new Map<string, string>();
    const redis = {
      eval: vi.fn(
        async (_script: string, _keys: number, key: string | number, value?: string | number) => {
          if (typeof value === 'string') {
            records.set(String(key), value);
            return 'OK';
          }
          return records.get(String(key)) ?? null;
        },
      ),
    };
    const writer = new ResolutionSnapshotStore(redis);
    const reader = new ResolutionSnapshotStore(redis);
    const data = record();
    const id = randomUUID();
    await writer.put(id, data);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("'PXAT'"),
      1,
      `place-resolution:${id}`,
      expect.any(String),
      Date.parse(data.expiresAt),
    );
    const expected = { ...data, verifiedAt: data.snapshot.fetchedAt };
    const snapshot = await reader.get(id, expected);
    expect(snapshot).toMatchObject({ name: data.snapshot.name });
    expect(await reader.get(id, expected)).toEqual(snapshot);
    expect(await reader.get(id, { ...expected, googlePlaceId: 'another-place' })).toBeUndefined();
    expect(
      await reader.get(id, { ...expected, verifiedAt: '2020-01-01T00:00:00.000Z' }),
    ).toBeUndefined();
    expect(
      await reader.get(id, { ...expected, expiresAt: '2100-01-01T00:00:00.000Z' }),
    ).toBeUndefined();
    // Even if Redis returns an expired/restored key, application time still gates it.
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(data.expiresAt));
    expect(await reader.get(id, expected)).toBeUndefined();
  });

  it('keeps two resolutions of the same place independent', async () => {
    const store = new ResolutionSnapshotStore(null);
    const first = record();
    const second = { ...first, snapshot: { ...first.snapshot, name: 'New name' } };
    const firstId = randomUUID();
    const secondId = randomUUID();
    await store.put(firstId, first);
    await store.put(secondId, second);
    const expected = { ...first, verifiedAt: first.snapshot.fetchedAt };
    expect((await store.get(firstId, expected))?.name).toBe('Resolved café');
    expect((await store.get(secondId, expected))?.name).toBe('New name');
    store.onModuleDestroy();
  });

  it('does not fall back to process memory after a Redis failure', async () => {
    const store = new ResolutionSnapshotStore({
      eval: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const data = record();
    await expect(store.put(randomUUID(), data)).rejects.toThrow('offline');
    await expect(
      store.get(randomUUID(), { ...data, verifiedAt: data.snapshot.fetchedAt }),
    ).rejects.toThrow('offline');
  });

  it('meters successful writes and failed reads without snapshot contents in labels', async () => {
    const metrics = new MetricsRegistry();
    const redis = {
      eval: vi.fn().mockResolvedValueOnce('OK').mockRejectedValueOnce(new Error('offline')),
    };
    const store = new ResolutionSnapshotStore(redis, metrics);
    const data = record();
    const id = randomUUID();
    await store.put(id, data);
    await expect(store.get(id, { ...data, verifiedAt: data.snapshot.fetchedAt })).rejects.toThrow(
      'offline',
    );
    expect(metrics.render()).toContain(
      'provider_requests_total{operation="upstash.redis.place_resolution.put",provider="upstash",service="upstash.redis",status="ok"} 1',
    );
    expect(metrics.render()).toContain(
      'provider_requests_total{operation="upstash.redis.place_resolution.get",provider="upstash",service="upstash.redis",status="error"} 1',
    );
    expect(metrics.render()).not.toContain(id);
    expect(metrics.render()).not.toContain(data.snapshot.name);
  });
});
