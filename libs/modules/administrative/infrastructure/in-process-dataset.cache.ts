import { Inject, Injectable, Optional } from '@nestjs/common';
import { buildSnapshot, type DatasetSnapshot } from '../domain/snapshot';
import {
  NoPublishedDatasetError,
  type AdministrativeDatasetPort,
} from '../application/administrative-dataset.port';
import type { AdministrativeRepository, ActiveVersion } from './administrative.repository';
import { ADMINISTRATIVE_REPOSITORY } from './administrative.repository';

/**
 * ADM-003 (#456) / ADR-0019 §8 — the in-process, version-keyed cache.
 *
 * Four behaviours, each of which exists because the obvious implementation gets
 * it wrong:
 *
 * **The active-version pointer is memoised on a TTL, not read per request.**
 * PostgreSQL stays authoritative — a pointer is a memo of what it said, never a
 * replacement — but asking it on every request would put a round trip in front
 * of data that changes a few times a year. The publishing process refreshes
 * immediately after its own commit; every other process notices within the TTL.
 * That bounded staleness is the design, and it is why publication is not a
 * cache-coherence problem.
 *
 * **Concurrent cold loads collapse into one.** A cold process taking traffic
 * would otherwise start a full load per in-flight request. The in-flight
 * promise is shared, so N concurrent readers cause one query set.
 *
 * **An entry is published only once it is complete.** The snapshot is built
 * fully, then installed. A half-built map is never reachable, so no request can
 * see a dataset missing half its communes.
 *
 * **A failed load keeps the previous version serving.** If the new version
 * cannot be read, answering from the last good snapshot is better than failing:
 * the data is slightly stale and says so — every response carries its own
 * `datasetVersion` — where the alternative is an outage. The pointer is rolled
 * back too, so the next attempt retries rather than believing it succeeded.
 */

export const ACTIVE_VERSION_TTL_MS = 60_000;

/** Active plus one previous. Enough to keep an in-flight request coherent across a publish, and bounded. */
const RETAINED_VERSIONS = 2;

export type CacheStats = {
  /** Snapshot loads that actually hit the database. */
  loads: number;
  /** Times the active-version pointer was read from PostgreSQL. */
  versionChecks: number;
  /** Concurrent loads that joined an in-flight one instead of starting their own. */
  dedupedLoads: number;
  /** Loads that threw and were served from the previous snapshot instead. */
  failedLoads: number;
  retained: number;
};

@Injectable()
export class InProcessAdministrativeDatasetCache implements AdministrativeDatasetPort {
  /** Insertion-ordered: the last entry is the newest installed version. */
  private readonly snapshots = new Map<string, DatasetSnapshot>();
  private readonly inFlight = new Map<string, Promise<DatasetSnapshot>>();
  private pointer: { value: ActiveVersion | null; checkedAtMs: number } | null = null;
  private readonly stats: CacheStats = {
    loads: 0,
    versionChecks: 0,
    dedupedLoads: 0,
    failedLoads: 0,
    retained: 0,
  };

  constructor(
    @Inject(ADMINISTRATIVE_REPOSITORY) private readonly repository: AdministrativeRepository,
    @Optional() private readonly ttlMs: number = ACTIVE_VERSION_TTL_MS,
    /** Injected so a test can move time without sleeping for a minute. */
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  statistics(): CacheStats {
    return { ...this.stats, retained: this.snapshots.size };
  }

  invalidateActiveVersion(): void {
    this.pointer = null;
  }

  async active(): Promise<DatasetSnapshot> {
    const version = await this.activeVersion();
    if (!version) throw new NoPublishedDatasetError();

    const cached = this.snapshots.get(version.id);
    if (cached) return cached;

    const inFlight = this.inFlight.get(version.id);
    if (inFlight) {
      this.stats.dedupedLoads += 1;
      return inFlight;
    }

    const load = this.load(version).finally(() => this.inFlight.delete(version.id));
    this.inFlight.set(version.id, load);

    try {
      return await load;
    } catch (error) {
      this.stats.failedLoads += 1;
      // Serve the last good snapshot rather than the outage. The pointer is
      // dropped so the next request retries the new version instead of
      // believing this one succeeded.
      const previous = this.newest();
      this.pointer = null;
      if (previous) return previous;
      throw error;
    }
  }

  private async load(version: ActiveVersion): Promise<DatasetSnapshot> {
    this.stats.loads += 1;
    const [units, changes] = await Promise.all([
      this.repository.unitsFor(version.id),
      this.repository.canonicalChangesFor(version.id),
    ]);
    const snapshot = buildSnapshot({
      datasetVersion: version.combinedDatasetVersion,
      datasetVersionId: version.id,
      effectiveDate: version.effectiveDate,
      publishedAt: version.publishedAt,
      units,
      changes,
    });
    // Installed only now, complete. Eviction is by insertion order, so which
    // version is dropped never depends on request timing.
    this.snapshots.set(version.id, snapshot);
    while (this.snapshots.size > RETAINED_VERSIONS) {
      const oldest = this.snapshots.keys().next().value as string;
      this.snapshots.delete(oldest);
    }
    return snapshot;
  }

  private newest(): DatasetSnapshot | undefined {
    let last: DatasetSnapshot | undefined;
    for (const snapshot of this.snapshots.values()) last = snapshot;
    return last;
  }

  private async activeVersion(): Promise<ActiveVersion | null> {
    const nowMs = this.now();
    if (this.pointer && nowMs - this.pointer.checkedAtMs < this.ttlMs) return this.pointer.value;
    this.stats.versionChecks += 1;
    const value = await this.repository.activeVersion();
    this.pointer = { value, checkedAtMs: nowMs };
    return value;
  }
}
