import { beforeEach, describe, expect, it } from 'vitest';
import { NoPublishedDatasetError } from '../application/administrative-dataset.port';
import type { ChangeRow, UnitRow } from '../domain/snapshot';
import { InProcessAdministrativeDatasetCache } from './in-process-dataset.cache';
import type { ActiveVersion } from './administrative.repository';

/**
 * ADM-003 (#456) / ADR-0019 §8 — the cache's behaviour, without a database.
 *
 * A fake repository counts every call, which is the only way to assert the
 * properties that matter here: that a request does not reload the dataset, that
 * the version pointer is asked on a TTL rather than per request, that
 * concurrent cold readers cause one load, and that a failed refresh does not
 * take the previous version down with it.
 */

const unit = (code: string, over: Partial<UnitRow> = {}): UnitRow => ({
  code,
  name: `Unit ${code}`,
  fullName: `Phường Unit ${code}`,
  nameEn: null,
  nameNormalized: `unit ${code}`,
  fullNameNormalized: `phuong unit ${code}`,
  codeName: null,
  unitType: 'WARD',
  level: 'COMMUNE',
  parentCode: '01',
  status: 'ACTIVE',
  effectiveFrom: '2025-07-01',
  effectiveTo: null,
  ...over,
});

const PROVINCE = unit('01', {
  level: 'PROVINCE',
  unitType: 'MUNICIPALITY',
  parentCode: null,
  fullName: 'Thành phố Hà Nội',
});

class FakeRepository {
  activeVersionCalls = 0;
  unitCalls = 0;
  version: ActiveVersion | null = {
    id: 'v1',
    combinedDatasetVersion: 'test+v1',
    effectiveDate: '2025-07-01',
    publishedAt: null,
  };
  failNextLoad = false;
  /** Resolves the in-flight load only when released, so concurrency is testable. */
  gate: { promise: Promise<void>; release: () => void } | null = null;

  async activeVersion(): Promise<ActiveVersion | null> {
    this.activeVersionCalls += 1;
    return this.version;
  }

  async unitsFor(): Promise<UnitRow[]> {
    this.unitCalls += 1;
    if (this.gate) await this.gate.promise;
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error('database is unreachable');
    }
    return [PROVINCE, unit('00004'), unit('00008')];
  }

  async canonicalChangesFor(): Promise<ChangeRow[]> {
    return [];
  }

  openGate(): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.gate = { promise, release };
  }
}

let repo: FakeRepository;
let clock: number;

function makeCache(ttlMs = 60_000) {
  return new InProcessAdministrativeDatasetCache(repo, ttlMs, () => clock);
}

beforeEach(() => {
  repo = new FakeRepository();
  clock = 1_000_000;
});

describe('a request reads memory, not the database', () => {
  it('loads once and serves every later read from the snapshot', async () => {
    const cache = makeCache();
    for (let i = 0; i < 25; i += 1) await cache.active();

    expect(repo.unitCalls).toBe(1);
    // 25 reads inside one TTL window ask PostgreSQL for the pointer once.
    expect(repo.activeVersionCalls).toBe(1);
    expect(cache.statistics()).toMatchObject({ loads: 1, versionChecks: 1 });
  });

  it('builds the indexes the endpoints actually read', async () => {
    const snapshot = await makeCache().active();
    expect(snapshot.currentProvinces.map((p) => p.code)).toEqual(['01']);
    expect(snapshot.communesByProvince.get('01')?.map((c) => c.code)).toEqual(['00004', '00008']);
    expect(snapshot.byCode.get('00004')).toHaveLength(1);
    expect(snapshot.counts).toMatchObject({ provinces: 1, communes: 2 });
  });
});

describe('the active-version pointer is bounded by the TTL', () => {
  it('does not re-ask PostgreSQL inside the window', async () => {
    const cache = makeCache(60_000);
    await cache.active();
    clock += 59_000;
    await cache.active();
    expect(repo.activeVersionCalls).toBe(1);
  });

  it('re-asks once the window has passed', async () => {
    const cache = makeCache(60_000);
    await cache.active();
    clock += 60_001;
    await cache.active();
    expect(repo.activeVersionCalls).toBe(2);
    // Same version, so no reload — only the pointer was revalidated.
    expect(repo.unitCalls).toBe(1);
  });

  it('switches to a newly published version within the TTL', async () => {
    const cache = makeCache(60_000);
    expect((await cache.active()).datasetVersion).toBe('test+v1');

    // Another process publishes. This one does not know yet.
    repo.version = {
      id: 'v2',
      combinedDatasetVersion: 'test+v2',
      effectiveDate: '2026-01-01',
      publishedAt: null,
    };
    clock += 30_000;
    expect((await cache.active()).datasetVersion).toBe('test+v1');

    clock += 30_001;
    expect((await cache.active()).datasetVersion).toBe('test+v2');
    expect(repo.unitCalls).toBe(2);
  });

  it('switches immediately when the publishing process invalidates its own pointer', async () => {
    // The process that committed the publish does not wait out its own TTL.
    const cache = makeCache(60_000);
    await cache.active();
    repo.version = {
      id: 'v2',
      combinedDatasetVersion: 'test+v2',
      effectiveDate: '2026-01-01',
      publishedAt: null,
    };
    cache.invalidateActiveVersion();
    expect((await cache.active()).datasetVersion).toBe('test+v2');
  });
});

describe('concurrent cold reads cause one load', () => {
  it('shares the in-flight promise instead of starting a load per request', async () => {
    const cache = makeCache();
    repo.openGate();

    const readers = Array.from({ length: 8 }, () => cache.active());
    // All eight are now waiting on the same load; releasing it settles them all.
    repo.gate!.release();
    const snapshots = await Promise.all(readers);

    expect(repo.unitCalls).toBe(1);
    expect(cache.statistics().dedupedLoads).toBe(7);
    // One object, not eight copies — the whole point of sharing the promise.
    expect(new Set(snapshots).size).toBe(1);
  });
});

describe('a failed refresh does not take the previous version down', () => {
  it('keeps serving the last good snapshot and retries next time', async () => {
    const cache = makeCache(60_000);
    expect((await cache.active()).datasetVersion).toBe('test+v1');

    repo.version = {
      id: 'v2',
      combinedDatasetVersion: 'test+v2',
      effectiveDate: '2026-01-01',
      publishedAt: null,
    };
    repo.failNextLoad = true;
    clock += 60_001;

    // Stale but correct, and it says which version it is.
    expect((await cache.active()).datasetVersion).toBe('test+v1');
    expect(cache.statistics().failedLoads).toBe(1);

    // The pointer was dropped, so the very next read retries rather than
    // waiting out another TTL believing the load had succeeded.
    expect((await cache.active()).datasetVersion).toBe('test+v2');
  });

  it('throws when the first ever load fails, because there is nothing to serve', async () => {
    const cache = makeCache();
    repo.failNextLoad = true;
    await expect(cache.active()).rejects.toThrow(/unreachable/);
  });
});

describe('memory is bounded', () => {
  it('retains the active version and at most one previous', async () => {
    const cache = makeCache(0); // every read revalidates
    for (const id of ['v1', 'v2', 'v3', 'v4']) {
      repo.version = {
        id,
        combinedDatasetVersion: `test+${id}`,
        effectiveDate: '2025-07-01',
        publishedAt: null,
      };
      await cache.active();
    }
    expect(cache.statistics().retained).toBe(2);
    expect(repo.unitCalls).toBe(4);
  });
});

describe('no published dataset is an outage, not an empty answer', () => {
  it('throws NoPublishedDatasetError rather than returning an empty snapshot', async () => {
    repo.version = null;
    await expect(makeCache().active()).rejects.toBeInstanceOf(NoPublishedDatasetError);
  });
});
