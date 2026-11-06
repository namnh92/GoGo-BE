import { randomUUID } from 'node:crypto';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { describe, expect, it, vi } from 'vitest';
import { PlaceDedupService } from './place-dedup.service';
import { PlaceImportJobService } from './place-import-job.service';
import { PlaceSubmissionService } from './place-submission.service';

export const providerDetails = (id: string): ResolvedProviderPlace => ({
  providerPlaceId: id,
  name: 'Claim test',
  addressText: '',
  lat: 10.77,
  lng: 106.7,
  rating: null,
  ratingCount: 0,
  priceLevel: null,
  hours: [],
  businessStatus: 'OPERATIONAL',
  fetchTier: 'quality',
  primaryType: 'cafe',
  types: ['cafe'],
  attribution: 'Google',
  googleMapsUri: null,
  raw: null,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Transactional store with the actual advisory SQL as its serialization point. */
function harness(owner?: string, legacy?: string) {
  const identity = 'claim-google';
  const submission = {
    id: randomUUID(),
    googlePlaceId: identity,
    status: 'pending',
    submittedByUserId: randomUUID(),
    reviewDraft: {},
    submissionRevision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    resultPlaceId: null,
  };
  const state = {
    places: new Map<string, string>(owner || legacy ? [[owner ?? legacy!, 'draft']] : []),
    owner,
    legacy,
    balance: 0,
    ledger: 0,
    dependent: 0,
    events: 0,
    rowStatus: 'ready',
  };
  const acquired = deferred();
  const placeLocks: string[] = [];
  const contending = deferred();
  const releaseWinner = deferred();
  let holder: object | undefined;
  let unlock = deferred();
  let gate = false;
  let failSource = false;
  let conditionalMiss = false;
  const dialect = new PgDialect();
  const db = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const token = {};
      const writes: (() => void)[] = [];
      const ownPlaces = new Map<string, string>();
      let ownOwner: string | undefined;
      const tx = {
        execute: async (query: SQL) => {
          const { sql, params } = dialect.sqlToQuery(query);
          if (
            sql.includes('pg_advisory_xact_lock') &&
            String(params[0]).startsWith('venue:google:')
          ) {
            if (holder && holder !== token) {
              contending.resolve();
              await unlock.promise;
            }
            if (holder !== token) {
              holder = token;
              if (gate) {
                acquired.resolve();
                await releaseWinner.promise;
              }
            }
            return { rows: [] };
          }
          if (sql.includes('as canonical_place_id'))
            return {
              rows: [
                {
                  canonical_place_id: ownOwner ?? state.owner ?? null,
                  legacy_place_id: state.legacy ?? null,
                  conflict_id: null,
                },
              ],
            };
          if (sql.includes('union all select') && sql.includes('assistant_credit_ledger'))
            return {
              rows:
                state.owner || state.legacy || state.ledger
                  ? [{ place_id: state.owner ?? state.legacy }]
                  : [],
            };
          if (sql.includes('select id from users'))
            return { rows: [{ id: submission.submittedByUserId }] };
          if (sql.includes('insert into assistant_credit_ledger')) {
            writes.push(() => {
              state.ledger++;
            });
            return { rows: [{ id: randomUUID() }] };
          }
          if (sql.includes('insert into assistant_credit_accounts'))
            writes.push(() => {
              state.balance += 50;
            });
          return { rows: [] };
        },
        select: () => {
          let table: string;
          let id: string;
          const chain = {
            from(t: Parameters<typeof getTableName>[0]) {
              table = getTableName(t);
              return chain;
            },
            where(q: SQL) {
              id = String(dialect.sqlToQuery(q).params[0]).toLowerCase();
              return chain;
            },
            for() {
              if (table === 'places') placeLocks.push(id);
              return chain;
            },
            limit() {
              return chain;
            },
            then(resolve: (v: unknown) => void) {
              resolve(
                table === 'place_submissions'
                  ? [submission]
                  : table === 'places'
                    ? ownPlaces.has(id) || state.places.has(id)
                      ? [{ id, status: ownPlaces.get(id) ?? state.places.get(id) }]
                      : []
                    : [],
              );
            },
          };
          return chain;
        },
        insert: (table: Parameters<typeof getTableName>[0]) => ({
          values: (value: Record<string, unknown> | Record<string, unknown>[]) => {
            const name = getTableName(table);
            const data = Array.isArray(value) ? value : [value];
            const id = randomUUID();
            let conflict = false;
            let applied = false;
            const apply = () => {
              if (applied) return;
              applied = true;
              if (name === 'places') {
                ownPlaces.set(id, String(data[0]!.status));
                writes.push(() => {
                  state.places.set(id, String(data[0]!.status));
                });
              } else if (name === 'place_provider_sources') {
                if (failSource) throw new Error('source write failed');
                if (conflict && conditionalMiss) return;
                ownOwner = String(data[0]!.placeId);
                writes.push(() => {
                  state.owner = ownOwner;
                });
              } else if (name === 'outbox_events')
                writes.push(() => {
                  state.events++;
                });
              else
                writes.push(() => {
                  state.dependent += data.length;
                });
            };
            const chain = {
              onConflictDoUpdate(options: { set: Record<string, unknown>; setWhere?: unknown }) {
                conflict = true;
                expect(options.set).not.toHaveProperty('placeId');
                expect(options.setWhere).toBeDefined();
                return chain;
              },
              onConflictDoNothing() {
                return chain;
              },
              returning() {
                apply();
                return Promise.resolve(
                  name === 'place_provider_sources' && conditionalMiss ? [] : [{ id, ...data[0] }],
                );
              },
              then(resolve: (v: unknown) => void, reject: (err: unknown) => void) {
                try {
                  apply();
                  resolve([]);
                } catch (err) {
                  reject(err);
                }
              },
            };
            return chain;
          },
        }),
        update: (table: Parameters<typeof getTableName>[0]) => ({
          set: (value: Record<string, unknown>) => ({
            where: async () => {
              writes.push(() => {
                if (getTableName(table) === 'place_submissions') Object.assign(submission, value);
                if (getTableName(table) === 'place_ingest_rows')
                  state.rowStatus = String(value.status);
              });
            },
          }),
        }),
      };
      try {
        const result = await work(tx);
        for (const write of writes) write();
        return result;
      } finally {
        if (holder === token) {
          holder = undefined;
          unlock.resolve();
          unlock = deferred();
        }
      }
    },
  } as unknown as Db;
  const dedup = new PlaceDedupService(db);
  const resolver = {
    resolveByProviderId: async () => ({ status: 'RESOLVED', details: providerDetails(identity) }),
    scoreFor: async () => 0.5,
  };
  const approval = new PlaceSubmissionService(
    db,
    resolver as never,
    dedup,
    {} as never,
    {} as never,
  );
  // The read outside the transaction is the same pending revision; row locking runs inside it.
  db.select = (() => ({
    from: () => ({ where: () => ({ limit: async () => [submission] }) }),
  })) as never;
  // Bulk creation commits the place/source, then records the import-row outcome
  // through the pool. Keep that write observable, just like tx.update above.
  db.update = ((table: Parameters<typeof getTableName>[0]) => ({
    set: (value: Record<string, unknown>) => ({
      where: async () => {
        if (getTableName(table) === 'place_ingest_rows') state.rowStatus = String(value.status);
      },
    }),
  })) as never;
  const imports = new PlaceImportJobService(
    db,
    resolver as never,
    dedup,
    {} as never,
    {} as never,
    { APP_ENV: 'dev', PLACE_RESOLUTION_TTL_S: 600 },
  );
  const normalized = {
    vibes: [],
    audiences: [],
    categoryKey: null,
    priceMin: null,
    priceMax: null,
    priceUnit: null,
    avgVisitMinutes: null,
    isLodging: null,
    curatedRank: null,
  };
  const row = { id: randomUUID(), resolvedGooglePlaceId: identity, normalizedInput: normalized };
  const importPlace = () =>
    (
      imports as unknown as {
        createPlaceFromRow: (r: unknown, mode: string, actor: string) => Promise<string>;
      }
    ).createPlaceFromRow(row, 'create_drafts', randomUUID());
  return {
    db,
    dedup,
    state,
    placeLocks,
    submission,
    identity,
    imports,
    row,
    approve: () => approval.decide(randomUUID(), submission.id, 'approved', 'Checked'),
    importPlace,
    acquired,
    contending,
    releaseWinner,
    gate: () => {
      gate = true;
    },
    failSource: () => {
      failSource = true;
    },
    conditionalMiss: () => {
      conditionalMiss = true;
    },
  };
}

describe('F-02 identity claims', () => {
  it('uses one UUID lock order for mixed-case merge targets and same-owner claims', async () => {
    const a = 'a0000000-0000-4000-8000-000000000000';
    const b = 'b0000000-0000-4000-8000-000000000000';
    const h = harness(a);
    h.state.places.set(b, 'draft');
    await h.db.transaction((tx) => h.dedup.lockPlaces(tx, [b.toUpperCase(), a, b]));
    expect(h.placeLocks).toEqual([a, b]);
    await h.db.transaction((tx) => h.dedup.claimGoogleIdentity(tx, h.identity, a.toUpperCase()));
    expect(h.state.owner).toBe(a);
  });

  it.each(['approval', 'import'])(
    'serializes actual approval versus import with %s winning',
    async (winner) => {
      const h = harness();
      h.gate();
      const first = winner === 'approval' ? h.approve() : h.importPlace();
      await h.acquired.promise;
      const second = (winner === 'approval' ? h.importPlace() : h.approve()).then(
        () => null,
        (e: unknown) => e,
      );
      await h.contending.promise;
      expect(h.state.places.size).toBe(0);
      h.releaseWinner.resolve();
      await first;
      expect(await second).toMatchObject({ code: 'DUPLICATE_VENUE' });
      expect(h.state.places.size).toBe(1);
      expect(h.state.owner).toBe([...h.state.places.keys()][0]);
      expect(h.submission.status).toBe(winner === 'approval' ? 'approved' : 'pending');
      expect(h.state.balance).toBe(winner === 'approval' ? 50 : 0);
      expect(h.state.ledger).toBe(winner === 'approval' ? 1 : 0);
      expect(h.state.rowStatus).toBe(winner === 'import' ? 'imported' : 'ready');
    },
  );

  it('rejects legacy-only ownership before approval or bulk creates anything', async () => {
    const h = harness(undefined, 'legacy');
    await expect(h.approve()).rejects.toMatchObject({ code: 'DUPLICATE_VENUE' });
    await expect(h.importPlace()).rejects.toMatchObject({ code: 'DUPLICATE_VENUE' });
    expect(h.state.places.size).toBe(1);
    expect(h.state.owner).toBeUndefined();
    expect(h.state.balance).toBe(0);
  });

  it('rejects unrecorded canonical/legacy disagreement and conflicting refresh', async () => {
    const h = harness('canonical', 'legacy');
    await expect(h.approve()).rejects.toMatchObject({ code: 'PLACE_IDENTITY_CONFLICT' });
    await expect(
      h.dedup.upsertProviderSource({
        placeId: 'canonical',
        details: providerDetails(h.identity),
        derivedScore: 0.5,
        fetchTier: 'quality',
      }),
    ).rejects.toMatchObject({ code: 'PLACE_IDENTITY_CONFLICT' });
    expect(h.state.owner).toBe('canonical');
  });

  it('permits same-owner refresh and legacy-to-canonical linking', async () => {
    for (const h of [harness('same'), harness(undefined, 'same')]) {
      await h.dedup.upsertProviderSource({
        placeId: 'same',
        details: providerDetails(h.identity),
        derivedScore: 0.5,
        fetchTier: 'quality',
      });
      expect(h.state.owner).toBe('same');
    }
  });

  it('rejects conflicting ownership and a conditional upsert miss', async () => {
    const h = harness('owner');
    h.state.places.set('other', 'draft');
    await expect(
      h.dedup.upsertProviderSource({
        placeId: 'other',
        details: providerDetails(h.identity),
        derivedScore: 0.5,
        fetchTier: 'quality',
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_VENUE' });
    h.conditionalMiss();
    await expect(
      h.dedup.upsertProviderSource({
        placeId: 'owner',
        details: providerDetails(h.identity),
        derivedScore: 0.5,
        fetchTier: 'quality',
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_VENUE' });
    expect(h.state.owner).toBe('owner');
  });

  it.each(['approval', 'import'])(
    'rolls back %s place and dependents on source failure',
    async (path) => {
      const h = harness();
      h.failSource();
      await expect(path === 'approval' ? h.approve() : h.importPlace()).rejects.toThrow(
        'source write failed',
      );
      expect(h.state).toMatchObject({
        owner: undefined,
        balance: 0,
        ledger: 0,
        dependent: 0,
        events: 0,
        rowStatus: 'ready',
      });
      expect(h.state.places.size).toBe(0);
      expect(h.submission.status).toBe('pending');
    },
  );

  it('refuses attachment and refresh against an archived merge loser', async () => {
    const h = harness('loser');
    h.state.places.set('loser', 'archived');
    await expect(
      h.dedup.upsertProviderSource({
        placeId: 'loser',
        details: providerDetails(h.identity),
        derivedScore: 0.5,
        fetchTier: 'quality',
      }),
    ).rejects.toMatchObject({ code: 'PLACE_ARCHIVED' });
  });

  it('mergeRow rejects another owner without changing row status or success events', async () => {
    const h = harness('owner');
    h.state.places.set('target', 'draft');
    const internals = h.imports as unknown as {
      requireRow: () => Promise<typeof h.row>;
      assertContactCurrent: () => Promise<void>;
      dbFirst: () => Promise<boolean>;
    };
    vi.spyOn(internals, 'requireRow').mockResolvedValue(h.row);
    vi.spyOn(internals, 'assertContactCurrent').mockResolvedValue(undefined);
    vi.spyOn(internals, 'dbFirst').mockResolvedValue(false);
    await expect(
      h.imports.mergeRow(randomUUID(), h.row.id, 'target', randomUUID()),
    ).rejects.toMatchObject({ code: 'DUPLICATE_VENUE' });
    expect(h.state).toMatchObject({ rowStatus: 'ready', events: 0, owner: 'owner' });
  });
});
