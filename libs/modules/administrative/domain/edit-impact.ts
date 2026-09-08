import type { MappingStatus } from './mapping-status';
import type { Resolution } from './resolver';

/**
 * ADM-016 / ADR-0019 §7 — what an ordinary place edit may do to the mapping
 * that place already carries.
 *
 * Editing a place is not moderating it. An editor fixing a phone number, or
 * dragging a pin two doors down the street, is not ruling on an administrative
 * question — so an edit must never quietly become a decision. But an edit *can*
 * make an existing decision untrue, and pretending otherwise leaves a published
 * place claiming a commune it is no longer in.
 *
 * Three answers, by who owns the mapping now:
 *
 * - **RESOLVE** — nobody owns it. `UNMAPPED`, `AUTO_MATCHED`, `NEEDS_REVIEW`
 *   and `STALE` are all machine states, and the machine is allowed to correct
 *   itself. The transition matrix still has the final say on the write.
 * - **STALE_IF_CONTRADICTED** — a reviewer verified it. The edit may not
 *   re-point it and may not overwrite it; what it may do is say the mapping no
 *   longer matches the place, which is what `STALE` means and what stops the
 *   place being published on a verification that is no longer true.
 * - **PROTECTED** — a reviewer rejected it. A rejection is a judgement that
 *   this place should not carry this mapping, and an edit is not an appeal.
 *   Reopening it takes an explicit rematch, which lives in moderation.
 */

export type MappingEditPolicy = 'RESOLVE' | 'STALE_IF_CONTRADICTED' | 'PROTECTED';

export function editPolicyFor(status: MappingStatus): MappingEditPolicy {
  switch (status) {
    case 'VERIFIED':
      return 'STALE_IF_CONTRADICTED';
    case 'REJECTED':
      return 'PROTECTED';
    default:
      return 'RESOLVE';
  }
}

export type StoredPair = { provinceCode: string | null; communeCode: string | null };

/**
 * Does what the resolver now says actually **contradict** the stored pair?
 *
 * Only a positive, deterministic answer counts. `NEEDS_REVIEW` means the
 * evidence disagrees with itself, and `UNMAPPED` means there is none — neither
 * is a reason to demote a person's decision, because in both cases the verified
 * codes may still be exactly right. Treating "I don't know" as a contradiction
 * would empty the verified catalogue every time a boundary release lost a
 * polygon.
 */
export function contradictsStoredMapping(stored: StoredPair, machine: Resolution): boolean {
  if (machine.status !== 'AUTO_MATCHED') return false;
  if (machine.provinceCode === null || machine.communeCode === null) return false;
  return machine.provinceCode !== stored.provinceCode || machine.communeCode !== stored.communeCode;
}

/**
 * Is there anything new for the resolver to look at?
 *
 * The resolver reads exactly two things off a request: the place's geometry and
 * whatever codes the request asserted (ADR-0019 §7b). An edit that touched
 * neither cannot produce a different answer, so re-running it would be a
 * point-in-polygon query bought for a phone number.
 *
 * `city` and `district` were listed here, back when the resolver read them. An
 * edit to a legacy free-text field must not re-open an administrative question
 * it can no longer influence.
 */
export function isMaterialForMapping(input: {
  geometryMoved: boolean;
  codesAsserted: boolean;
}): boolean {
  return input.geometryMoved || input.codesAsserted;
}
