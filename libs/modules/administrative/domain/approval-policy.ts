import type { MappingStatus } from './mapping-status';

/**
 * ADM-009 (#462) / ADR-0019 §7 — whether a place's administrative mapping
 * permits approving the place.
 *
 * One sentence decides it: **a place may be newly approved only when a person
 * verified its mapping and that mapping is still materially valid against the
 * dataset that is active now.** `AUTO_MATCHED` is the resolver's answer, not a
 * human's, and the whole point of a review queue is that the machine's answer
 * is not the decision.
 *
 * "Still materially valid" is doing real work here, and it is not the same as
 * "verified against the current version string". Every publication mints a new
 * combined version; if the stored version had to match, every publication would
 * un-approve the entire catalogue and demand it be re-verified by hand. So the
 * test is on the identity — does this commune still exist, is it still current,
 * does it still sit under this province — and the version the reviewer worked
 * against is kept as provenance rather than as a gate. A mapping that survived
 * a publication unchanged is still the mapping that person verified.
 */

export type ApprovalBlockCode =
  /** There is no active dataset to validate anything against. */
  | 'ADMINISTRATIVE_DATASET_UNAVAILABLE'
  | 'MAPPING_UNMAPPED'
  | 'MAPPING_NOT_VERIFIED'
  | 'MAPPING_REJECTED'
  | 'MAPPING_STALE'
  | 'MAPPING_INCOMPLETE'
  | 'MAPPING_UNIT_NOT_CURRENT'
  | 'MAPPING_HIERARCHY_INVALID';

export type ApprovalBlock = { code: ApprovalBlockCode; message: string };

export type MappingUnderApproval = {
  status: MappingStatus;
  provinceCode: string | null;
  communeCode: string | null;
  datasetVersion: string | null;
};

/** The stored commune, looked up in the **active** dataset. Null means gone. */
export type ActiveCommune = {
  code: string;
  parentCode: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'FUTURE';
  effectiveTo: string | null;
} | null;

export function approvalBlock(
  mapping: MappingUnderApproval,
  activeDatasetVersion: string,
  commune: ActiveCommune,
): ApprovalBlock | null {
  switch (mapping.status) {
    case 'UNMAPPED':
      return {
        code: 'MAPPING_UNMAPPED',
        message: 'this place has no administrative mapping; resolve and verify one first',
      };
    case 'REJECTED':
      return {
        code: 'MAPPING_REJECTED',
        message: 'a reviewer rejected this administrative mapping; request a rematch first',
      };
    case 'STALE':
      return {
        code: 'MAPPING_STALE',
        message:
          'this mapping is no longer valid against the active administrative dataset; ' +
          're-verify it first',
      };
    case 'AUTO_MATCHED':
    case 'NEEDS_REVIEW':
      return {
        code: 'MAPPING_NOT_VERIFIED',
        message:
          `the administrative mapping is ${mapping.status}: a resolver result, not an approval. ` +
          'A reviewer must verify it first',
      };
    case 'VERIFIED':
      break;
  }

  if (!mapping.provinceCode || !mapping.communeCode) {
    return {
      code: 'MAPPING_INCOMPLETE',
      message: 'a verified mapping must carry both a province and a commune code',
    };
  }
  // Re-checked against the dataset that is active at commit time, never against
  // what the reviewer's screen said. A publication between the two is exactly
  // the race this exists for.
  if (!commune || commune.status !== 'ACTIVE' || commune.effectiveTo !== null) {
    return {
      code: 'MAPPING_UNIT_NOT_CURRENT',
      message:
        `commune ${mapping.communeCode} is not a current unit in ${activeDatasetVersion}; ` +
        're-verify the mapping against the active dataset',
    };
  }
  if (commune.parentCode !== mapping.provinceCode) {
    return {
      code: 'MAPPING_HIERARCHY_INVALID',
      message:
        `commune ${mapping.communeCode} belongs to province ${commune.parentCode ?? 'none'}, ` +
        `not to the mapped ${mapping.provinceCode}`,
    };
  }
  return null;
}

/**
 * Why an already-approved place would not pass the policy today.
 *
 * Reporting, never enforcement. These places were approved before the policy
 * existed and un-approving them would take a working catalogue off the air to
 * satisfy a rule written after it was built — so they are counted, listed, and
 * left alone for someone to work through.
 */
export type RemediationCategory =
  | 'unmapped'
  | 'auto_matched'
  | 'needs_review'
  | 'rejected'
  | 'stale'
  | 'verified_against_older_version'
  | 'compliant';

export function remediationCategory(
  mapping: MappingUnderApproval,
  activeDatasetVersion: string,
): RemediationCategory {
  switch (mapping.status) {
    case 'UNMAPPED':
      return 'unmapped';
    case 'AUTO_MATCHED':
      return 'auto_matched';
    case 'NEEDS_REVIEW':
      return 'needs_review';
    case 'REJECTED':
      return 'rejected';
    case 'STALE':
      return 'stale';
    case 'VERIFIED':
      // Not a defect: the identity is what matters and it is checked at
      // approval time. Reported because "who verified this, and against what"
      // is the question a reviewer asks when deciding whether to look again.
      return mapping.datasetVersion === activeDatasetVersion
        ? 'compliant'
        : 'verified_against_older_version';
  }
}
