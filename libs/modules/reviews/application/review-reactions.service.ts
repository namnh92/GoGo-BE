import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { PUBLIC_REVIEW_STATUS, READABLE_PLACE_STATUSES } from '../domain/public-review';
import { reactionRefusal } from '../domain/review-reaction';
import { requireUser } from './user-content.service';

/** BE-BFF-019 (#571) — one `helpful` reaction per person per review (ADR-0026, PROPOSAL). */
@Injectable()
export class ReviewReactionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Idempotent in both directions: the primary key makes a second add a no-op
   * and a second remove deletes nothing, so a double tap or a retried request
   * lands on the same state. The count is read after the write, in the same
   * transaction, so the answer is the state this request produced.
   */
  async set(actor: Actor, reviewId: string, reacted: boolean) {
    const userId = requireUser(actor);
    return this.db.transaction(async (tx) => {
      const [review] = await tx
        .select({ userId: schema.reviews.userId, status: schema.reviews.status })
        .from(schema.reviews)
        .innerJoin(schema.places, eq(schema.places.id, schema.reviews.placeId))
        .where(
          and(
            eq(schema.reviews.id, reviewId),
            inArray(schema.places.status, READABLE_PLACE_STATUSES),
          ),
        )
        .limit(1);

      const refusal = reactionRefusal(review, userId);
      if (refusal === 'REVIEW_NOT_FOUND') {
        throw AppError.notFound('REVIEW_NOT_FOUND', 'Review not found');
      }
      if (refusal === 'OWN_REVIEW') {
        throw AppError.forbidden('OWN_REVIEW', 'You cannot react to your own review');
      }

      if (reacted) {
        await tx
          .insert(schema.reviewReactions)
          .values({ reviewId, userId, type: 'helpful' })
          .onConflictDoNothing();
      } else {
        await tx
          .delete(schema.reviewReactions)
          .where(
            and(
              eq(schema.reviewReactions.reviewId, reviewId),
              eq(schema.reviewReactions.userId, userId),
              eq(schema.reviewReactions.type, 'helpful'),
            ),
          );
      }

      const [counted] = await tx
        .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(schema.reviewReactions)
        .where(
          and(
            eq(schema.reviewReactions.reviewId, reviewId),
            eq(schema.reviewReactions.type, 'helpful'),
          ),
        );
      return { reviewId, helpfulCount: counted?.n ?? 0, reactedByMe: reacted };
    });
  }

  /**
   * The caller's own reactions on one place's published reviews — how a client
   * shows its toggle state without the public list ever naming a reactor.
   */
  async mine(actor: Actor, placeId: string) {
    const userId = requireUser(actor);
    const rows = await this.db
      .select({ reviewId: schema.reviewReactions.reviewId })
      .from(schema.reviewReactions)
      .innerJoin(schema.reviews, eq(schema.reviews.id, schema.reviewReactions.reviewId))
      .where(
        and(
          eq(schema.reviewReactions.userId, userId),
          eq(schema.reviewReactions.type, 'helpful'),
          eq(schema.reviews.placeId, placeId),
          eq(schema.reviews.status, PUBLIC_REVIEW_STATUS),
        ),
      )
      .orderBy(desc(schema.reviewReactions.createdAt));
    return { placeId, helpful: rows.map((row) => row.reviewId) };
  }
}
