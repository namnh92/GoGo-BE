import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import {
  approvalBlock,
  blocksApproval,
  isActionable,
  remediationCategory,
  type ApprovalBlock,
  type RemediationCategory,
} from '../domain/approval-policy';
import type { MappingStatus } from '../domain/mapping-status';
import type { StaleVerdict } from '../domain/staleness';
import type { Candidate, Evidence, ResolverReason } from '../domain/resolver';
import { AdministrativeResolverService } from './administrative-resolver.service';
import {
  assertCurrentPair,
  currentUnit as currentUnitOf,
  legacyDistrictUnit,
  type Executor,
} from './unit-lookup';

/**
 * ADM-009 (#462) / ADR-0019 §7 — administrative mapping moderation.
 *
 * This is where a person enters the picture. Everything before it was the
 * machine's: the resolver proposes, the backfill applies at scale, and neither
 * may write `VERIFIED` — because `VERIFIED` means somebody looked. This service
 * is the only path that writes it, the only path that may reopen a `REJECTED`
 * mapping, and the only path that may correct one a reviewer already verified.
 *
 * Two rules run through all of it.
 *
 * **Every decision is re-validated inside its own write transaction.** The row
 * is re-read `FOR UPDATE`, the dataset is re-read, the hierarchy is re-checked,
 * and `expectedUpdatedAt` must still hold. A reviewer's screen is a photograph
 * of a moment; between that moment and the click a dataset can publish, another
 * reviewer can decide, and a backfill can run.
 *
 * **Reviewer identity follows the decision.** `administrative_mapped_by` names
 * who is responsible for the mapping the row carries now — set on verification,
 * kept when a stale mapping is flagged (the verification was real, it is merely
 * no longer current), and cleared when a rematch replaces the decision with a
 * machine one. The audit log keeps everyone who ever touched it.
 */

export type ModerationActor = { id: string; role: string };

export type MappingDetail = {
  placeId: string;
  place: {
    name: string;
    status: string;
    /** ADR-0016: the address as written. Read here, never rewritten. */
    addressText: string | null;
    city: string | null;
    district: string | null;
    geometry: { lng: number; lat: number };
    updatedAt: string;
  };
  mapping: {
    status: MappingStatus;
    provinceCode: string | null;
    communeCode: string | null;
    legacyDistrictCode: string | null;
    provinceName: string | null;
    communeName: string | null;
    legacyDistrictName: string | null;
    method: string | null;
    confidence: string | null;
    datasetVersion: string | null;
    boundaryVersion: string | null;
    mappedAt: string | null;
    reviewer: { id: string; displayName: string } | null;
  };
  activeDatasetVersion: string;
  /** Recomputed on read: what the resolver would say about this place now. */
  evidence: Evidence[];
  candidates: Candidate[];
  unresolvedReason: ResolverReason | null;
  hierarchyValid: boolean;
  staleness: StaleVerdict;
  approval: { blocked: boolean; block: ApprovalBlock | null };
  permittedActions: string[];
};

export type MappingListItem = {
  placeId: string;
  name: string;
  placeStatus: string;
  mappingStatus: MappingStatus;
  provinceCode: string | null;
  communeCode: string | null;
  datasetVersion: string | null;
  updatedAt: string;
  blocksApproval: boolean;
};

/** One entry's fate in a batch verification (ADM-024). */
export type BatchVerifyResult = {
  placeId: string;
  outcome: 'verified' | 'conflict' | 'refused';
  status: MappingStatus | null;
  datasetVersion: string | null;
  /** The refusal's error code, so a reviewer is told why rather than that it failed. */
  code: string | null;
  message: string | null;
};

export type BatchVerifyReport = {
  requested: number;
  verified: number;
  conflicts: number;
  refused: number;
  results: BatchVerifyResult[];
};
const MAX_LIMIT = 200;

@Injectable()
export class AdministrativeModerationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly resolver: AdministrativeResolverService,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * One counter for every moderator action. The action and the result are both
   * closed sets; who did it is in the audit row, because a reviewer's identity
   * in a Prometheus label is both unbounded and a thing nobody should be able
   * to build a leaderboard from.
   */
  private action(
    action: 'list' | 'detail' | 'verify' | 'reject' | 'rematch' | 'correct' | 'reconcile',
    result: 'ok' | 'rejected' | 'conflict' | 'unchanged',
  ): void {
    this.metrics.increment('administrative_moderation_actions_total', { action, result });
  }

  /**
   * The review queue.
   *
   * `UNMAPPED` is not in the default actionable view — there is nothing for a
   * person to decide about a place the resolver could not place — but it is
   * always reachable by filter, and a place **awaiting approval** while
   * `UNMAPPED` is surfaced by `blockedApprovalOnly`, because that is a place
   * whose progress is stuck on a mapping nobody can see.
   */
  async list(options: {
    status?: MappingStatus[];
    placeStatus?: string[];
    blockedApprovalOnly?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<{
    items: MappingListItem[];
    nextCursor: string | null;
    counts: Record<string, number>;
  }> {
    const limit = Math.min(options.limit, MAX_LIMIT);
    const conditions = [];
    if (options.status?.length) {
      conditions.push(inArray(schema.places.administrativeMappingStatus, options.status));
    }
    if (options.blockedApprovalOnly) {
      // Everything that is not a current verified mapping blocks approval; the
      // exact reason is per place and is computed in `detail`.
      conditions.push(ne(schema.places.administrativeMappingStatus, 'VERIFIED'));
      conditions.push(inArray(schema.places.status, ['draft', 'community_submitted', 'review']));
    }
    if (options.placeStatus?.length) {
      conditions.push(
        inArray(
          schema.places.status,
          options.placeStatus as (typeof schema.places.status.enumValues)[number][],
        ),
      );
    }
    if (options.cursor) conditions.push(gt(schema.places.id, options.cursor));

    const rows = await this.db
      .select({
        placeId: schema.places.id,
        name: schema.places.name,
        placeStatus: schema.places.status,
        mappingStatus: schema.places.administrativeMappingStatus,
        provinceCode: schema.places.provinceCode,
        communeCode: schema.places.communeCode,
        datasetVersion: schema.places.administrativeDatasetVersion,
        updatedAt: schema.places.updatedAt,
      })
      .from(schema.places)
      .where(conditions.length ? and(...conditions) : undefined)
      // Ordered by id so the cursor is stable under concurrent edits: ordering
      // by `updated_at` would let a place a reviewer just touched jump pages.
      .orderBy(asc(schema.places.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        placeId: r.placeId,
        name: r.name,
        placeStatus: r.placeStatus,
        mappingStatus: r.mappingStatus,
        provinceCode: r.provinceCode,
        communeCode: r.communeCode,
        datasetVersion: r.datasetVersion,
        updatedAt: r.updatedAt.toISOString(),
        blocksApproval: blocksApproval(r.mappingStatus),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.placeId ?? null) : null,
      counts: await this.countsWith(() => this.action('list', 'ok')),
    };
  }

  private async countsWith(after: () => void): Promise<Record<string, number>> {
    const counts = await this.counts();
    after();
    return counts;
  }

  /** One count per mapping status, so a queue can show what it is not showing. */
  async counts(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        status: schema.places.administrativeMappingStatus,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.places)
      .groupBy(schema.places.administrativeMappingStatus);
    const counts: Record<string, number> = {
      UNMAPPED: 0,
      AUTO_MATCHED: 0,
      NEEDS_REVIEW: 0,
      VERIFIED: 0,
      REJECTED: 0,
      STALE: 0,
      actionable: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.n;
      if (isActionable(row.status)) counts.actionable = (counts.actionable ?? 0) + row.n;
    }
    return counts;
  }

  /** Everything the CMS needs to show one mapping, recomputed on read. */
  async detail(placeId: string, actorRole: string): Promise<MappingDetail> {
    this.action('detail', 'ok');
    const place = await this.placeRow(placeId);
    const dataset = await this.activeDataset();
    const resolution = await this.resolver.resolvePlace(placeId);
    const staleness = await this.resolver.evaluateStalenessFor(placeId);

    const commune = place.communeCode
      ? await this.currentUnit(dataset.id, place.communeCode, 'COMMUNE')
      : null;
    const province = place.provinceCode
      ? await this.currentUnit(dataset.id, place.provinceCode, 'PROVINCE')
      : null;
    const legacy = place.legacyDistrictCode
      ? await this.anyUnit(dataset.id, place.legacyDistrictCode, 'LEGACY_DISTRICT')
      : null;
    const reviewer = place.administrativeMappedBy
      ? await this.reviewerOf(place.administrativeMappedBy)
      : null;

    const block = approvalBlock(
      {
        status: place.administrativeMappingStatus,
        provinceCode: place.provinceCode,
        communeCode: place.communeCode,
        datasetVersion: place.administrativeDatasetVersion,
      },
      dataset.combinedDatasetVersion,
      commune,
    );

    return {
      placeId,
      place: {
        name: place.name,
        status: place.status,
        addressText: place.addressText,
        city: place.city,
        district: place.district,
        geometry: { lng: place.geom.x, lat: place.geom.y },
        updatedAt: place.updatedAt.toISOString(),
      },
      mapping: {
        status: place.administrativeMappingStatus,
        provinceCode: place.provinceCode,
        communeCode: place.communeCode,
        legacyDistrictCode: place.legacyDistrictCode,
        provinceName: province?.fullName ?? null,
        communeName: commune ? commune.fullName : null,
        legacyDistrictName: legacy?.fullName ?? null,
        method: place.administrativeMappingSource,
        confidence: place.administrativeMappingConfidence,
        datasetVersion: place.administrativeDatasetVersion,
        boundaryVersion: place.administrativeBoundaryVersion,
        mappedAt: place.administrativeMappedAt?.toISOString() ?? null,
        reviewer,
      },
      activeDatasetVersion: dataset.combinedDatasetVersion,
      evidence: resolution.evidence,
      candidates: resolution.candidates,
      unresolvedReason: resolution.reason,
      hierarchyValid: block?.code !== 'MAPPING_HIERARCHY_INVALID',
      staleness,
      approval: { blocked: block !== null, block },
      permittedActions: permittedActions(actorRole, place.administrativeMappingStatus),
    };
  }

  /**
   * A reviewer's own decision: these codes, this place.
   *
   * Everything is validated inside the transaction — the codes against the
   * dataset that is active *now*, the hierarchy between them, and the row
   * against `expectedUpdatedAt`. No confidence number is written: a person's
   * judgement is not a probability, and `VERIFIED` plus their identity is the
   * whole claim.
   */
  async verify(
    placeId: string,
    input: {
      provinceCode: string;
      communeCode: string;
      legacyDistrictCode?: string | null;
      expectedUpdatedAt: Date;
      note?: string;
    },
    actor: ModerationActor,
  ): Promise<{ placeId: string; status: MappingStatus; datasetVersion: string }> {
    return this.decide(placeId, input.expectedUpdatedAt, actor, async (tx, place, dataset) => {
      // ADM-015 — the same check the create form, the edit form and the import
      // run. It used to live here as four inline throws, which is three copies
      // away from where the next caller would have written its own.
      await assertCurrentPair(tx, dataset, {
        provinceCode: input.provinceCode,
        communeCode: input.communeCode,
        legacyDistrictCode: input.legacyDistrictCode ?? null,
      });

      const now = new Date();
      await tx
        .update(schema.places)
        .set({
          provinceCode: input.provinceCode,
          communeCode: input.communeCode,
          legacyDistrictCode: input.legacyDistrictCode ?? null,
          administrativeMappingStatus: 'VERIFIED',
          administrativeMappingSource: 'editor',
          // Deliberately null. A reviewer's decision is not a measurement, and
          // a number here would be one nobody took.
          administrativeMappingConfidence: null,
          administrativeDatasetVersion: dataset.combinedDatasetVersion,
          administrativeMappedBy: actor.id,
          administrativeMappedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.places.id, placeId));

      return {
        action: 'administrative_mapping.verify',
        diff: {
          from: mappingSnapshot(place),
          to: {
            status: 'VERIFIED',
            provinceCode: input.provinceCode,
            communeCode: input.communeCode,
            legacyDistrictCode: input.legacyDistrictCode ?? null,
            source: 'editor',
            datasetVersion: dataset.combinedDatasetVersion,
            mappedBy: actor.id,
          },
          note: input.note ?? null,
          reviewerSelection: {
            provinceCode: input.provinceCode,
            communeCode: input.communeCode,
            legacyDistrictCode: input.legacyDistrictCode ?? null,
          },
        },
        result: {
          placeId,
          status: 'VERIFIED' as MappingStatus,
          datasetVersion: dataset.combinedDatasetVersion,
        },
      };
    });
  }

  /**
   * ADM-024 (#613) — one reviewer, many places, still one decision each.
   *
   * After a boundary release lands, the resolver can answer for the whole
   * catalogue at once (#610 turned 270 unresolved places into 271 proposals in
   * a single run). The confirmations did not scale with it: `VERIFIED` is a
   * person's claim and stays one, so a reviewer agreeing with 271 proposals had
   * to send 271 requests.
   *
   * This sends one. It is **not** a bulk write: every entry goes through the
   * same `verify` path, which means its own transaction, its own row lock, its
   * own re-read of the active dataset, its own hierarchy check, its own
   * `expectedUpdatedAt`, and its own audit row. A batch is N decisions one
   * person took at the same moment, and the log has to read that way — a single
   * audit row naming 271 places would record an act nobody performed.
   *
   * Entries run in order rather than concurrently. Each is a separate
   * transaction taking a row lock, and firing them at once through a connection
   * pooler buys contention in exchange for a saving nobody asked for.
   *
   * **Partial success is the expected result, not an error.** A place another
   * reviewer touched a second ago must fail alone; failing its 270 neighbours
   * with it would make the feature useless exactly when the queue is busy.
   */
  async verifyMany(
    input: {
      entries: ReadonlyArray<{
        placeId: string;
        provinceCode: string;
        communeCode: string;
        legacyDistrictCode?: string | null;
        expectedUpdatedAt: Date;
      }>;
      note?: string;
    },
    actor: ModerationActor,
  ): Promise<BatchVerifyReport> {
    const seen = new Set<string>();
    for (const entry of input.entries) {
      // Two entries for one place carry two `expectedUpdatedAt` values, and the
      // second is wrong the moment the first commits. Refusing is the only
      // answer that does not silently pick one.
      if (seen.has(entry.placeId)) {
        throw AppError.badRequest(
          'DUPLICATE_PLACE_IN_BATCH',
          `place ${entry.placeId} appears more than once; a batch carries one decision per place`,
        );
      }
      seen.add(entry.placeId);
    }

    // Checked once, before anything is written: with no published dataset there
    // is nothing to validate a pair against, and discovering that on entry 57
    // would leave 56 places verified against a question nobody could answer.
    await this.activeDataset();

    const results: BatchVerifyResult[] = [];
    for (const entry of input.entries) {
      try {
        const done = await this.verify(
          entry.placeId,
          {
            provinceCode: entry.provinceCode,
            communeCode: entry.communeCode,
            legacyDistrictCode: entry.legacyDistrictCode ?? null,
            expectedUpdatedAt: entry.expectedUpdatedAt,
            ...(input.note ? { note: input.note } : {}),
          },
          actor,
        );
        results.push({
          placeId: entry.placeId,
          outcome: 'verified',
          status: done.status,
          datasetVersion: done.datasetVersion,
          code: null,
          message: null,
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // A dataset disappearing mid-batch is a condition about the batch, not
        // about the entry that happened to notice it.
        if (error.code === 'ADMINISTRATIVE_DATASET_UNAVAILABLE') throw error;
        results.push({
          placeId: entry.placeId,
          outcome: error.httpStatus === 409 ? 'conflict' : 'refused',
          status: null,
          datasetVersion: null,
          code: error.code,
          message: error.message,
        });
      }
    }

    const count = (outcome: BatchVerifyResult['outcome']): number =>
      results.filter((r) => r.outcome === outcome).length;

    return {
      requested: input.entries.length,
      verified: count('verified'),
      conflicts: count('conflict'),
      refused: count('refused'),
      results,
    };
  }

  /**
   * Rejecting the **mapping**, which is not rejecting the place.
   *
   * The codes and the resolver's evidence are kept: a rejection is a statement
   * that this answer is wrong, and the next reviewer needs to see what was
   * rejected to avoid proposing it again.
   */
  async rejectMapping(
    placeId: string,
    input: { reason: string; expectedUpdatedAt: Date },
    actor: ModerationActor,
  ): Promise<{ placeId: string; status: MappingStatus }> {
    if (!input.reason.trim()) {
      throw AppError.badRequest('REASON_REQUIRED', 'rejecting a mapping requires a reason');
    }
    return this.decide(placeId, input.expectedUpdatedAt, actor, async (tx, place) => {
      const now = new Date();
      await tx
        .update(schema.places)
        .set({
          administrativeMappingStatus: 'REJECTED',
          administrativeMappedBy: actor.id,
          administrativeMappedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.places.id, placeId));

      return {
        action: 'administrative_mapping.reject',
        diff: {
          from: mappingSnapshot(place),
          to: { status: 'REJECTED', mappedBy: actor.id },
          reason: input.reason,
          // Kept on the record rather than cleared: what was rejected is the
          // most useful thing the next reviewer can be told.
          rejectedCodes: {
            provinceCode: place.provinceCode,
            communeCode: place.communeCode,
            legacyDistrictCode: place.legacyDistrictCode,
          },
        },
        result: { placeId, status: 'REJECTED' as MappingStatus },
      };
    });
  }

  /**
   * The only route that reopens a `REJECTED` mapping.
   *
   * One place, a reason, an authenticated actor. ADM-008's bulk job has no such
   * option precisely because it has nobody to name; here there is.
   *
   * Asking for a rematch is not verifying anything: the resolver's answer is
   * written under ADM-006's ordinary rules, the previous reviewer's attribution
   * is cleared because their decision no longer stands, and the requester is
   * recorded in the audit as the requester — never in `mapped_by`.
   */
  async rematch(
    placeId: string,
    input: { reason: string; expectedUpdatedAt: Date },
    actor: ModerationActor,
  ): Promise<{ placeId: string; status: MappingStatus; communeCode: string | null }> {
    if (!input.reason.trim()) {
      throw AppError.badRequest('REASON_REQUIRED', 'a rematch requires a reason');
    }
    const place = await this.placeRow(placeId);
    if (place.administrativeMappingStatus === 'VERIFIED') {
      throw AppError.conflict(
        'VERIFIED_NOT_REMATCHABLE',
        'a verified mapping is corrected by a reviewer, not re-derived by the resolver',
      );
    }
    if (place.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw AppError.conflict('PLACE_MODIFIED', 'the place changed since it was read');
    }

    const resolution = await this.resolver.resolvePlace(placeId, { allowRematchRejected: true });
    const outcome = await this.resolver.persist(resolution, {
      actor: { id: actor.id, type: 'admin' },
      expectedUpdatedAt: input.expectedUpdatedAt,
      allowRematchRejected: true,
    });
    if (outcome.outcome === 'conflict') {
      throw AppError.conflict('PLACE_MODIFIED', 'the place changed while the rematch ran');
    }

    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'administrative_mapping.rematch',
      resourceType: 'place',
      resourceId: placeId,
      diff: {
        reason: input.reason,
        requestedBy: actor.id,
        previousStatus: place.administrativeMappingStatus,
        previousReviewer: place.administrativeMappedBy,
        outcome: outcome.outcome,
        to: {
          status: resolution.status,
          provinceCode: resolution.provinceCode,
          communeCode: resolution.communeCode,
          method: resolution.method,
        },
        // Said in the record, because the column no longer says it: the person
        // who asked for a rematch has not verified anything.
        clearedReviewerAttribution: place.administrativeMappingStatus === 'REJECTED',
      },
    });

    this.action('rematch', 'ok');
    return { placeId, status: resolution.status, communeCode: resolution.communeCode };
  }

  /**
   * Correcting a mapping a reviewer already verified.
   *
   * Separate from `verify` on purpose. The ordinary resolver path may never
   * touch a `VERIFIED` row, and neither may an ordinary verification: changing
   * one person's recorded decision is an act that must name both people, and
   * the audit row does.
   */
  async correctVerified(
    placeId: string,
    input: {
      provinceCode: string;
      communeCode: string;
      legacyDistrictCode?: string | null;
      reason: string;
      expectedUpdatedAt: Date;
    },
    actor: ModerationActor,
  ): Promise<{ placeId: string; status: MappingStatus; datasetVersion: string }> {
    if (!input.reason.trim()) {
      throw AppError.badRequest(
        'REASON_REQUIRED',
        'correcting a verified mapping requires a reason',
      );
    }
    const place = await this.placeRow(placeId);
    if (place.administrativeMappingStatus !== 'VERIFIED') {
      throw AppError.conflict(
        'NOT_VERIFIED',
        'this mapping is not verified; use verify rather than correct',
      );
    }
    const previousReviewer = place.administrativeMappedBy;
    const result = await this.verify(
      placeId,
      {
        provinceCode: input.provinceCode,
        communeCode: input.communeCode,
        legacyDistrictCode: input.legacyDistrictCode ?? null,
        expectedUpdatedAt: input.expectedUpdatedAt,
        note: input.reason,
      },
      actor,
    );
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'administrative_mapping.correct',
      resourceType: 'place',
      resourceId: placeId,
      diff: {
        reason: input.reason,
        previousReviewer,
        previousCodes: {
          provinceCode: place.provinceCode,
          communeCode: place.communeCode,
          legacyDistrictCode: place.legacyDistrictCode,
        },
        correctedBy: actor.id,
        to: { provinceCode: input.provinceCode, communeCode: input.communeCode },
      },
    });
    return result;
  }

  /**
   * System reconciliation: mark a mapping `STALE` when it is *materially*
   * invalid against the active dataset.
   *
   * A version change alone is never enough. If the same commune still exists,
   * is still current and still sits under the same province, the mapping is the
   * mapping that person verified and nothing is written — the older version
   * stays as provenance.
   *
   * When it is stale, the codes and `administrative_mapped_by` are **kept**.
   * The column names who verified the stored mapping, and they did; `STALE`
   * says that verification is no longer current. Clearing it would erase the
   * only record of who to ask, and writing the reconciler there would claim a
   * verification nobody performed.
   */
  async reconcile(
    placeId: string,
    actor: ModerationActor,
  ): Promise<{ placeId: string; changed: boolean; verdict: StaleVerdict }> {
    const verdict = await this.resolver.evaluateStalenessFor(placeId);
    const place = await this.placeRow(placeId);
    const dataset = await this.activeDataset();

    if (!verdict.stale || place.administrativeMappingStatus === 'STALE') {
      // Idempotent: a second reconciliation of a stale row writes nothing, and
      // a valid mapping is never touched.
      this.action('reconcile', 'unchanged');
      return { placeId, changed: false, verdict };
    }

    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.places)
        .set({ administrativeMappingStatus: 'STALE', updatedAt: now })
        .where(eq(schema.places.id, placeId));
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: actor.id,
        action: 'administrative_mapping.reconcile',
        resourceType: 'place',
        resourceId: placeId,
        diff: {
          from: mappingSnapshot(place),
          to: { status: 'STALE' },
          reason: verdict.reason,
          // Named so the log cannot be read as "this person verified it".
          evaluatedBy: actor.id,
          systemEvaluated: true,
          retainedReviewer: place.administrativeMappedBy,
          activeDatasetVersion: dataset.combinedDatasetVersion,
        },
      });
    });
    this.action('reconcile', 'ok');
    return { placeId, changed: true, verdict };
  }

  /**
   * Approved places that would not pass the policy today.
   *
   * Counted and listed, never acted on. These were approved before the policy
   * existed, and taking a working catalogue off the air to satisfy a rule
   * written after it was built would be the policy doing more harm than the
   * problem it addresses.
   */
  async remediation(sampleLimit = 20): Promise<{
    activeDatasetVersion: string;
    counts: Record<RemediationCategory, number>;
    samples: Record<string, string[]>;
  }> {
    const dataset = await this.activeDataset();
    const rows = await this.db
      .select({
        id: schema.places.id,
        status: schema.places.administrativeMappingStatus,
        provinceCode: schema.places.provinceCode,
        communeCode: schema.places.communeCode,
        datasetVersion: schema.places.administrativeDatasetVersion,
      })
      .from(schema.places)
      .where(eq(schema.places.status, 'published'))
      .orderBy(asc(schema.places.id));

    const counts: Record<RemediationCategory, number> = {
      unmapped: 0,
      auto_matched: 0,
      needs_review: 0,
      rejected: 0,
      stale: 0,
      verified_against_older_version: 0,
      compliant: 0,
    };
    const samples: Record<string, string[]> = {};
    for (const row of rows) {
      const category = remediationCategory(
        {
          status: row.status,
          provinceCode: row.provinceCode,
          communeCode: row.communeCode,
          datasetVersion: row.datasetVersion,
        },
        dataset.combinedDatasetVersion,
      );
      counts[category] += 1;
      if (category !== 'compliant') {
        samples[category] = samples[category] ?? [];
        if (samples[category].length < sampleLimit) samples[category].push(row.id);
      }
    }
    return { activeDatasetVersion: dataset.combinedDatasetVersion, counts, samples };
  }

  /**
   * The shared shape of a reviewer decision: lock, re-read, re-check, write,
   * audit — all inside one transaction, so an audit that cannot be written
   * takes the decision down with it.
   */
  private async decide<T>(
    placeId: string,
    expectedUpdatedAt: Date,
    actor: ModerationActor,
    body: (
      tx: Tx,
      place: PlaceRow,
      dataset: DatasetRow,
    ) => Promise<{ action: string; diff: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [place] = await tx
        .select()
        .from(schema.places)
        .where(eq(schema.places.id, placeId))
        .limit(1)
        .for('update');
      if (!place) throw AppError.notFound('PLACE_NOT_FOUND', `no place ${placeId}`);
      if (place.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        this.metrics.increment('administrative_moderation_actions_total', {
          action: 'decide',
          result: 'conflict',
        });
        throw AppError.conflict(
          'PLACE_MODIFIED',
          'the place changed since it was read; reload the mapping and decide again',
        );
      }
      const dataset = await this.activeDataset(tx);
      const { action, diff, result } = await body(tx, place as PlaceRow, dataset);
      this.action(action.split('.').at(-1) as 'verify', 'ok');
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: actor.id,
        action,
        resourceType: 'place',
        resourceId: placeId,
        diff: { ...diff, activeDatasetVersion: dataset.combinedDatasetVersion },
      });
      return result;
    });
  }

  private async placeRow(placeId: string): Promise<PlaceRow> {
    const [row] = await this.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', `no place ${placeId}`);
    return row as PlaceRow;
  }

  private async activeDataset(tx?: Tx): Promise<DatasetRow> {
    const executor = tx ?? this.db;
    const [row] = await executor
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);
    if (!row) {
      throw AppError.serviceUnavailable(
        'ADMINISTRATIVE_DATASET_UNAVAILABLE',
        'no administrative dataset is published',
      );
    }
    return row as DatasetRow;
  }

  /**
   * ADM-015 — one lookup, shared with every other caller that validates a pair.
   *
   * The `approvalBlock` policy needs `status` and `effectiveTo` as well as the
   * parent, and `currentUnitOf` only returns units that are already active with
   * no end date — so those two are constants here rather than columns. Saying
   * so out loud beats a second query that could disagree with the first.
   */
  private async currentUnit(
    datasetVersionId: string,
    code: string,
    level: 'PROVINCE' | 'COMMUNE',
    tx?: Executor,
  ) {
    const row = await currentUnitOf(tx ?? this.db, datasetVersionId, code, level);
    return row ? { ...row, status: 'ACTIVE' as const, effectiveTo: null as string | null } : null;
  }

  /**
   * A legacy district is history by definition, so it is looked up across every
   * period rather than among current units — asking for a *current* dissolved
   * district would never find one.
   */
  private async anyUnit(
    datasetVersionId: string,
    code: string,
    _level: 'LEGACY_DISTRICT',
    tx?: Executor,
  ) {
    return legacyDistrictUnit(tx ?? this.db, datasetVersionId, code);
  }

  private async reviewerOf(adminId: string) {
    const [row] = await this.db
      .select({ id: schema.adminUsers.id, displayName: schema.adminUsers.displayName })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, adminId))
      .limit(1);
    return row ?? null;
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type PlaceRow = typeof schema.places.$inferSelect;
type DatasetRow = typeof schema.administrativeDatasetVersions.$inferSelect;

function mappingSnapshot(place: PlaceRow): Record<string, unknown> {
  return {
    status: place.administrativeMappingStatus,
    provinceCode: place.provinceCode,
    communeCode: place.communeCode,
    legacyDistrictCode: place.legacyDistrictCode,
    source: place.administrativeMappingSource,
    datasetVersion: place.administrativeDatasetVersion,
    boundaryVersion: place.administrativeBoundaryVersion,
    mappedBy: place.administrativeMappedBy,
  };
}

/**
 * What this role may do to this mapping, so the console can render buttons it
 * knows will work rather than discovering a 403 on click. The server still
 * enforces it — `.claude/rules/core.md` #5: hiding a button is not
 * authorization.
 */
function permittedActions(role: string, status: MappingStatus): string[] {
  const moderator = role === 'moderator' || role === 'super_admin';
  const ops = role === 'ops_admin' || role === 'super_admin';
  const actions: string[] = ['view'];
  if (moderator) {
    if (status === 'VERIFIED') actions.push('correct');
    else actions.push('verify', 'reject');
    if (status === 'REJECTED' || status === 'NEEDS_REVIEW' || status === 'STALE') {
      actions.push('rematch');
    }
  }
  if (ops) actions.push('reconcile');
  return actions;
}
