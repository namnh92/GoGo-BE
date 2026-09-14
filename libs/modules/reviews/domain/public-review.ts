/**
 * BE-BFF-018 (#570) — what anyone may read about a GoGo review.
 *
 * A review becomes public only through a moderator's `published` verdict.
 * `pending` and `rejected` never were public, `removed` is a moderator taking
 * it back, and `hidden` is the SEC-001 emergency takedown — none of them may
 * surface on a place, whatever order they would sort into.
 *
 * The author is reduced to the one thing they chose to show other people: a
 * display name. No user id, no email, no avatar — ADR-0022 made a picture
 * public to the rooms a person joins, not to every stranger reading a place.
 * A deleted account keeps its reviews (ADR-0023) but loses its name, so the
 * contract answers `null` and the client renders its own label for it.
 */
export const PLACE_REVIEW_PREVIEW_LIMIT = 3;

export const PUBLIC_REVIEW_STATUS = 'published' as const;

export type PublicReviewRow = {
  id: string;
  rating: number;
  text: string | null;
  createdAt: Date;
  authorDisplayName: string;
  authorStatus: 'active' | 'suspended' | 'banned' | 'deleted';
};

export type PublicReview = {
  id: string;
  rating: number;
  text?: string;
  createdAt: string;
  author: { displayName: string | null };
};

export function toPublicReview(row: PublicReviewRow): PublicReview {
  return {
    id: row.id,
    rating: row.rating,
    ...(row.text?.trim() ? { text: row.text } : {}),
    createdAt: row.createdAt.toISOString(),
    author: { displayName: row.authorStatus === 'deleted' ? null : row.authorDisplayName },
  };
}
