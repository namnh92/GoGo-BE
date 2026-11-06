import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { schema, Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaceDedupService } from './place-dedup.service';
import { PlaceImportJobService } from './place-import-job.service';

type Row = typeof schema.placeIngestRows.$inferSelect;
const normalized = {
  categoryKey: 'cafe',
  vibes: [],
  audiences: [],
  priceMin: null,
  priceMax: null,
  priceUnit: null,
  avgVisitMinutes: null,
  isLodging: null,
  curatedRank: null,
};
const details = (id: string): ResolvedProviderPlace => ({
  providerPlaceId: id,
  name: 'Provider name',
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

/** SQL predicates come from the real service; the store contains no canonical places at resolve. */
function harness(count: number, distinct: number) {
  const jobId = randomUUID();
  const rows = Array.from({ length: count }, (_, i): Row => ({
    id: randomUUID(),
    jobId,
    sourceRowId: `C-${i}`,
    rowNumber: i + 1,
    status: 'resolving',
    rawInput: {},
    normalizedInput: { ...normalized, name: `Quán C ${i}` },
    resolvedGooglePlaceId: null,
    matchedPlaceId: null,
    matchConfidence: null,
    matchReasons: [],
    candidates: [],
    publicationOutcome: null,
    administrativeProvinceCode: null,
    administrativeCommuneCode: null,
    administrativeMappingStatus: null,
    administrativeDatasetVersion: null,
    errors: [],
    warnings: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const dialect = new PgDialect();
  const owners = new Map<string, string>();
  const places = new Map<string, Record<string, unknown>>();
  const commits: { rows: Row[]; owners: Map<string, string> }[] = [];
  const queries: string[] = [];
  const locks = new Map<string, Promise<void>>();
  function matches(row: Row, where: SQL) {
    const { sql, params } = dialect.sqlToQuery(where);
    const data = row as unknown as Record<string, unknown>;
    const value = (column: string) =>
      data[column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
    for (const m of sql.matchAll(/"place_ingest_rows"\."(\w+)" (=|<>) \$(\d+)/g)) {
      const equal = value(m[1]!) === params[Number(m[3]) - 1];
      if (m[2] === '=' ? !equal : equal) return false;
    }
    const statuses = /"status" in \(([^)]+)\)/.exec(sql);
    return (
      !statuses ||
      [...statuses[1]!.matchAll(/\$(\d+)/g)].some((m) => params[Number(m[1]) - 1] === row.status)
    );
  }
  const db = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const held = new Set<string>();
      const releases: (() => void)[] = [];
      const tx = {
        ...db,
        execute: async (query: SQL) => {
          const { sql, params } = dialect.sqlToQuery(query);
          if (sql.includes('pg_advisory_xact_lock')) {
            const key = String(params[0]);
            if (!held.has(key)) {
              held.add(key);
              const previous = locks.get(key) ?? Promise.resolve();
              locks.set(key, new Promise<void>((release) => releases.push(release)));
              await previous;
            }
          }
          return db.execute(query);
        },
      };
      try {
        const result = await work(tx);
        commits.push({ rows: structuredClone(rows), owners: new Map(owners) });
        return result;
      } finally {
        for (const release of releases) release();
      }
    },
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      queries.push(sql);
      if (sql.includes('as canonical_place_id'))
        return {
          rows: [
            {
              canonical_place_id: owners.get(String(params[1])) ?? null,
              legacy_place_id: null,
              conflict_id: null,
            },
          ],
        };
      return { rows: [] };
    },
    select: () => {
      let table = '';
      let where: SQL | undefined;
      const chain = {
        from(t: Parameters<typeof getTableName>[0]) {
          table = getTableName(t);
          return chain;
        },
        where(w: SQL) {
          where = w;
          return chain;
        },
        limit() {
          return chain;
        },
        for() {
          return chain;
        },
        then(resolve: (v: unknown) => void) {
          resolve(
            table === 'place_ingest_rows'
              ? structuredClone(rows.filter((r) => !where || matches(r, where)))
              : table === 'places'
                ? [...places].map(([id, p]) => ({ id, ...p }))
                : [],
          );
        },
      };
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (where: SQL) => {
          for (const row of rows.filter((r) => matches(r, where))) Object.assign(row, values);
        },
      }),
    }),
    insert: (t: Parameters<typeof getTableName>[0]) => ({
      values: (data: Record<string, unknown>) => {
        const table = getTableName(t);
        const id = randomUUID();
        const apply = () => {
          if (table === 'places') places.set(id, data);
          if (table === 'place_provider_sources')
            owners.set(String(data.externalId), String(data.placeId));
          return [{ id, ...data }];
        };
        const chain = {
          onConflictDoUpdate(options: { set: Record<string, unknown>; setWhere?: unknown }) {
            expect(options.set).not.toHaveProperty('placeId');
            expect(options.setWhere).toBeDefined();
            return chain;
          },
          returning: async () => apply(),
          then(resolve: (v: unknown) => void) {
            resolve(apply());
          },
        };
        return chain;
      },
    }),
  } as unknown as Db;
  const dedup = new PlaceDedupService(db);
  vi.spyOn(dedup, 'check').mockResolvedValue({ kind: 'NEW' });
  const resolver = {
    resolveByProviderId: async (id: string) => ({ status: 'RESOLVED', details: details(id) }),
    scoreFor: async () => 0.5,
  };
  const service = new PlaceImportJobService(
    db,
    resolver as never,
    dedup,
    {} as never,
    {} as never,
    { APP_ENV: 'dev', PLACE_RESOLUTION_TTL_S: 600 },
  );
  const internals = service as unknown as {
    applyResolved: (
      id: string,
      d: ResolvedProviderPlace,
      reasons: string[],
      confidence: number,
      context: unknown,
    ) => Promise<void>;
    administrativePreview: () => Promise<object>;
    refuseStaleContact: () => Promise<boolean>;
    requireJob: () => Promise<{ id: string; mode: string }>;
    audit: () => Promise<void>;
    refreshCounters: () => Promise<void>;
    createPlaceFromRow: (row: Row, mode: string, actor: string) => Promise<string>;
  };
  vi.spyOn(internals, 'administrativePreview').mockResolvedValue({});
  vi.spyOn(internals, 'refuseStaleContact').mockResolvedValue(false);
  vi.spyOn(internals, 'requireJob').mockResolvedValue({ id: jobId, mode: 'create_drafts' });
  vi.spyOn(internals, 'audit').mockResolvedValue(undefined);
  vi.spyOn(internals, 'refreshCounters').mockResolvedValue(undefined);
  const resolve = (i: number) =>
    internals.applyResolved(rows[i]!.id, details(`fake-scale-${i % distinct}`), [], 1, {
      mode: 'create_drafts',
      normalized: rows[i]!.normalizedInput,
    });
  return { service, internals, dedup, rows, owners, places, queries, commits, jobId, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe('bulk import readiness and identity claims', () => {
  it('PI-QA-002: 90 resolved rows / 25 IDs publish every ready row without duplicates or owner replacement', async () => {
    const h = harness(90, 25);
    // Includes repeated IDs across the worker chunk boundary (50 rows).
    for (let i = 0; i < 90; i++) await h.resolve(i);
    const ready = h.rows.filter((r) => r.status === 'ready');
    expect(ready).toHaveLength(25);
    expect(
      h.rows.filter(
        (r) => r.status === 'duplicate' && r.errors[0]?.code === 'PLACE_DUPLICATE_IN_JOB',
      ),
    ).toHaveLength(65);
    expect(await h.service.publish(h.jobId, randomUUID())).toMatchObject({
      created: ready.length,
      failed: [],
    });
    expect(h.places.size).toBe(25);
    expect(h.owners.size).toBe(25);
    const duplicates = h.rows.filter((r) => r.status === 'duplicate');
    expect(duplicates).toHaveLength(65);
    for (const row of duplicates) {
      const sibling = ready.find((r) => r.resolvedGooglePlaceId === row.resolvedGooglePlaceId)!;
      expect(row.matchedPlaceId).toBe(sibling.matchedPlaceId);
      expect(row.matchedPlaceId).toBe(h.owners.get(row.resolvedGooglePlaceId!));
      expect(row.errors[0]?.code).toBe('PLACE_DUPLICATE_IN_JOB');
    }
    // Inspect each transaction boundary, not just the final row state.
    for (const commit of h.commits) {
      for (const row of commit.rows.filter((r) => r.status === 'duplicate')) {
        const owner = commit.owners.get(row.resolvedGooglePlaceId!);
        if (owner) expect(row.matchedPlaceId).toBe(owner);
      }
    }
    const owners = [...h.owners];
    const duplicate = duplicates[0]!;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await h.service.mergeRow(h.jobId, duplicate.id, duplicate.matchedPlaceId!, randomUUID()),
      ).toMatchObject({ status: 'imported', matchedPlaceId: duplicate.matchedPlaceId });
      expect([...h.owners]).toEqual(owners);
      expect(h.places.size).toBe(25);
    }
    expect(await h.service.publish(h.jobId, randomUUID())).toMatchObject({
      created: 0,
      failed: [],
    });
    expect([...h.owners]).toEqual(owners);
    expect(h.places.size).toBe(25);
  });

  it('links duplicate siblings atomically when the ready row merges into an existing place', async () => {
    const h = harness(5, 1);
    for (let i = 0; i < 5; i++) await h.resolve(i);
    h.rows[3]!.jobId = randomUUID();
    h.rows[4]!.status = 'failed';
    const placeId = randomUUID();
    h.places.set(placeId, { status: 'draft' });
    const claim = vi.spyOn(h.dedup, 'claimGoogleIdentity');
    for (let attempt = 0; attempt < 2; attempt++) {
      await h.service.mergeRow(h.jobId, h.rows[0]!.id, placeId, randomUUID());
      expect(h.rows.slice(1, 3).map((r) => [r.status, r.matchedPlaceId])).toEqual([
        ['duplicate', placeId],
        ['duplicate', placeId],
      ]);
      expect(h.rows[3]!.matchedPlaceId).toBeNull();
      expect(h.rows[4]!.matchedPlaceId).toBeNull();
      expect(h.places.size).toBe(1);
      expect([...h.owners]).toEqual([['fake-scale-0', placeId]]);
    }
    // Each merge claims explicitly and the source upsert defensively claims again.
    expect(claim).toHaveBeenCalledTimes(4);
    for (const [, identity, target] of claim.mock.calls) {
      expect(identity).toBe('fake-scale-0');
      expect(target).toBe(placeId);
    }
    for (const commit of h.commits.filter((c) => c.owners.size > 0)) {
      expect(commit.rows[0]).toMatchObject({ status: 'imported', matchedPlaceId: placeId });
      expect(commit.rows[1]!.matchedPlaceId).toBe(placeId);
      expect(commit.rows[2]!.matchedPlaceId).toBe(placeId);
    }
    expect(await h.service.publish(h.jobId, randomUUID())).toMatchObject({
      created: 0,
      failed: [],
    });
  });

  it('serializes concurrent re-publish and gives later resolved siblings the committed match', async () => {
    const h = harness(3, 1);
    await h.resolve(0);
    await h.resolve(1);
    const results = await Promise.all([
      h.service.publish(h.jobId, randomUUID()),
      h.service.publish(h.jobId, randomUUID()),
    ]);
    expect(results.every((result) => result.failed.length === 0)).toBe(true);
    await h.resolve(2);
    expect(h.places.size).toBe(1);
    const placeId = h.owners.get('fake-scale-0');
    expect(placeId).toBeDefined();
    expect(h.rows.map((r) => r.matchedPlaceId)).toEqual([placeId, placeId, placeId]);
    expect(h.rows.map((r) => r.status)).toEqual(['imported', 'duplicate', 'duplicate']);
  });

  it('keeps all 90 distinct resolved identities ready, regardless of missing input IDs', async () => {
    const h = harness(90, 90);
    for (let i = 0; i < 90; i++) await h.resolve(i);
    expect(h.rows.filter((r) => r.status === 'ready')).toHaveLength(90);
    expect(await h.service.publish(h.jobId, randomUUID())).toMatchObject({
      created: 90,
      failed: [],
    });
    expect(h.owners.size).toBe(90);
  });

  it('excludes the current row, other jobs and failed rows when reserving readiness', async () => {
    const h = harness(3, 1);
    h.rows[1]!.jobId = randomUUID();
    await h.resolve(0);
    await h.resolve(0);
    await h.resolve(1);
    expect(h.rows.slice(0, 2).map((r) => r.status)).toEqual(['ready', 'ready']);
    h.rows[0]!.status = 'failed';
    await h.resolve(2);
    expect(h.rows[2]!.status).toBe('ready');
  });

  it('serializes simultaneous resolutions of the same identity within a job', async () => {
    const h = harness(2, 1);
    await Promise.all([h.resolve(0), h.resolve(1)]);
    expect(h.rows.map((r) => r.status).sort()).toEqual(['duplicate', 'ready']);
  });
});

describe('bulk publish failure diagnostics', () => {
  it('logs the ownership refusal code/message when recording PLACE_CREATE_FAILED', async () => {
    const h = harness(2, 1);
    await h.resolve(0);
    await h.service.publish(h.jobId, randomUUID());
    // Simulates a stale ready row resolved before the identity acquired an owner.
    Object.assign(h.rows[1]!, { status: 'ready', resolvedGooglePlaceId: 'fake-scale-0' });
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(await h.service.publish(h.jobId, randomUUID())).toMatchObject({
      created: 0,
      failed: [{ code: 'DUPLICATE_VENUE' }],
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'DUPLICATE_VENUE',
        error_message: 'Google identity already belongs to another place',
      }),
    );
    expect(h.places.size).toBe(1);
    expect(h.rows[1]!.errors[0]?.code).toBe('PLACE_CREATE_FAILED');
  });

  it('unwraps a database error without logging query parameters, detail or arbitrary error text', async () => {
    const h = harness(1, 1);
    h.rows[0]!.status = 'ready';
    const failure = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
      detail: 'private@example.com 10.7769,106.7009',
    });
    vi.spyOn(h.internals, 'createPlaceFromRow').mockRejectedValue(
      new Error('Failed query: insert ... params: private@example.com', { cause: failure }),
    );
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await h.service.publish(h.jobId, randomUUID());
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: '55P03',
        error_message: 'canceling statement due to lock timeout',
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private@|10\.7769|params:|insert/);
  });

  it('redacts an unrecognized exception message instead of exposing sheet data', async () => {
    const h = harness(1, 1);
    h.rows[0]!.status = 'ready';
    vi.spyOn(h.internals, 'createPlaceFromRow').mockRejectedValue(new Error('private@example.com'));
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await h.service.publish(h.jobId, randomUUID());
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'UNKNOWN',
        error_message: 'Unexpected place creation error (message redacted)',
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private@example.com');
    expect(h.rows[0]!.errors[0]?.message).not.toContain('private@example.com');
  });
});
