import { z } from 'zod';

/**
 * SG-009 (#48) — the boundary the AI proposal has to get through.
 *
 * The deterministic pipeline stays the source of truth. What comes back from a
 * parser is a *proposal*, and everything below decides how much of it survives:
 * schema first, then the allowlist, then the constraint rules. Anything that
 * fails is dropped with a reason code rather than silently ignored, because a
 * user who says "cheaper" and gets the same plan deserves to be told the
 * request was not understood.
 *
 * The two rules that matter most:
 *
 * - A proposal may only reference place ids that were already verified
 *   candidates. Nothing invents a place.
 * - A proposal may **tighten** a constraint, never loosen one. Feedback is
 *   allowed to narrow a search; it is not allowed to raise the budget the room
 *   agreed on, widen the radius past the host's setting, or add stops beyond
 *   the cap. AI never overrides a hard constraint.
 */
export const feedbackProposalSchema = z
  .object({
    excludePlaceIds: z.array(z.string()).max(20).default([]),
    avoidCategoryKeys: z.array(z.string().max(64)).max(10).default([]),
    requireDietaryKeys: z.array(z.string().max(64)).max(5).default([]),
    /** Percentages, so a proposal cannot name an absolute budget of its own. */
    tightenBudgetPercent: z.number().int().min(1).max(50).optional(),
    reduceRadiusPercent: z.number().int().min(1).max(80).optional(),
    maxStops: z.number().int().min(1).max(6).optional(),
  })
  .strict();

export type FeedbackProposal = z.infer<typeof feedbackProposalSchema>;

export const FEEDBACK_REASON_CODES = [
  'SCHEMA_INVALID',
  'PLACE_NOT_A_CANDIDATE',
  'CATEGORY_UNKNOWN',
  'DIETARY_UNKNOWN',
  'BUDGET_NOT_TIGHTENED',
  'RADIUS_NOT_REDUCED',
  'STOPS_NOT_REDUCED',
  'NOTHING_UNDERSTOOD',
] as const;
export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];

export type FeedbackContext = {
  allowedPlaceIds: string[];
  knownCategoryKeys: string[];
  knownDietaryKeys: string[];
  budgetAmount: number;
  radiusM: number | null;
  currentStopCount: number;
};

export type ValidatedFeedback = {
  applied: {
    excludePlaceIds: string[];
    avoidCategoryKeys: string[];
    requireDietaryKeys: string[];
    budgetMaxAmount?: number;
    radiusM?: number;
    maxStops?: number;
  };
  rejected: FeedbackReasonCode[];
  understood: boolean;
};

/**
 * Parses and validates one proposal. Never throws: an unusable proposal is a
 * result with reasons, because the caller's next step is the same either way —
 * run the deterministic pipeline and tell the user what was applied.
 */
export function validateFeedback(raw: unknown, context: FeedbackContext): ValidatedFeedback {
  const parsed = feedbackProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return { applied: empty(), rejected: ['SCHEMA_INVALID'], understood: false };
  }

  const proposal = parsed.data;
  const rejected = new Set<FeedbackReasonCode>();
  const allowed = new Set(context.allowedPlaceIds);

  const excludePlaceIds = proposal.excludePlaceIds.filter((id) => {
    if (allowed.has(id)) return true;
    // A place id that was never a candidate is the shape of a hallucination.
    rejected.add('PLACE_NOT_A_CANDIDATE');
    return false;
  });

  const avoidCategoryKeys = proposal.avoidCategoryKeys.filter((key) => {
    if (context.knownCategoryKeys.includes(key)) return true;
    rejected.add('CATEGORY_UNKNOWN');
    return false;
  });

  const requireDietaryKeys = proposal.requireDietaryKeys.filter((key) => {
    if (context.knownDietaryKeys.includes(key)) return true;
    rejected.add('DIETARY_UNKNOWN');
    return false;
  });

  const applied: ValidatedFeedback['applied'] = {
    excludePlaceIds,
    avoidCategoryKeys,
    requireDietaryKeys,
  };

  if (proposal.tightenBudgetPercent !== undefined) {
    const tightened = Math.floor(
      (context.budgetAmount * (100 - proposal.tightenBudgetPercent)) / 100,
    );
    // Integer minor units, and strictly below what the room agreed. Equal is
    // not tighter, and above would be the model raising the budget.
    if (tightened > 0 && tightened < context.budgetAmount) applied.budgetMaxAmount = tightened;
    else rejected.add('BUDGET_NOT_TIGHTENED');
  }

  if (proposal.reduceRadiusPercent !== undefined) {
    if (context.radiusM === null) rejected.add('RADIUS_NOT_REDUCED');
    else {
      const reduced = Math.floor((context.radiusM * (100 - proposal.reduceRadiusPercent)) / 100);
      if (reduced > 0 && reduced < context.radiusM) applied.radiusM = reduced;
      else rejected.add('RADIUS_NOT_REDUCED');
    }
  }

  if (proposal.maxStops !== undefined) {
    // Only ever fewer stops. "Make it shorter" is feedback; "make it longer"
    // is a plan edit, and goes through the host's own editing path.
    if (proposal.maxStops < context.currentStopCount) applied.maxStops = proposal.maxStops;
    else rejected.add('STOPS_NOT_REDUCED');
  }

  const understood =
    excludePlaceIds.length > 0 ||
    avoidCategoryKeys.length > 0 ||
    requireDietaryKeys.length > 0 ||
    applied.budgetMaxAmount !== undefined ||
    applied.radiusM !== undefined ||
    applied.maxStops !== undefined;

  if (!understood) rejected.add('NOTHING_UNDERSTOOD');

  return { applied, rejected: [...rejected], understood };
}

function empty(): ValidatedFeedback['applied'] {
  return { excludePlaceIds: [], avoidCategoryKeys: [], requireDietaryKeys: [] };
}
