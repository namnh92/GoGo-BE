import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';

/** #785: a room is the unit, across members, stops and plan versions. */
export function checkedInGroupCountQuery(placeId: string): SQL {
  return sql`
    select count(distinct p.room_id)::int as group_count
    from plan_stops s join plans p on p.id = s.plan_id
    where s.place_id = ${placeId}
      and exists (select 1 from stop_checkins c where c.plan_stop_id = s.id)
  `;
}

export const CHECKED_IN_GROUP_COUNT_TTL_MS = 60_000;
export const CHECKED_IN_GROUP_COUNT_CACHE_SIZE = 1_000;
export const CHECKED_IN_GROUP_MIN_SAMPLE = 5;

/**
 * Bounded per-process cache, including suppressed populations. Retained promises
 * coalesce concurrent reads. Expiry starts before SQL, so a slow read never
 * extends freshness. Failures evict themselves and propagate, never becoming 0.
 * Only the privacy-filtered count is retained; no member or room identities.
 */
export class CheckedInGroupCounts {
  private readonly entries = new Map<
    string,
    { expiresAt: number; value: Promise<number | null> }
  >();

  constructor(
    private readonly db: Db,
    private readonly metrics: MetricsPort,
  ) {}

  get(placeId: string): Promise<number | null> {
    const now = Date.now();
    const cached = this.entries.get(placeId);
    if (cached && cached.expiresAt > now) {
      this.metrics.increment('place_checkin_group_cache_total', { outcome: 'hit' });
      return cached.value;
    }
    this.entries.delete(placeId);
    if (this.entries.size >= CHECKED_IN_GROUP_COUNT_CACHE_SIZE) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.metrics.increment('place_checkin_group_cache_total', { outcome: 'miss' });
    const value = this.load(placeId).catch((error: unknown) => {
      if (this.entries.get(placeId)?.value === value) this.entries.delete(placeId);
      this.metrics.increment('place_checkin_group_cache_total', { outcome: 'error' });
      throw error;
    });
    this.entries.set(placeId, { expiresAt: now + CHECKED_IN_GROUP_COUNT_TTL_MS, value });
    return value;
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
