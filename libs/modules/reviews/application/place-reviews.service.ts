import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import {
  PLACE_REVIEW_PREVIEW_LIMIT,
  PUBLIC_REVIEW_STATUS,
  READABLE_PLACE_STATUSES,
  toPublicReview,
  type ReviewOrder,
} from '../domain/public-review';

/**
 * BE-BFF-018 (#570) — the latest published GoGo reviews of one place.
 * BE-BFF-019 (#571) — or the most helpful ones (ADR-0026, PROPOSAL).
 */
@Injectable()
export class PlaceReviewsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async preview(placeId: string, order: ReviewOrder = 'latest') {
    const [place] = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(
        and(eq(schema.places.id, placeId), inArray(schema.places.status, READABLE_PLACE_STATUSES)),
      )
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    // Derived, never stored: a count cannot disagree with the rows it counts.
    const helpfulCount = sql<number>`(
      select count(*)::int from ${schema.reviewReactions} rr
      where rr.review_id = ${schema.reviews.id} and rr.type = 'helpful'
    )`.mapWith(Number);

    const rows = await this.db
      .select({
        id: schema.reviews.id,
        rating: schema.reviews.rating,
        text: schema.reviews.text,
        createdAt: schema.reviews.createdAt,
        authorDisplayName: schema.users.displayName,
        authorStatus: schema.users.status,
        helpfulCount,
      })
      .from(schema.reviews)
      .innerJoin(schema.users, eq(schema.users.id, schema.reviews.userId))
      .where(
        and(eq(schema.reviews.placeId, placeId), eq(schema.reviews.status, PUBLIC_REVIEW_STATUS)),
      )
      // Newest first; two reviews written in the same instant break on id, so
      // two reads of the same data can never disagree about which three show.
      // `helpful` puts the count in front of exactly that order, so with no
      // reactions at all it answers what `latest` does.
      .orderBy(
        ...(order === 'helpful' ? [desc(helpfulCount)] : []),
        desc(schema.reviews.createdAt),
        desc(schema.reviews.id),
      )
      .limit(PLACE_REVIEW_PREVIEW_LIMIT);

    // `source` is a fact, not decoration: these are GoGo community reviews and
    // never share a number with the provider rating on Place Detail (rule 14).
    return { source: 'gogo' as const, order, reviews: rows.map(toPublicReview) };
  }
}
