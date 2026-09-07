import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { publicationOutcomeFor } from './place-approval';
import type { ApprovalBlock } from '../domain/approval-policy';

/**
 * ADM-009 (#462) — the approval invariant is shared, and provably so.
 *
 * The second test is the one that matters. A policy enforced by remembering to
 * call it is a policy that lasts until the next path someone adds, and this
 * task exists because exactly that had already happened once: the bulk import
 * published places without ever consulting it. So the set of files that can
 * write `status: 'published'` is asserted, and a new one fails the build until
 * somebody decides which side of the invariant it is on.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

describe('publicationOutcomeFor', () => {
  const block = (code: ApprovalBlock['code']): ApprovalBlock => ({ code, message: 'x' });

  it('publishes when nothing blocks', () => {
    expect(publicationOutcomeFor(null)).toBe('published');
  });

  it.each([
    ['MAPPING_UNMAPPED', 'deferred_mapping_unverified'],
    ['MAPPING_NOT_VERIFIED', 'deferred_mapping_unverified'],
    ['MAPPING_REJECTED', 'deferred_mapping_unverified'],
    ['MAPPING_STALE', 'deferred_mapping_invalid'],
    ['MAPPING_INCOMPLETE', 'deferred_mapping_invalid'],
    ['MAPPING_UNIT_NOT_CURRENT', 'deferred_mapping_invalid'],
    ['MAPPING_HIERARCHY_INVALID', 'deferred_mapping_invalid'],
    ['ADMINISTRATIVE_DATASET_UNAVAILABLE', 'deferred_no_active_dataset'],
  ] as const)('maps %s to %s', (code, outcome) => {
    // Three buckets, because they are three different things to do next:
    // publish a dataset, get somebody to verify, or fix a mapping that points
    // at a unit which no longer holds.
    expect(publicationOutcomeFor(block(code))).toBe(outcome);
  });
});

describe('every path that can set a place status', () => {
  /**
   * Each writer, and what makes it safe. `published` is the only status the
   * approval invariant governs; the others are listed so a new writer cannot be
   * added without someone deciding which of the two lists it belongs in.
   */
  const KNOWN: Record<string, string> = {
    'libs/modules/cms/application/cms-catalog.service.ts':
      'transitionPlace: any status, and calls assertPlaceApprovable before publishing',
    'libs/modules/ingestion/application/place-import-job.service.ts':
      'import: creates in draft/review, and settlePublication calls evaluatePlaceApproval',
    'libs/modules/places/application/place-import.service.ts':
      'link import: creates community_submitted, and calls evaluatePlaceApproval for autoPublish',
    'libs/modules/ingestion/application/place-submission.service.ts':
      'community submission: creates community_submitted, never published',
    'libs/modules/ingestion/application/place-refresh.service.ts':
      'freshness: moves a place to review, never published',
    'libs/modules/cms/application/emergency-takedown.service.ts':
      'takedown: moves a place to suspended, never published',
    'libs/database/src/seed.ts':
      'development fixture: builds a database directly, never a product write path (ADR-0019 §7)',
  };

  function writers(): string[] {
    const candidates = execFileSync(
      'grep',
      [
        '-rlE',
        String.raw`(insert|update)\(schema\.places\)|update places set`,
        '--include=*.ts',
        'libs',
        'apps',
        'scripts',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((file) => !file.endsWith('.spec.ts'));

    // Of those, the ones that write a *place* status — the literals from the
    // `place_status` enum, or `transitionPlace`'s variable. Deliberately not
    // "anything with `status` in it": the moderation service writes
    // `administrative_mapping_status` on the same table and is not a writer of
    // the column this invariant governs.
    const placeStatus =
      /status: ('(draft|community_submitted|review|published|suspended|archived)'|to\b|autoPublish)/;
    return candidates
      .filter((file) => {
        const source = readFileSync(path.join(repoRoot, file), 'utf8');
        return placeStatus.test(source) || /set status = '/.test(source);
      })
      .sort();
  }

  it('is one of the known writers, each accounted for', () => {
    // A policy enforced by remembering to call it lasts until the next path
    // somebody adds — which is exactly what happened here once already, when
    // bulk import published places without ever consulting the invariant.
    expect(writers()).toEqual(Object.keys(KNOWN).sort());
  });

  it('routes every publishing path through the shared guard', () => {
    const publishers = [
      'libs/modules/cms/application/cms-catalog.service.ts',
      'libs/modules/ingestion/application/place-import-job.service.ts',
      'libs/modules/places/application/place-import.service.ts',
    ];
    for (const file of publishers) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source, `${file} must consult the shared approval guard`).toMatch(
        /assertPlaceApprovable|evaluatePlaceApproval/,
      );
    }
  });

  it('does not define the policy twice', () => {
    // `approvalBlock` is the policy itself. Only the shared guard and the
    // moderation read model may call it; everything else goes through them.
    const callers = execFileSync(
      'grep',
      ['-rl', 'approvalBlock(', '--include=*.ts', 'libs', 'apps'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((file) => !file.endsWith('.spec.ts'))
      .sort();
    expect(callers).toEqual(
      [
        'libs/modules/administrative/application/administrative-moderation.service.ts',
        'libs/modules/administrative/application/place-approval.ts',
        'libs/modules/administrative/domain/approval-policy.ts',
      ].sort(),
    );
  });
});
