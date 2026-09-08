import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import {
  adjudicate,
  type CurrentMapping,
  type Evidence,
  type Resolution,
  type ResolverReason,
} from '../domain/resolver';
import {
  applyAutomaticTransition,
  clearsReviewerAttribution,
  type MappingStatus,
} from '../domain/mapping-status';
import { evaluateStaleness, type StaleVerdict } from '../domain/staleness';
import { AdministrativeResolverRepository } from '../infrastructure/administrative-resolver.repository';
import type { Executor } from './unit-lookup';

/**
 * ADM-006 (#459) / ADR-0019 §7, §10 — the resolver, wired to the database.
 *
 * The service gathers evidence; `adjudicate` decides. Keeping those apart is
 * what makes the decision testable without a database and, more importantly,
 * what stops "the provider that ran last" from becoming the tie-break.
 *
 * **No provider call is made here, ever.** Not Place Details, not a field mask,
 * not a cached provider payload. The evidence is: codes someone explicitly
 * supplied, `places.geom` that GoGo already stores, GoGo's pinned MIT
 * boundaries, and GoGo's own pinned change data. That list is ADR-0019 §10 and
 * GoGo-BE#464, and it is why the resulting codes are GoGo facts rather than
 * provider content.
 *
 * **`city` and `district` are not on that list** (ADR-0019 §7b). They are
 * legacy free text: a district names a tier dissolved on 2025-07-01, and a city
 * string is what somebody typed to help find a place, not a claim about which
 * province it is in. Neither is given to this service at all — the input type
 * has no field for them — because a rule enforced by remembering not to read
 * something lasts until the next person adds a provider that does.
 *
 * Nothing outside the `administrative_*` columns is ever written. `name`,
 * `address_text` and `geom` are the inputs; a resolver that edited its own
 * inputs would make its next run unreproducible.
 */

export type ResolveOptions = {
  /** Defaults to the published dataset. A staged one previews its effect. */
  datasetVersionId?: string;
  boundaryVersion?: string | null;
  trustedCodes?: {
    provinceCode?: string | null;
    communeCode?: string | null;
    legacyDistrictCode?: string | null;
  } | null;
  /** A reviewer explicitly asking for a rejected mapping to be reconsidered. */
  allowRematchRejected?: boolean;
};

/**
 * ADM-015 — a point to be classified, with or without a place behind it.
 *
 * `subjectId` is only ever a label: it travels into `Resolution.placeId`, the
 * audit row and the metric, and nothing dereferences it. For a stored place it
 * is the place id; for an import row previewing what it would become, it is the
 * row id — which is the honest answer to "what did this resolution describe",
 * because at preview time no place exists to name.
 */
export type GeometrySubject = {
  subjectId: string;
  geometry: { lng: number; lat: number } | null;
  /** Defaults to an unmapped subject: nothing claimed, nothing to protect. */
  current?: CurrentMapping;
};

/** Nothing is claimed yet. Used for a preview and for an unbiased re-read. */
export const NO_MAPPING: CurrentMapping = {
  status: 'UNMAPPED',
  provinceCode: null,
  communeCode: null,
  legacyDistrictCode: null,
  method: null,
  datasetVersion: null,
  boundaryVersion: null,
};

export type PersistOutcome = 'written' | 'noop' | 'conflict' | 'blocked';

export type PersistOptions = {
  actor?: { id: string | null; type: 'admin' | 'system' };
  /** Optimistic concurrency: the `updated_at` the caller last saw. */
  expectedUpdatedAt?: Date;
  allowRematchRejected?: boolean;
  /**
   * ADM-008: the enrichment run this write belongs to. Recorded on the audit
   * row so a mapping can be traced back to the run that made it — which is what
   * keeps a bulk run accountable without an audit row per place that was left
   * alone.
   */
  runId?: string;
};

export type PersistResult = {
  outcome: PersistOutcome;
  placeId: string;
  status: MappingStatus;
  reason?: string;
};

/** Vietnam's bounding box, generously drawn. A point outside it is not an address here. */
const VN_BOUNDS = { minLng: 102, maxLng: 118, minLat: 6, maxLat: 24 };

@Injectable()
export class AdministrativeResolverService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repository: AdministrativeResolverRepository,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  /** Resolves one stored place against a dataset version. Writes nothing. */
  async resolvePlace(placeId: string, options: ResolveOptions = {}): Promise<Resolution> {
    return this.resolvePlaceWithin(this.db, placeId, options);
  }

  /**
   * ADM-015 — the same resolution, read through the caller's transaction.
   *
   * Create and edit resolve a place inside the transaction that just wrote it.
   * Going through the pool instead would either miss the row altogether or read
   * the geometry it had before the save, and classifying stale geometry is
   * worse than not classifying at all: it produces a confident answer about a
   * position the place no longer holds.
   */
  async resolvePlaceWithin(
    executor: Executor,
    placeId: string,
    options: ResolveOptions = {},
  ): Promise<Resolution> {
    const place = await this.placeRow(executor, placeId);
    return this.resolveSubject(
      executor,
      {
        subjectId: placeId,
        geometry: place.geom ? { lng: place.geom.x, lat: place.geom.y } : null,
        current: {
          status: place.administrativeMappingStatus,
          provinceCode: place.provinceCode,
          communeCode: place.communeCode,
          legacyDistrictCode: place.legacyDistrictCode,
          method: place.administrativeMappingSource,
          datasetVersion: place.administrativeDatasetVersion,
          boundaryVersion: place.administrativeBoundaryVersion,
        },
      },
      options,
    );
  }

  /**
   * ADM-015 — classify a point that has no place row behind it.
   *
   * The import wizard has to show an operator which commune a row will land in
   * *before* anything is created, and the create form has to show it for a
   * Google link the editor has not yet saved. Both are the same question the
   * backfill asks of a stored place, and answering them with a second, slightly
   * different code path is how a preview starts disagreeing with the commit.
   * Same evidence gathering, same `adjudicate`, same reasons.
   */
  async resolveGeometry(
    subject: GeometrySubject,
    options: ResolveOptions & { executor?: Executor } = {},
  ): Promise<Resolution> {
    const { executor, ...rest } = options;
    return this.resolveSubject(executor ?? this.db, subject, rest);
  }

  private async resolveSubject(
    executor: Executor,
    subject: GeometrySubject,
    options: ResolveOptions,
  ): Promise<Resolution> {
    const startedAt = Date.now();
    const dataset = await this.datasetFor(executor, options.datasetVersionId);

    const current = subject.current ?? NO_MAPPING;
    const boundaryVersion =
      options.boundaryVersion === undefined
        ? dataset.boundarySourceVersion
        : options.boundaryVersion;

    const { evidence, reasons } = await this.gather(executor, {
      datasetVersionId: dataset.id,
      boundaryVersion,
      geometry: subject.geometry,
      current,
      ...(options.trustedCodes === undefined ? {} : { trustedCodes: options.trustedCodes }),
    });

    const resolution = adjudicate({
      placeId: subject.subjectId,
      datasetVersion: dataset.combinedDatasetVersion,
      boundaryVersion,
      current,
      evidence,
      reasons,
      ...(options.allowRematchRejected === undefined
        ? {}
        : { allowRematchRejected: options.allowRematchRejected }),
    });

    this.metrics.increment('administrative_resolver_runs_total', {
      status: resolution.status,
      method: resolution.method ?? 'none',
    });
    if (resolution.reason) {
      this.metrics.increment('administrative_resolver_unresolved_total', {
        reason: resolution.reason,
      });
    }
    this.metrics.observe(
      'administrative_resolver_duration_seconds',
      (Date.now() - startedAt) / 1000,
      { status: resolution.status },
    );
    // Two classes, not a number: 1.00 where the evidence is definitional, and
    // absent everywhere else. A dashboard that plotted a mean confidence would
    // be averaging a definition with a silence.
    this.metrics.increment('administrative_resolver_confidence_total', {
      class: resolution.confidence === null ? 'unnumbered' : 'definitional',
    });
    return resolution;
  }

  /**
   * Is this place's stored mapping still true against the published dataset?
   *
   * Evaluation only — see `domain/staleness.ts`. Nothing here writes `STALE`,
   * and nothing here re-points a `VERIFIED` place.
   */
  async evaluateStalenessFor(placeId: string): Promise<StaleVerdict> {
    const place = await this.placeRow(this.db, placeId);
    const dataset = await this.datasetFor(this.db, undefined);
    const current: CurrentMapping = {
      status: place.administrativeMappingStatus,
      provinceCode: place.provinceCode,
      communeCode: place.communeCode,
      legacyDistrictCode: place.legacyDistrictCode,
      method: place.administrativeMappingSource,
      datasetVersion: place.administrativeDatasetVersion,
      boundaryVersion: place.administrativeBoundaryVersion,
    };
    const unit = place.communeCode
      ? await this.repository.currentUnit(dataset.id, place.communeCode, 'COMMUNE')
      : null;
    const verdict = evaluateStaleness({
      current,
      activeDatasetVersion: dataset.combinedDatasetVersion,
      unit: unit
        ? {
            code: unit.code,
            parentCode: unit.parentCode,
            status: unit.status,
            effectiveTo: unit.effectiveTo,
          }
        : null,
    });
    this.metrics.increment('administrative_stale_evaluations_total', { reason: verdict.reason });
    return verdict;
  }

  /**
   * Persists one resolution.
   *
   * The transition matrix is applied twice: once against the row the resolution
   * was computed from, and again against the row read `FOR UPDATE` here. The
   * second one is the one that counts — between the two a reviewer can open the
   * place and mark it `VERIFIED`, and an unattended run that overwrote that
   * would be exactly the failure the matrix exists to prevent.
   */
  async persist(resolution: Resolution, options: PersistOptions = {}): Promise<PersistResult> {
    const result = await this.db.transaction((tx) => this.persistWithin(tx, resolution, options));
    this.countPersist(result);
    return result;
  }

  /**
   * ADM-015 — the same write, inside the caller's transaction.
   *
   * Create, edit and import all write the mapping in the transaction that
   * writes the place. Two transactions would mean a place that exists with no
   * mapping, or a mapping row updated for a place whose save then rolled back.
   *
   * The metric is **not** recorded here: a caller's transaction can still roll
   * back after this returns, and counting a write that never landed is worse
   * than not counting it. Call {@link countPersist} once the outer transaction
   * has committed — `persist` above is the shape to copy.
   */
  async persistWithin(
    tx: Executor,
    resolution: Resolution,
    options: PersistOptions = {},
  ): Promise<PersistResult> {
    const executor = tx as Db;
    {
      const [row] = await executor
        .select()
        .from(schema.places)
        .where(eq(schema.places.id, resolution.placeId))
        .limit(1)
        .for('update');
      if (!row) {
        throw AppError.notFound('PLACE_NOT_FOUND', `no place ${resolution.placeId}`);
      }

      if (
        options.expectedUpdatedAt &&
        row.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()
      ) {
        return {
          outcome: 'conflict' as const,
          placeId: resolution.placeId,
          status: row.administrativeMappingStatus,
          reason: 'PLACE_MODIFIED',
        };
      }

      const decision = applyAutomaticTransition(
        row.administrativeMappingStatus,
        resolution.status,
        {
          ...(options.allowRematchRejected === undefined
            ? {}
            : { allowRematchRejected: options.allowRematchRejected }),
        },
      );
      if (!resolution.writable || !decision.allowed) {
        return {
          outcome: 'blocked' as const,
          placeId: resolution.placeId,
          status: row.administrativeMappingStatus,
          reason: 'REVIEWER_OWNED',
        };
      }

      // The one case an automatic write reaches a reviewer-owned row is an
      // authorised rematch out of REJECTED. It replaces the reviewer's decision
      // with a machine one, so their id must not stay attached: the column
      // names who is responsible for the mapping the row carries *now*, and
      // anything keying on it being set would read this row as reviewed.
      const clearReviewer = clearsReviewerAttribution(
        row.administrativeMappingStatus,
        resolution.status,
      );
      const previousReviewer = row.administrativeMappedBy;
      const next = {
        ...mappingColumns(resolution),
        ...(clearReviewer ? { administrativeMappedBy: null } : {}),
      };
      if (unchanged(row, next) && !(clearReviewer && previousReviewer !== null)) {
        // Idempotent by construction: an identical re-run leaves `updated_at`
        // alone, so a nightly pass over an unchanged catalogue does not look
        // like a catalogue that changed every night.
        return {
          outcome: 'noop' as const,
          placeId: resolution.placeId,
          status: row.administrativeMappingStatus,
        };
      }

      await executor
        .update(schema.places)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(schema.places.id, resolution.placeId));

      await writeAudit(executor, {
        actorType: options.actor?.type ?? 'system',
        actorId: options.actor?.id ?? null,
        action: 'administrative_mapping.resolve',
        resourceType: 'place',
        resourceId: resolution.placeId,
        diff: {
          from: {
            status: row.administrativeMappingStatus,
            provinceCode: row.provinceCode,
            communeCode: row.communeCode,
            legacyDistrictCode: row.legacyDistrictCode,
            source: row.administrativeMappingSource,
            datasetVersion: row.administrativeDatasetVersion,
            boundaryVersion: row.administrativeBoundaryVersion,
            mappedBy: previousReviewer,
          },
          to: {
            status: resolution.status,
            provinceCode: resolution.provinceCode,
            communeCode: resolution.communeCode,
            legacyDistrictCode: resolution.legacyDistrictCode,
            source: resolution.method,
            datasetVersion: resolution.datasetVersion,
            boundaryVersion: resolution.boundaryVersion,
            mappedBy: clearReviewer ? null : previousReviewer,
          },
          // The evidence is the point of the row: a code with no account of
          // how it was arrived at cannot be argued with later.
          evidence: resolution.evidence,
          candidates: resolution.candidates,
          reason: resolution.reason,
          ...(options.runId ? { runId: options.runId } : {}),
          ...(clearReviewer
            ? {
                // Recorded apart from the mapping on purpose. Asking for a
                // rematch is not verifying anything, and this actor must never
                // be readable as the reviewer behind the result. The reviewer
                // who rejected it keeps their row in this log; what they lose
                // is the claim to a decision that is no longer theirs.
                rematch: {
                  requestedBy: options.actor?.id ?? null,
                  previousStatus: row.administrativeMappingStatus,
                  previousReviewer,
                  clearedReviewerAttribution: true,
                },
              }
            : {}),
        },
      });

      return {
        outcome: 'written' as const,
        placeId: resolution.placeId,
        status: resolution.status,
      };
    }
  }

  /**
   * Counts one committed mapping write.
   *
   * `conflict` and `blocked` are renamed at the metric boundary because the
   * words matter on a dashboard: one is two writers racing, the other is the
   * reviewer-owned rule holding.
   */
  countPersist(result: PersistResult): void {
    const outcome =
      result.outcome === 'conflict'
        ? 'concurrency_conflict'
        : result.outcome === 'blocked'
          ? 'protected'
          : result.outcome;
    this.metrics.increment('administrative_mapping_writes_total', { outcome });
  }

  /**
   * ADM-016 — a reviewer's verified mapping that the place has since moved away
   * from.
   *
   * `STALE` is the state that already means "known invalid, not yet
   * re-resolved", and it is the only honest place for a `VERIFIED` mapping
   * whose geometry an editor has just contradicted. The codes stay, and so does
   * `administrative_mapped_by`: that person really did verify those codes, and
   * erasing them would lose the one fact a later reviewer needs — who to ask.
   * What the row loses is the claim to permit publication, which `STALE`
   * already blocks.
   *
   * Nothing here re-points a mapping. Choosing the new commune is a person's
   * job, and this is the state that puts it in front of one.
   */
  async markStaleWithin(
    tx: Executor,
    placeId: string,
    input: {
      reason: string;
      actor?: { id: string | null; type: 'admin' | 'system' } | undefined;
      /** What the resolver would say now, recorded as the contradiction. */
      proposal?: Pick<Resolution, 'provinceCode' | 'communeCode' | 'status' | 'method'> | undefined;
    },
  ): Promise<boolean> {
    const executor = tx as Db;
    const [row] = await executor
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1)
      .for('update');
    // Only a verified mapping goes stale this way. Anything else is either
    // rewritable by the resolver or is `REJECTED`, which nothing may touch.
    if (!row || row.administrativeMappingStatus !== 'VERIFIED') return false;

    const now = new Date();
    await executor
      .update(schema.places)
      .set({ administrativeMappingStatus: 'STALE', updatedAt: now })
      .where(eq(schema.places.id, placeId));

    await writeAudit(executor, {
      actorType: input.actor?.type ?? 'system',
      actorId: input.actor?.id ?? null,
      action: 'administrative_mapping.stale',
      resourceType: 'place',
      resourceId: placeId,
      diff: {
        from: { status: 'VERIFIED', mappedBy: row.administrativeMappedBy },
        // The reviewer keeps their row: the verification happened, and it is
        // the place that moved out from under it.
        to: { status: 'STALE', mappedBy: row.administrativeMappedBy },
        keptCodes: {
          provinceCode: row.provinceCode,
          communeCode: row.communeCode,
          legacyDistrictCode: row.legacyDistrictCode,
        },
        reason: input.reason,
        ...(input.proposal ? { contradictedBy: input.proposal } : {}),
      },
    });
    this.metrics.increment('administrative_mapping_writes_total', { outcome: 'staled' });
    return true;
  }

  /**
   * Evidence gathering, in ADR-0019 §10's order.
   *
   * Every provider runs even when an earlier one succeeded. That is deliberate:
   * stopping at the first hit would hide the case where two sources disagree,
   * and a disagreement between an explicit code and the geometry is the single
   * most useful thing this resolver can tell a reviewer.
   *
   * **Three providers, not five** (ADR-0019 §7b). The two that read `city` and
   * `district` are gone. A commune chosen because somebody typed "Quận 1" is a
   * commune chosen from a tier that no longer exists, and a province chosen
   * because the sheet said "Hồ Chí Minh" is a province chosen from a search
   * hint — both produced codes indistinguishable, downstream, from ones the
   * geometry actually supports. Canonical codes now come from exactly two
   * places: codes somebody asserted and had validated, and containment against
   * the pinned boundaries. The change mapping below carries an existing code
   * forward across releases; it does not invent one.
   */
  private async gather(
    executor: Executor,
    input: {
      datasetVersionId: string;
      boundaryVersion: string | null;
      geometry: { lng: number; lat: number } | null;
      current: CurrentMapping;
      trustedCodes?: ResolveOptions['trustedCodes'];
    },
  ): Promise<{ evidence: Evidence[]; reasons: ResolverReason[] }> {
    const evidence: Evidence[] = [];
    const reasons: ResolverReason[] = [];

    await this.fromTrustedCodes(executor, input, evidence);
    await this.fromBoundary(executor, input, evidence, reasons);
    await this.fromHistory(executor, input, evidence, reasons);

    if (evidence.length === 0 && reasons.length === 0) reasons.push('NO_EVIDENCE');
    return { evidence, reasons };
  }

  /** Precedence 2: codes an import or an editor asserted outright. */
  private async fromTrustedCodes(
    executor: Executor,
    input: { datasetVersionId: string; trustedCodes?: ResolveOptions['trustedCodes'] },
    evidence: Evidence[],
  ): Promise<void> {
    const trusted = input.trustedCodes;
    if (!trusted) return;

    if (trusted.communeCode) {
      const commune = await this.repository.currentUnit(
        input.datasetVersionId,
        trusted.communeCode,
        'COMMUNE',
        executor,
      );
      const province = trusted.provinceCode ?? commune?.parentCode ?? null;
      evidence.push({
        method: 'trusted_code',
        provinceCode: province,
        communeCode: trusted.communeCode,
        // An asserted code is only as good as the hierarchy it claims. A
        // commune that does not exist in this dataset, or one whose parent is
        // not the province the caller named, is a claim and not a fact.
        hierarchyValid: Boolean(commune) && commune!.parentCode === province,
        deterministic: true,
        detail: `explicit codes ${province ?? '?'}/${trusted.communeCode}`,
      });
    } else if (trusted.provinceCode) {
      const province = await this.repository.currentUnit(
        input.datasetVersionId,
        trusted.provinceCode,
        'PROVINCE',
        executor,
      );
      evidence.push({
        method: 'trusted_code',
        provinceCode: trusted.provinceCode,
        communeCode: null,
        hierarchyValid: Boolean(province),
        deterministic: true,
        detail: `explicit province ${trusted.provinceCode}`,
      });
    }

    if (trusted.legacyDistrictCode) {
      const periods = await this.repository.unitPeriods(
        input.datasetVersionId,
        trusted.legacyDistrictCode,
        executor,
      );
      const district = periods.find((p) => p.level === 'LEGACY_DISTRICT');
      evidence.push({
        method: 'trusted_code',
        provinceCode: null,
        communeCode: null,
        legacyDistrictCode: district ? trusted.legacyDistrictCode : null,
        hierarchyValid: Boolean(district),
        deterministic: true,
        detail: `explicit legacy district ${trusted.legacyDistrictCode}`,
      });
    }
  }

  /** Precedence 3: containment against the pinned boundary release. */
  private async fromBoundary(
    executor: Executor,
    input: {
      datasetVersionId: string;
      boundaryVersion: string | null;
      geometry: { lng: number; lat: number } | null;
    },
    evidence: Evidence[],
    reasons: ResolverReason[],
  ): Promise<void> {
    if (!input.boundaryVersion) {
      reasons.push('NO_BOUNDARY_VERSION');
      this.metrics.increment('administrative_boundary_matches_total', { outcome: 'skipped' });
      return;
    }
    if (!input.geometry) {
      reasons.push('MISSING_GEOMETRY');
      this.metrics.increment('administrative_boundary_matches_total', { outcome: 'skipped' });
      return;
    }
    const point = input.geometry;
    if (!isUsablePoint(point)) {
      // Checked before the query, not after: a NaN reaches PostGIS as a
      // parameter and comes back as an error, and (0,0) is in the Gulf of
      // Guinea, which no Vietnamese polygon will ever claim.
      reasons.push('INVALID_GEOMETRY');
      this.metrics.increment('administrative_boundary_matches_total', {
        outcome: 'invalid_geometry',
      });
      return;
    }

    const pipStartedAt = Date.now();
    const matches = await this.repository.containing(input.boundaryVersion, point, executor);
    this.metrics.observe('administrative_pip_duration_seconds', (Date.now() - pipStartedAt) / 1000);
    const communes = matches.filter((m) => m.level === 'COMMUNE');

    if (communes.length === 1) {
      const match = communes[0]!;
      const unit = await this.repository.currentUnit(
        input.datasetVersionId,
        match.code,
        'COMMUNE',
        executor,
      );
      evidence.push({
        method: 'boundary_point_in_polygon',
        // A unique commune implies its province; the polygon carries it.
        provinceCode: match.parentCode,
        communeCode: match.code,
        // The boundary release and the unit release are pinned separately. If
        // they disagree about this commune's province, that disagreement is a
        // fact to surface, not one to silently prefer one side of.
        hierarchyValid: Boolean(unit) && unit!.parentCode === match.parentCode,
        deterministic: true,
        // A single match can still sit on an edge — a coastline, or a border
        // with a polygon this release does not carry. It still resolves; it
        // just stops being definitional, which the confidence rule reads.
        onEdge: match.onEdge,
        detail: `point in ${match.name} (${match.code})`,
      });
      this.metrics.increment('administrative_boundary_matches_total', {
        outcome: match.onEdge ? 'unique_edge' : 'strict_inside',
      });
      return;
    }

    if (communes.length > 1) {
      const allOnEdge = communes.every((m) => m.onEdge);
      reasons.push(allOnEdge ? 'BOUNDARY_EDGE' : 'MULTIPLE_BOUNDARY_MATCHES');
      for (const match of communes) {
        evidence.push({
          method: 'boundary_point_in_polygon',
          provinceCode: match.parentCode,
          communeCode: match.code,
          hierarchyValid: true,
          // Offered, never chosen. Picking one of two polygons that both
          // contain the point is guessing with a geometric accent.
          deterministic: false,
          detail: `${match.name} (${match.code})${match.onEdge ? ', on the shared edge' : ''}`,
        });
      }
      this.metrics.increment('administrative_boundary_matches_total', {
        outcome: allOnEdge ? 'shared_edge' : 'multiple_overlap',
      });
      return;
    }

    const provinces = matches.filter((m) => m.level === 'PROVINCE');
    if (provinces.length === 1) {
      evidence.push({
        method: 'boundary_point_in_polygon',
        provinceCode: provinces[0]!.code,
        communeCode: null,
        hierarchyValid: true,
        deterministic: true,
        detail: `point in province ${provinces[0]!.name} (${provinces[0]!.code})`,
      });
      this.metrics.increment('administrative_boundary_matches_total', { outcome: 'province_only' });
      return;
    }

    reasons.push('NO_BOUNDARY_MATCH');
    this.metrics.increment('administrative_boundary_matches_total', { outcome: 'no_match' });
  }

  /**
   * Precedence 4: the canonical change mapping, from a code this place already
   * carries.
   *
   * One door in, not two. A stored commune code that is no longer current — the
   * case a place mapped before 2025-07-01 is in — asks whether that old unit has
   * exactly one successor GoGo is willing to assert. It is a **code** being
   * carried forward across releases, not a name being turned into one.
   *
   * The second door used to be a district name matching a dissolved unit. It is
   * gone: see `gather`.
   */
  private async fromHistory(
    executor: Executor,
    input: {
      datasetVersionId: string;
      current: CurrentMapping;
    },
    evidence: Evidence[],
    reasons: ResolverReason[],
  ): Promise<void> {
    const historicalCodes = new Set<string>();

    if (input.current.communeCode) {
      const periods = await this.repository.unitPeriods(
        input.datasetVersionId,
        input.current.communeCode,
        executor,
      );
      // A code is not an identity: 00004 has two periods, and only the ended
      // one is the unit this place was mapped to.
      const isCurrent = periods.some((p) => p.status === 'ACTIVE' && p.effectiveTo === null);
      const ended = periods.find((p) => p.effectiveTo !== null);
      if (!isCurrent && ended) historicalCodes.add(input.current.communeCode);
      if (isCurrent && ended && input.current.datasetVersion === null) {
        // Stored without a dataset version, so which period it meant is
        // unknowable. Treated as historical evidence rather than assumed
        // current — assuming current is how 2,212 codes silently change meaning.
        historicalCodes.add(input.current.communeCode);
      }
    }

    for (const code of historicalCodes) {
      const edges = await this.repository.successorsOf(input.datasetVersionId, code, executor);
      const targets = [...new Set(edges.map((e) => e.newCode))];

      if (targets.length === 1) {
        const successor = await this.repository.currentUnit(
          input.datasetVersionId,
          targets[0]!,
          'COMMUNE',
          executor,
        );
        evidence.push({
          method: 'change_mapping',
          provinceCode: successor?.parentCode ?? null,
          communeCode: targets[0]!,
          hierarchyValid: Boolean(successor),
          deterministic: true,
          detail: `${code} became ${targets[0]!} (${edges[0]!.changeType})`,
        });
        continue;
      }

      if (targets.length > 1) {
        reasons.push('MULTIPLE_SUCCESSORS');
        for (const target of targets) {
          evidence.push({
            method: 'change_mapping',
            provinceCode: null,
            communeCode: target,
            hierarchyValid: true,
            deterministic: false,
            detail: `${code} is mapped to ${target} among ${targets.length} successors`,
          });
        }
        continue;
      }

      // No canonical successor. Overwhelmingly a divided commune, which the
      // importer quarantined precisely because the upstream offers a default
      // target that ADR-0019 forbids anyone from trusting. Name similarity
      // cannot break the tie, so nothing here tries.
      if ((await this.repository.quarantinedCount(input.datasetVersionId, code, executor)) > 0) {
        reasons.push('DIVIDED_CHANGE');
      }
    }
  }

  private async placeRow(executor: Executor, placeId: string) {
    const [row] = await (executor as Db)
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', `no place ${placeId}`);
    return row;
  }

  private async datasetFor(executor: Executor, datasetVersionId: string | undefined) {
    const rows = await (executor as Db)
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(
        datasetVersionId
          ? eq(schema.administrativeDatasetVersions.id, datasetVersionId)
          : eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw AppError.serviceUnavailable(
        'ADMINISTRATIVE_DATASET_UNAVAILABLE',
        datasetVersionId
          ? `no administrative dataset ${datasetVersionId}`
          : 'no administrative dataset is published',
      );
    }
    return row;
  }
}

/** Finite, in range, and plausibly in Vietnam. */
function isUsablePoint(point: { lng: number; lat: number }): boolean {
  if (!Number.isFinite(point.lng) || !Number.isFinite(point.lat)) return false;
  if (point.lng < VN_BOUNDS.minLng || point.lng > VN_BOUNDS.maxLng) return false;
  if (point.lat < VN_BOUNDS.minLat || point.lat > VN_BOUNDS.maxLat) return false;
  return true;
}

type MappingColumns = {
  provinceCode: string | null;
  communeCode: string | null;
  legacyDistrictCode: string | null;
  administrativeMappingStatus: MappingStatus;
  administrativeMappingSource: Resolution['method'];
  administrativeMappingConfidence: string | null;
  administrativeDatasetVersion: string | null;
  administrativeBoundaryVersion: string | null;
  administrativeMappedAt: Date | null;
};

/**
 * The only columns a resolution may write.
 *
 * `administrative_mapped_by` is not among them: an unattended run has no
 * person, so it leaves the column exactly as it found it. The one exception is
 * applied by the caller, not here — an authorised rematch out of a
 * reviewer-owned state clears it, because the decision it named is gone.
 */
function mappingColumns(resolution: Resolution): MappingColumns {
  if (resolution.status === 'UNMAPPED') {
    // Nothing is claimed, so nothing is stamped. This also keeps
    // `places_administrative_version_present` satisfied by construction.
    return {
      provinceCode: null,
      communeCode: null,
      legacyDistrictCode: null,
      administrativeMappingStatus: 'UNMAPPED',
      administrativeMappingSource: null,
      administrativeMappingConfidence: null,
      administrativeDatasetVersion: null,
      administrativeBoundaryVersion: null,
      administrativeMappedAt: null,
    };
  }
  return {
    provinceCode: resolution.provinceCode,
    communeCode: resolution.communeCode,
    legacyDistrictCode: resolution.legacyDistrictCode,
    administrativeMappingStatus: resolution.status,
    administrativeMappingSource: resolution.method,
    administrativeMappingConfidence:
      resolution.confidence === null ? null : resolution.confidence.toFixed(2),
    administrativeDatasetVersion: resolution.datasetVersion,
    administrativeBoundaryVersion: resolution.boundaryVersion,
    administrativeMappedAt: new Date(),
  };
}

/** `mapped_at` is excluded: a re-run that changed nothing else did not map anything. */
function unchanged(row: Record<string, unknown>, next: MappingColumns): boolean {
  const keys = [
    'provinceCode',
    'communeCode',
    'legacyDistrictCode',
    'administrativeMappingStatus',
    'administrativeMappingSource',
    'administrativeMappingConfidence',
    'administrativeDatasetVersion',
    'administrativeBoundaryVersion',
  ] as const;
  return keys.every((key) => (row[key] ?? null) === (next[key] ?? null));
}
