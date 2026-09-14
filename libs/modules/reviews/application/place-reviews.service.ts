import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import {
  PLACE_REVIEW_PREVIEW_LIMIT,
  PUBLIC_REVIEW_STATUS,
  toPublicReview,
} from '../domain/public-review';

/**
 * The statuses Place Detail answers for (`search.repository.ts` placeDetail).
 * A place nobody can open has no public reviews either, so a suspended place
 * answers 404 here exactly as it does there.
 */
const READABLE_PLACE_STATUSES: ('published' | 'community_submitted')[] = [
  'published',
  'community_submitted',
];

/** BE-BFF-018 (#570) — the latest published GoGo reviews of one place. */
@Injectable()
export class PlaceReviewsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async latest(placeId: string) {
    const [place] = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(
        and(eq(schema.places.id, placeId), inArray(schema.places.status, READABLE_PLACE_STATUSES)),
      )
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    const rows = await this.db
      .select({
        id: schema.reviews.id,
        rating: schema.reviews.rating,
        text: schema.reviews.text,
        createdAt: schema.reviews.createdAt,
        authorDisplayName: schema.users.displayName,
        authorStatus: schema.users.status,
      })
      .from(schema.reviews)
      .innerJoin(schema.users, eq(schema.users.id, schema.reviews.userId))
      .where(
        and(eq(schema.reviews.placeId, placeId), eq(schema.reviews.status, PUBLIC_REVIEW_STATUS)),
      )
      // Newest first; two reviews written in the same instant break on id, so
      // two reads of the same data can never disagree about which three show.
      .orderBy(desc(schema.reviews.createdAt), desc(schema.reviews.id))
      .limit(PLACE_REVIEW_PREVIEW_LIMIT);

    // `source` is a fact, not decoration: these are GoGo community reviews and
    // never share a number with the provider rating on Place Detail (rule 14).
    return { source: 'gogo' as const, reviews: rows.map(toPublicReview) };
  }
}
