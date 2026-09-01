import { describe, expect, it } from 'vitest';
import type { Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import type { MetricsPort } from '@gogo/observability';
import { PlaceDedupService } from './place-dedup.service';

/**
 * #334 — the resolver is the single answer to "which GoGo place is this Google
 * Place ID?". Before PR1 each path had its own, and they disagreed.
 */

type Resolution = {
  canonical_place_id?: string | null;
  legacy_place_id?: string | null;
  conflict_id?: string | null;
};

/** One query now, so the fake answers it once and records that it was one. */
function fakeDb(row: Resolution) {
  const queries: string[] = [];
  const db = {
    execute: async (query: unknown) => {
      queries.push(JSON.stringify(query));
      return {
        rows: [
          {
            canonical_place_id: row.canonical_place_id ?? null,
            legacy_place_id: row.legacy_place_id ?? null,
            conflict_id: row.conflict_id ?? null,
          },
        ],
      };
    },
  } as unknown as Db;
  return { db, queries };
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

describe('resolveGoogleIdentity', () => {
  it('answers from the canonical table, in one round trip', async () => {
    const { db, queries } = fakeDb({ canonical_place_id: 'p-canonical' });
    const service = new PlaceDedupService(db);

    expect(await service.resolveGoogleIdentity('ChIJx')).toEqual({
      kind: 'RESOLVED',
      placeId: 'p-canonical',
    });
    // Three tables, one query: this runs on every bulk import row.
    expect(queries).toHaveLength(1);
  });

  it('falls back to the legacy table, which is what makes migration safe', async () => {
    const { db } = fakeDb({ legacy_place_id: 'p-legacy' });
    const service = new PlaceDedupService(db);

    // A row the backfill has not reached must still resolve to the place it
    // has always resolved to.
    expect(await service.resolveGoogleIdentity('ChIJx')).toEqual({
      kind: 'RESOLVED',
      placeId: 'p-legacy',
    });
  });

  it('returns NONE when neither table knows the id', async () => {
    const { db } = fakeDb({});
    expect(await new PlaceDedupService(db).resolveGoogleIdentity('ChIJx')).toEqual({
      kind: 'NONE',
    });
  });

  it('refuses to pick a winner while a conflict is open', async () => {
    const { db } = fakeDb({
      canonical_place_id: 'p-ingestion',
      legacy_place_id: 'p-legacy',
      conflict_id: 'c-1',
    });
    const service = new PlaceDedupService(db);

    // The regression this guards: returning `p-ingestion` because the
    // canonical table is read first would make the conflict queue decorative.
    expect(await service.resolveGoogleIdentity('ChIJx')).toEqual({
      kind: 'CONFLICT',
      placeIds: ['p-ingestion', 'p-legacy'],
      conflictId: 'c-1',
    });
  });

  it('resolves again once the conflict is closed', async () => {
    const { db } = fakeDb({ canonical_place_id: 'p-ingestion', legacy_place_id: 'p-legacy' });
    // A resolved conflict is not returned by the query at all, so the row
    // reads exactly like an ordinary one.
    expect(await new PlaceDedupService(db).resolveGoogleIdentity('ChIJx')).toEqual({
      kind: 'RESOLVED',
      placeId: 'p-ingestion',
    });
  });
});

describe('check', () => {
  it('links to the legacy place instead of proposing a new one', async () => {
    const { db } = fakeDb({ legacy_place_id: 'p-legacy' });
    const service = new PlaceDedupService(db);

    expect(await service.check(details())).toEqual({
      kind: 'LINKED_EXISTING',
      placeId: 'p-legacy',
    });
  });

  it('surfaces an open conflict as its own verdict, never as a link', async () => {
    const { db } = fakeDb({
      canonical_place_id: 'p-ingestion',
      legacy_place_id: 'p-legacy',
      conflict_id: 'c-1',
    });
    const { metrics, counters } = fakeMetrics();
    const service = new PlaceDedupService(db, metrics);

    expect(await service.check(details())).toEqual({
      kind: 'IDENTITY_CONFLICT',
      placeIds: ['p-ingestion', 'p-legacy'],
      conflictId: 'c-1',
    });
    expect(counters).toEqual([
      { name: 'place_identity_conflict_blocked_total', labels: { path: 'dedup' } },
    ]);
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
