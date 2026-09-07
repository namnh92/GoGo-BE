import { describe, expect, it } from 'vitest';
import {
  approvalBlock,
  remediationCategory,
  type ActiveCommune,
  type MappingUnderApproval,
} from './approval-policy';

/**
 * ADM-009 (#462) — the approval invariant.
 *
 * The case worth guarding hardest is the one that looks like a bug and is the
 * whole design: a mapping verified against an older dataset version, whose
 * commune still exists and still sits under the same province, **approves**.
 * Requiring the version string to match would un-approve the entire catalogue
 * on every publication and demand it be re-verified by hand — which is not a
 * stricter policy, it is an unusable one.
 */

const ACTIVE = 'v5.0.0+v2.4.1+7fac8c45+none+r0';
const OLDER = 'v4.9.0+v2.4.1+7fac8c45+none+r0';

const commune: ActiveCommune = {
  code: '00004',
  parentCode: '01',
  status: 'ACTIVE',
  effectiveTo: null,
};

const verified = (over: Partial<MappingUnderApproval> = {}): MappingUnderApproval => ({
  status: 'VERIFIED',
  provinceCode: '01',
  communeCode: '00004',
  datasetVersion: ACTIVE,
  ...over,
});

describe('what approves', () => {
  it('a verified mapping whose identity is still valid', () => {
    expect(approvalBlock(verified(), ACTIVE, commune)).toBeNull();
  });

  it('a verified mapping stamped with an older version, identity unchanged', () => {
    // The mapping that survived a publication is still the mapping that person
    // verified. The version is provenance, not a gate.
    expect(approvalBlock(verified({ datasetVersion: OLDER }), ACTIVE, commune)).toBeNull();
  });
});

describe('what blocks', () => {
  it.each([
    ['UNMAPPED', 'MAPPING_UNMAPPED'],
    ['AUTO_MATCHED', 'MAPPING_NOT_VERIFIED'],
    ['NEEDS_REVIEW', 'MAPPING_NOT_VERIFIED'],
    ['REJECTED', 'MAPPING_REJECTED'],
    ['STALE', 'MAPPING_STALE'],
  ] as const)('%s blocks with %s', (status, code) => {
    expect(approvalBlock(verified({ status }), ACTIVE, commune)?.code).toBe(code);
  });

  it('says why AUTO_MATCHED is not enough, in words a reviewer can act on', () => {
    const block = approvalBlock(verified({ status: 'AUTO_MATCHED' }), ACTIVE, commune);
    expect(block?.message).toContain('a resolver result, not an approval');
  });

  it('blocks a verified mapping missing half its hierarchy', () => {
    expect(approvalBlock(verified({ communeCode: null }), ACTIVE, commune)?.code).toBe(
      'MAPPING_INCOMPLETE',
    );
  });

  it('blocks when the commune is gone from the active dataset', () => {
    expect(approvalBlock(verified(), ACTIVE, null)?.code).toBe('MAPPING_UNIT_NOT_CURRENT');
  });

  it('blocks when the code now names an ended period', () => {
    // 00004 is Phường Trúc Bạch until 2025-06-30 and Phường Ba Đình after. A
    // stored code pointing at the ended period is not a current address.
    const ended: ActiveCommune = { ...commune!, status: 'INACTIVE', effectiveTo: '2025-06-30' };
    expect(approvalBlock(verified(), ACTIVE, ended)?.code).toBe('MAPPING_UNIT_NOT_CURRENT');
  });

  it('blocks when the commune no longer sits under the stored province', () => {
    const moved: ActiveCommune = { ...commune!, parentCode: '79' };
    const block = approvalBlock(verified(), ACTIVE, moved);
    expect(block?.code).toBe('MAPPING_HIERARCHY_INVALID');
    expect(block?.message).toContain('79');
  });
});

describe('remediation categories', () => {
  it.each([
    ['UNMAPPED', 'unmapped'],
    ['AUTO_MATCHED', 'auto_matched'],
    ['NEEDS_REVIEW', 'needs_review'],
    ['REJECTED', 'rejected'],
    ['STALE', 'stale'],
  ] as const)('%s is reported as %s', (status, category) => {
    expect(remediationCategory(verified({ status }), ACTIVE)).toBe(category);
  });

  it('separates a current verification from one made against an older version', () => {
    expect(remediationCategory(verified(), ACTIVE)).toBe('compliant');
    expect(remediationCategory(verified({ datasetVersion: OLDER }), ACTIVE)).toBe(
      'verified_against_older_version',
    );
  });

  it('reports rather than blocks: the older-version category still approves', () => {
    // The two answers are deliberately different. One is "would this pass the
    // gate today" — it would. The other is "is this worth a second look".
    const mapping = verified({ datasetVersion: OLDER });
    expect(remediationCategory(mapping, ACTIVE)).toBe('verified_against_older_version');
    expect(approvalBlock(mapping, ACTIVE, commune)).toBeNull();
  });
});
