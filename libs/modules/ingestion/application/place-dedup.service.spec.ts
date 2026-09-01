import { describe, expect, it } from 'vitest';
import type { Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import type { MetricsPort } from '@gogo/observability';
import { PlaceDedupService } from './place-dedup.service';

/**
 * #334 — the resolver is the single answer to "which GoGo place is this Google
 * Place ID?". Before PR1 each path had its own, and they disagreed.
 */

type Row = { place_id: string };

/** Records which tables were asked, in order, and answers from a fixture. */
function fakeDb(rows: { canonical?: Row[]; legacy?: Row[] }) {
  const asked: ('canonical' | 'legacy')[] = [];
  const db = {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      const table = text.includes('place_provider_sources') ? 'canonical' : 'legacy';
      asked.push(table);
      return { rows: (table === 'canonical' ? rows.canonical : rows.legacy) ?? [] };
    },
  } as unknown as Db;
  return { db, asked };
}

function fakeMetrics() {
  const counters: { name: string; labels: Record<string, unknown> }[] = [];
  const metrics = {
    increment: (name: string, labels?: Record<string, unknown>) =>
      void counters.push({ name, labels: labels ?? {} }),
    observe: () => undefined,
    time: <T>(_n: string, _l: unknown, fn: () => Promise<T>) => fn(),
  } as unknown as MetricsPort;
  return { metrics, counters };
}

const details = (over: Partial<ResolvedProviderPlace> = {}): ResolvedProviderPlace =>
  ({
    providerPlaceId: 'ChIJx',
    name: 'Quán',
    addressText: '',
    lat: 10.78,
    lng: 106.7,
    rating: null,
    ratingCount: 0,
    businessStatus: 'OPERATIONAL',
    hours: [],
    priceLevel: null,
    primaryType: null,
    types: [],
    googleMapsUri: null,
    photos: [],
    fetchTier: 'quality',
    attribution: '',
    raw: {},
    ...over,
  }) as ResolvedProviderPlace;

describe('resolvePlaceIdByGoogleId', () => {
  it('answers from the canonical table without touching the legacy one', async () => {
    const { db, asked } = fakeDb({ canonical: [{ place_id: 'p-canonical' }] });
    const service = new PlaceDedupService(db);

    expect(await service.resolvePlaceIdByGoogleId('ChIJx')).toBe('p-canonical');
    // Reading `place_sources` after an answer is already in hand is a second
    // round trip on every ingestion row, for nothing.
    expect(asked).toEqual(['canonical']);
  });

  it('falls back to the legacy table, which is what makes migration safe', async () => {
    const { db, asked } = fakeDb({ canonical: [], legacy: [{ place_id: 'p-legacy' }] });
    const service = new PlaceDedupService(db);

    // A row the backfill has not reached — or one parked as a conflict — must
    // still resolve to the place it has always resolved to.
    expect(await service.resolvePlaceIdByGoogleId('ChIJx')).toBe('p-legacy');
    expect(asked).toEqual(['canonical', 'legacy']);
  });

  it('returns null when neither table knows the id', async () => {
    const { db } = fakeDb({});
    expect(await new PlaceDedupService(db).resolvePlaceIdByGoogleId('ChIJx')).toBeNull();
  });
});

describe('check', () => {
  it('links to the legacy place instead of proposing a new one', async () => {
    const { db } = fakeDb({ canonical: [], legacy: [{ place_id: 'p-legacy' }] });
    const service = new PlaceDedupService(db);

    expect(await service.check(details())).toEqual({
      kind: 'LINKED_EXISTING',
      placeId: 'p-legacy',
    });
  });
});

describe('reportIdMismatch', () => {
  it('counts a moved place, with bounded labels and no ids', () => {
    const { db } = fakeDb({});
    const { metrics, counters } = fakeMetrics();
    const service = new PlaceDedupService(db, metrics);

    service.reportIdMismatch(
      details({ providerPlaceId: 'ChIJnew', requestedProviderPlaceId: 'ChIJold' }),
      'import',
    );

    expect(counters).toEqual([
      {
        name: 'place_provider_id_mismatch_total',
        labels: { provider: 'google_places', path: 'import' },
      },
    ]);
    expect(JSON.stringify(counters)).not.toContain('ChIJ');
  });

  it('stays quiet when the provider answered about the id we asked for', () => {
    const { db } = fakeDb({});
    const { metrics, counters } = fakeMetrics();
    const service = new PlaceDedupService(db, metrics);

    service.reportIdMismatch(details({ providerPlaceId: 'ChIJsame' }), 'ingest');
    service.reportIdMismatch(
      details({ providerPlaceId: 'ChIJsame', requestedProviderPlaceId: 'ChIJsame' }),
      'ingest',
    );

    expect(counters).toEqual([]);
  });
});
