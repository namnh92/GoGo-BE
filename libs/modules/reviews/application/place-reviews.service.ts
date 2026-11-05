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
import { loadGogoRatings } from '../infrastructure/gogo-ratings';

export const PLACE_REVIEW_PAGE_MAX = 20;

type ReviewCursor = {
  order: ReviewOrder;
  helpfulCount: number;
  createdAt: string;
  id: string;
};

const REVIEW_CURSOR_TIMESTAMP =
  /^(?!0000-)(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?Z$/;

function isValidReviewCursorTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = REVIEW_CURSOR_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  // Check calendar reality without normalizing the timestamp text: a JS Date
  // would discard the final three digits of the PostgreSQL microseconds.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);

  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

export function encodeReviewCursor(cursor: ReviewCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeReviewCursor(value: string, order: ReviewOrder): ReviewCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('bad');
    }
    const cursor = decoded as Record<string, unknown>;
    if (
      cursor.order !== order ||
      typeof cursor.helpfulCount !== 'number' ||
      !Number.isInteger(cursor.helpfulCount) ||
      cursor.helpfulCount < 0 ||
      !isValidReviewCursorTimestamp(cursor.createdAt) ||
      typeof cursor.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id)
    ) {
      throw new Error('bad');
    }
    return {
      order,
      helpfulCount: cursor.helpfulCount,
      createdAt: cursor.createdAt,
      id: cursor.id,
    };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid for this review order');
  }
}

export function shapeReviewPage<T>(items: T[], includeItems: boolean) {
  return {
    reviews: items.slice(0, PLACE_REVIEW_PREVIEW_LIMIT),
    ...(includeItems ? { items } : {}),
  };
}

/**
 * BE-BFF-018 (#570) — the latest published GoGo reviews of one place.
 * BE-BFF-019 (#571) — or the most helpful ones (ADR-0026, PROPOSAL).
 */
@Injectable()
export class PlaceReviewsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async preview(
    placeId: string,
    order: ReviewOrder = 'latest',
    options: { cursor?: string | undefined; limit?: number | undefined } = {},
  ) {
    const [place] = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(
        and(eq(schema.places.id, placeId), inArray(schema.places.status, READABLE_PLACE_STATUSES)),
      )
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    const limit = Math.min(options.limit ?? PLACE_REVIEW_PREVIEW_LIMIT, PLACE_REVIEW_PAGE_MAX);
    const cursor = options.cursor ? decodeReviewCursor(options.cursor, order) : undefined;

    // Derived, never stored: a count cannot disagree with the rows it counts.
    const helpfulCount = sql<number>`(
      select count(*)::int from ${schema.reviewReactions} rr
      where rr.review_id = ${schema.reviews.id} and rr.type = 'helpful'
    )`.mapWith(Number);

    // A badge means an approved GoGo check-in exists for this author at this
    // place. Publishing the review alone is content moderation, not proof of a
    // visit, and therefore deliberately does not set this fact.
    const verifiedVisit = sql<boolean>`exists (
      select 1
      from ${schema.stopCheckins} sc
      join ${schema.roomMembers} rm on rm.id = sc.member_id
      join ${schema.planStops} ps on ps.id = sc.plan_stop_id
      where rm.user_id = ${schema.reviews.userId}
        and ps.place_id = ${schema.reviews.placeId}
        and sc.moderation = 'approved'
    )`;

    // PostgreSQL stores six fractional digits, while Drizzle maps timestamptz
    // to a JavaScript Date with only three. Select the cursor value separately
    // so a page boundary never rounds reviews on opposite sides of a
    // sub-millisecond instant onto the same timestamp.
    const cursorCreatedAt = sql<string>`to_char(
      ${schema.reviews.createdAt} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )`;

    const cursorCondition = cursor
      ? order === 'helpful'
        ? sql`(${helpfulCount}, ${schema.reviews.createdAt}, ${schema.reviews.id}) <
            (${cursor.helpfulCount}, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : sql`(${schema.reviews.createdAt}, ${schema.reviews.id}) <
            (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : undefined;

    const rows = await this.db
      .select({
        id: schema.reviews.id,
        rating: schema.reviews.rating,
        text: schema.reviews.text,
        createdAt: schema.reviews.createdAt,
        authorDisplayName: schema.users.displayName,
        authorStatus: schema.users.status,
        helpfulCount,
        verifiedVisit,
        cursorCreatedAt,
      })
      .from(schema.reviews)
      .innerJoin(schema.users, eq(schema.users.id, schema.reviews.userId))
      .where(
        and(
          eq(schema.reviews.placeId, placeId),
          eq(schema.reviews.status, PUBLIC_REVIEW_STATUS),
          cursorCondition,
        ),
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
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const ratings = await loadGogoRatings(this.db, [placeId]);
    const publicReviews = page.map((row) => toPublicReview(row));

    // `source` is a fact, not decoration: these are GoGo community reviews and
    // never share a number with the provider rating on Place Detail (rule 14).
    return {
      source: 'gogo' as const,
      order,
      ...ratings.get(placeId)!,
      ...shapeReviewPage(
        publicReviews,
        options.cursor !== undefined || options.limit !== undefined,
      ),
      nextCursor:
        rows.length > limit && last
          ? encodeReviewCursor({
              order,
              helpfulCount: last.helpfulCount,
              createdAt: last.cursorCreatedAt,
              id: last.id,
            })
          : null,
    };
  }
}
