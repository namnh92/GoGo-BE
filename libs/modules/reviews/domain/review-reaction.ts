import { PUBLIC_REVIEW_STATUS } from './public-review';

/**
 * ADR-0026 (BE-BFF-019, #571, PROPOSAL) — whether a person may react to a review.
 *
 * `review` is what the lookup found on a readable place, or nothing. Anything
 * that is not published answers exactly like a review that does not exist, so
 * the reaction route cannot be used to probe moderation state. Reacting to your
 * own review is refused: counting your own review helpful is not a signal.
 */
export type ReactionRefusal = 'REVIEW_NOT_FOUND' | 'OWN_REVIEW';

export function reactionRefusal(
  review: { userId: string; status: string } | undefined,
  actorUserId: string,
): ReactionRefusal | null {
  if (!review || review.status !== PUBLIC_REVIEW_STATUS) return 'REVIEW_NOT_FOUND';
  if (review.userId === actorUserId) return 'OWN_REVIEW';
  return null;
}
