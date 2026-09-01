import { familyForGoogleType } from './google-types';
import { nameSimilarity } from './match-score';

/**
 * BE-IMP-004 — has this provider place become a *different business*?
 *
 * The question matters because re-importing takes the provider's fresh facts
 * (ADR-0006 §8). That is right when a shop is renamed or moves next door. It is
 * wrong when the shop changed hands: the new name arrives while GoGo's own
 * editorial content — highlight, curated price, category, and the reviews and
 * saved-places pointing at that row — still describes the business that left.
 *
 * Name similarity alone was measured against real Vietnamese rename cases and
 * is not good enough to gate on:
 *
 *   0.60  Highlands Coffee Nguyễn Huệ → The Coffee House Nguyễn Huệ   (new owner)
 *   0.50  Nhà Hàng Sen Việt → Karaoke Sen Việt                        (new business)
 *   0.00  Cà Phê Sài Gòn → Saigon Coffee House                        (same owner)
 *
 * Shared address and category tokens inflate the score exactly where the answer
 * should be "different business", and a Vietnamese→English rebrand scores zero
 * where the answer is "same". So similarity is one input among several, and only
 * a very low score counts on its own.
 *
 * Nothing here rejects a row. A signal means "a human decides", never "discard".
 */

/** Below this, the two names share almost nothing — under the observed cluster. */
export const NAME_CHANGE_THRESHOLD = 0.3;

/**
 * Google resets the review count for a genuinely new business, so a sharp drop
 * is the strongest signal available. The floor avoids firing on places with a
 * handful of reviews, where normal moderation churn looks like a collapse.
 */
export const RATING_COUNT_FLOOR = 20;
export const RATING_COUNT_DROP_RATIO = 0.5;

export type IdentitySnapshot = {
  name: string;
  ratingCount: number | null;
  primaryType: string | null;
  businessStatus?: string | undefined;
};

export type IdentityChangeReason =
  | 'BUSINESS_CLOSED_PERMANENTLY'
  | 'RATING_COUNT_RESET'
  | 'PRIMARY_TYPE_CHANGED'
  | 'NAME_UNRECOGNISABLE';

export type IdentityVerdict = {
  changed: boolean;
  reasons: IdentityChangeReason[];
  nameSimilarity: number;
};

export function detectIdentityChange(
  before: IdentitySnapshot,
  after: IdentitySnapshot,
): IdentityVerdict {
  const reasons: IdentityChangeReason[] = [];
  const similarity = nameSimilarity(before.name, after.name);

  if (after.businessStatus === 'CLOSED_PERMANENTLY') {
    reasons.push('BUSINESS_CLOSED_PERMANENTLY');
  }

  if (
    before.ratingCount !== null &&
    after.ratingCount !== null &&
    before.ratingCount >= RATING_COUNT_FLOOR &&
    after.ratingCount < before.ratingCount * RATING_COUNT_DROP_RATIO
  ) {
    reasons.push('RATING_COUNT_RESET');
  }

  // Only compare types we can actually interpret. An unmapped type means "we
  // cannot tell", which must not be reported as "it changed".
  const beforeFamily = familyForGoogleType(before.primaryType);
  const afterFamily = familyForGoogleType(after.primaryType);
  if (beforeFamily && afterFamily && beforeFamily !== afterFamily) {
    reasons.push('PRIMARY_TYPE_CHANGED');
  }

  if (similarity < NAME_CHANGE_THRESHOLD) reasons.push('NAME_UNRECOGNISABLE');

  return { changed: reasons.length > 0, reasons, nameSimilarity: similarity };
}
