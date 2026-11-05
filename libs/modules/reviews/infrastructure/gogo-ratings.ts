import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { toGogoRating, type GogoRatingFacts } from '../domain/gogo-rating';
import { PUBLIC_REVIEW_STATUS } from '../domain/public-review';

type AggregateRow = {
  placeId: string;
  count: number;
  mean: string | null;
};

/**
 * GoGo-BE#754 — one aggregate query for any number of place cards.
 *
 * Missing groups are real zeroes, not missing data: PostgreSQL emits no group
 * for a place with no published review, so the requested ids seed the map
 * before the rows replace them. The count and mean still come from the same
 * group and therefore always describe the same population.
 */
export async function loadGogoRatings(
  db: Db,
  placeIds: string[],
): Promise<Map<string, GogoRatingFacts>> {
  const ids = [...new Set(placeIds)];
  const result = new Map(ids.map((id) => [id, toGogoRating(0, null)]));
  if (ids.length === 0) return result;

  const rows = await db
    .select({
      placeId: schema.reviews.placeId,
      count: sql<number>`count(*)::int`.mapWith(Number),
      mean: sql<string | null>`round(avg(${schema.reviews.rating})::numeric, 1)`,
    })
    .from(schema.reviews)
    .where(
      and(inArray(schema.reviews.placeId, ids), eq(schema.reviews.status, PUBLIC_REVIEW_STATUS)),
    )
    .groupBy(schema.reviews.placeId);

  for (const row of rows as AggregateRow[]) {
    result.set(row.placeId, toGogoRating(row.count, row.mean));
  }
  return result;
}
