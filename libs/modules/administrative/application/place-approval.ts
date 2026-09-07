import { and, desc, eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { approvalBlock, type ApprovalBlock } from '../domain/approval-policy';
import type { MappingStatus } from '../domain/mapping-status';

/**
 * ADM-009 (#462) / ADR-0019 §7 — the one place the approval invariant lives.
 *
 * It is a module of functions rather than an injectable service on purpose.
 * Three different modules publish places — the CMS transition, the CMS bulk
 * import, and the provider link import — and they live in three different Nest
 * modules with three different provider graphs. A service would have to be
 * wired into all of them and would still be skippable by the next path someone
 * adds; a function that takes the transaction is available everywhere,
 * including from a script, and has nothing to forget to inject.
 *
 * The rule it enforces is one sentence: **a place may become `published` only
 * when a person verified its administrative mapping and that mapping is still
 * materially valid against the dataset that is active right now.** None of the
 * following is a substitute, and each of them was at some point a tempting one:
 * a trusted import source, official codes supplied in a file, an `AUTO_MATCHED`
 * resolver result, a successful boundary containment, an import row an operator
 * ticked, the operator's own role, or the import mode being called
 * `publish_approved`.
 *
 * Every caller passes the transaction that performs the publish, so the check
 * and the write cannot be separated by a dataset publication, a mapping
 * rejection or another reviewer.
 */

export type ApprovalSubject = {
  id: string;
  administrativeMappingStatus: MappingStatus;
  provinceCode: string | null;
  communeCode: string | null;
  administrativeDatasetVersion: string | null;
};

type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Returns why this place may not be published, or null.
 *
 * Non-throwing, because bulk paths must be able to defer a row rather than fail
 * an import: "this one is waiting on verification" is a result, not an error.
 */
export async function evaluatePlaceApproval(
  executor: Executor,
  place: ApprovalSubject,
  /**
   * Optional so the guard stays a function anyone can call. When it is given,
   * every approval decision is counted by its closed-set reason — which is the
   * number an operator watches to see whether the policy is blocking work or
   * catching it.
   */
  metrics?: MetricsPort,
): Promise<ApprovalBlock | null> {
  const [dataset] = await (executor as Db)
    .select({
      id: schema.administrativeDatasetVersions.id,
      version: schema.administrativeDatasetVersions.combinedDatasetVersion,
    })
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
    .limit(1);
  if (!dataset) {
    return {
      code: 'ADMINISTRATIVE_DATASET_UNAVAILABLE',
      message: 'no administrative dataset is published, so no mapping can be validated against one',
    };
  }

  // The stored code is read back at its latest effective period: a code is not
  // an identity, and the row that matters is the one in force now.
  const [commune] = place.communeCode
    ? await (executor as Db)
        .select({
          code: schema.administrativeUnits.code,
          parentCode: schema.administrativeUnits.parentCode,
          status: schema.administrativeUnits.status,
          effectiveTo: schema.administrativeUnits.effectiveTo,
        })
        .from(schema.administrativeUnits)
        .where(
          and(
            eq(schema.administrativeUnits.datasetVersionId, dataset.id),
            eq(schema.administrativeUnits.code, place.communeCode),
            eq(schema.administrativeUnits.level, 'COMMUNE'),
          ),
        )
        .orderBy(desc(schema.administrativeUnits.effectiveFrom))
        .limit(1)
    : [];

  const block = approvalBlock(
    {
      status: place.administrativeMappingStatus,
      provinceCode: place.provinceCode,
      communeCode: place.communeCode,
      datasetVersion: place.administrativeDatasetVersion,
    },
    dataset.version,
    commune ?? null,
  );
  count(metrics, block);
  return block;
}

function count(metrics: MetricsPort | undefined, block: ApprovalBlock | null): void {
  metrics?.increment('place_approval_checks_total', {
    result: block ? 'blocked' : 'allowed',
    // The closed `ApprovalBlockCode` enum, never a message: an error string is
    // operator free text wearing the clothes of a label.
    reason: block?.code ?? 'none',
  });
}

/** The throwing form, for paths where refusing to publish is the right answer. */
export async function assertPlaceApprovable(
  executor: Executor,
  place: ApprovalSubject,
  metrics?: MetricsPort,
): Promise<void> {
  const block = await evaluatePlaceApproval(executor, place, metrics);
  if (block) throw AppError.conflict(block.code, block.message);
}

/** How a deferred publication is recorded on the import row that asked for it. */
export type PublicationOutcome =
  | 'published'
  | 'deferred_mapping_unverified'
  | 'deferred_mapping_invalid'
  | 'deferred_no_active_dataset';

/**
 * Which deferral this block is.
 *
 * The three buckets are the three different things an operator has to do next:
 * publish a dataset, get somebody to verify the mapping, or fix a mapping that
 * points at a unit that no longer holds.
 */
export function publicationOutcomeFor(block: ApprovalBlock | null): PublicationOutcome {
  if (!block) return 'published';
  if (block.code === 'ADMINISTRATIVE_DATASET_UNAVAILABLE') return 'deferred_no_active_dataset';
  if (
    block.code === 'MAPPING_UNMAPPED' ||
    block.code === 'MAPPING_NOT_VERIFIED' ||
    block.code === 'MAPPING_REJECTED'
  ) {
    return 'deferred_mapping_unverified';
  }
  return 'deferred_mapping_invalid';
}
