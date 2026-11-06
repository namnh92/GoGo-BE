import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';

/** #785: transactionally maintained, deduplicated across members/stops/versions. */
export function checkedInGroupCountQuery(placeId: string): SQL {
  return sql`
    select coalesce((select group_count from place_checkin_counts
      where place_id = ${placeId}), 0)::int as group_count
  `;
}

export const CHECKED_IN_GROUP_MIN_SAMPLE = 5;

/**
 * Read one precomputed row per request. Neither values nor in-flight
 * promises may be reused: another process can delete/cascade/merge visits below
 * the privacy threshold while a previous aggregate is cached or still running.
 * A read started before a concurrent commit uses its own DB statement snapshot;
 * it cannot populate a cache or supply a later request with that older snapshot.
 */
export class CheckedInGroupCounts {
  constructor(
    private readonly db: Db,
    private readonly metrics: MetricsPort,
  ) {}

  get(placeId: string): Promise<number | null> {
    return this.load(placeId).catch((error: unknown) => {
      this.metrics.increment('place_checkin_group_count_total', { outcome: 'error' });
      throw error;
    });
  }

  private async load(placeId: string): Promise<number | null> {
    const result = await this.db.execute(checkedInGroupCountQuery(placeId));
    const count = (result.rows[0] as { group_count?: unknown } | undefined)?.group_count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid checked-in group aggregate');
    }
    const visible = count >= CHECKED_IN_GROUP_MIN_SAMPLE;
    this.metrics.increment('place_checkin_group_count_total', {
      outcome: visible ? 'available' : 'suppressed',
    });
    return visible ? count : null;
  }
}
