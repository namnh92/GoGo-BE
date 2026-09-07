import type { DatasetSnapshot } from '../domain/snapshot';

/**
 * ADM-003 (#456) / ADR-0019 §8 — the seam the cache sits behind.
 *
 * The accepted design is in-process and version-keyed, deliberately not Redis:
 * the published set is ~800 KB and immutable within a version, publication is
 * rare, and Upstash bills per command, so a shared mutable tier would add a
 * meter to the most cacheable data in the system and buy nothing.
 *
 * The port exists anyway. If a future deployment genuinely needs a shared tier
 * the implementation changes and no caller does — and until then the port is
 * what lets tests drive the cache without a database.
 */
export interface AdministrativeDatasetPort {
  /**
   * The snapshot of the currently published dataset.
   *
   * Throws when there is no published dataset at all. That is a real outage —
   * the API cannot answer an administrative question without one — and it is
   * reported as such rather than as an empty list, which would read as "Vietnam
   * has no provinces".
   */
  active(): Promise<DatasetSnapshot>;

  /** Drops the memoised active-version pointer, forcing the next read to revalidate. */
  invalidateActiveVersion(): void;
}

export const ADMINISTRATIVE_DATASET = Symbol('ADMINISTRATIVE_DATASET');

export class NoPublishedDatasetError extends Error {
  constructor() {
    super('no administrative dataset is published');
    this.name = 'NoPublishedDatasetError';
  }
}
