import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { normalizeVietnamese } from '../../search/domain/normalize';
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
 * boundaries, the free text an editor or an import already wrote into
 * `city`/`district`, and GoGo's own pinned unit and change data. That list is
 * ADR-0019 §10 and GoGo-BE#464, and it is why the resulting codes are GoGo
 * facts rather than provider content.
 *
 * Nothing outside the `administrative_*` columns is ever written. `name`,
 * `city`, `district`, `address_text` and `geom` are the evidence; a resolver
 * that edited its own inputs would make its next run unreproducible.
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

export type PersistOutcome = 'written' | 'noop' | 'conflict' | 'blocked';

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
    const startedAt = Date.now();
    const place = await this.placeRow(placeId);
    const dataset = await this.datasetFor(options.datasetVersionId);

    const current: CurrentMapping = {
      status: place.administrativeMappingStatus,
      provinceCode: place.provinceCode,
      communeCode: place.communeCode,
      legacyDistrictCode: place.legacyDistrictCode,
      method: place.administrativeMappingSource,
      datasetVersion: place.administrativeDatasetVersion,
      boundaryVersion: place.administrativeBoundaryVersion,
    };
    const boundaryVersion =
      options.boundaryVersion === undefined
        ? dataset.boundarySourceVersion
        : options.boundaryVersion;

    const { evidence, reasons } = await this.gather({
      datasetVersionId: dataset.id,
      boundaryVersion,
      geometry: place.geom,
      city: place.city,
      district: place.district,
      current,
      ...(options.trustedCodes === undefined ? {} : { trustedCodes: options.trustedCodes }),
    });

    const resolution = adjudicate({
      placeId,
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
      {
        status: resolution.status,
      },
    );
    return resolution;
  }

  /**
   * Is this place's stored mapping still true against the published dataset?
   *
   * Evaluation only — see `domain/staleness.ts`. Nothing here writes `STALE`,
   * and nothing here re-points a `VERIFIED` place.
   */
  async evaluateStalenessFor(placeId: string): Promise<StaleVerdict> {
    const place = await this.placeRow(placeId);
    const dataset = await this.datasetFor(undefined);
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
  async persist(
    resolution: Resolution,
    options: {
      actor?: { id: string | null; type: 'admin' | 'system' };
      /** Optimistic concurrency: the `updated_at` the caller last saw. */
      expectedUpdatedAt?: Date;
      allowRematchRejected?: boolean;
    } = {},
  ): Promise<PersistResult> {
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
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

      await tx
        .update(schema.places)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(schema.places.id, resolution.placeId));

      await writeAudit(tx, {
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
    });

    this.metrics.increment('administrative_mapping_writes_total', { outcome: result.outcome });
    return result;
  }

  /**
   * Evidence gathering, in ADR-0019 §10's order.
   *
   * Every provider runs even when an earlier one succeeded. That is deliberate:
   * stopping at the first hit would hide the case where two sources disagree,
   * and a disagreement between an explicit code and the geometry is the single
   * most useful thing this resolver can tell a reviewer.
   */
  private async gather(input: {
    datasetVersionId: string;
    boundaryVersion: string | null;
    geometry: { x: number; y: number } | null;
    city: string | null;
    district: string | null;
    current: CurrentMapping;
    trustedCodes?: ResolveOptions['trustedCodes'];
  }): Promise<{ evidence: Evidence[]; reasons: ResolverReason[] }> {
    const evidence: Evidence[] = [];
    const reasons: ResolverReason[] = [];

    await this.fromTrustedCodes(input, evidence);
    await this.fromBoundary(input, evidence, reasons);
    const provinceCode = await this.fromNames(input, evidence, reasons);
    await this.fromHistory(input, provinceCode, evidence, reasons);

    if (evidence.length === 0 && reasons.length === 0) reasons.push('NO_EVIDENCE');
    return { evidence, reasons };
  }

  /** Precedence 2: codes an import or an editor asserted outright. */
  private async fromTrustedCodes(
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
    input: {
      datasetVersionId: string;
      boundaryVersion: string | null;
      geometry: { x: number; y: number } | null;
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
    const point = { lng: input.geometry.x, lat: input.geometry.y };
    if (!isUsablePoint(point)) {
      // Checked before the query, not after: a NaN reaches PostGIS as a
      // parameter and comes back as an error, and (0,0) is in the Gulf of
      // Guinea, which no Vietnamese polygon will ever claim.
      reasons.push('INVALID_GEOMETRY');
      this.metrics.increment('administrative_boundary_matches_total', { outcome: 'invalid' });
      return;
    }

    const matches = await this.repository.containing(input.boundaryVersion, point);
    const communes = matches.filter((m) => m.level === 'COMMUNE');

    if (communes.length === 1) {
      const match = communes[0]!;
      const unit = await this.repository.currentUnit(input.datasetVersionId, match.code, 'COMMUNE');
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
      this.metrics.increment('administrative_boundary_matches_total', { outcome: 'unique' });
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
        outcome: allOnEdge ? 'edge' : 'multiple',
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
    this.metrics.increment('administrative_boundary_matches_total', { outcome: 'none' });
  }

  /**
   * Precedence 4: the free text already stored on the place.
   *
   * `city` and `district` are read, never written. ADR-0016 keeps them free
   * text because an editor must be able to type a unit the catalog does not
   * carry; ADR-0019 adds codes beside them and changes nothing about them.
   *
   * Returns the province the city text resolved to, if any, so the historical
   * pass can use it to narrow.
   */
  private async fromNames(
    input: { datasetVersionId: string; city: string | null; district: string | null },
    evidence: Evidence[],
    reasons: ResolverReason[],
  ): Promise<string | null> {
    let provinceCode: string | null = null;
    if (input.city) {
      const provinces = await this.repository.unitsByNormalizedName(
        input.datasetVersionId,
        normalizeVietnamese(input.city),
        { level: 'PROVINCE', period: 'current' },
      );
      if (provinces.length === 1) provinceCode = provinces[0]!.code;
      else if (provinces.length > 1) reasons.push('AMBIGUOUS_NAME');
    }

    if (!input.district) {
      if (provinceCode) {
        evidence.push({
          method: 'exact_name',
          provinceCode,
          communeCode: null,
          hierarchyValid: true,
          deterministic: true,
          detail: `city text matched province ${provinceCode}`,
        });
      }
      return provinceCode;
    }

    const normalized = normalizeVietnamese(input.district);
    const communes = await this.repository.unitsByNormalizedName(
      input.datasetVersionId,
      normalized,
      {
        level: 'COMMUNE',
        period: 'current',
        // "Phường Tân Bình" exists under several provinces. Narrowing by the
        // city text is what turns a duplicate name into an identity; without a
        // city the duplicates stay a review task.
        ...(provinceCode ? { parentCode: provinceCode } : {}),
      },
    );

    if (communes.length === 1) {
      evidence.push({
        method: provinceCode ? 'structured_components' : 'exact_name',
        provinceCode: communes[0]!.parentCode,
        communeCode: communes[0]!.code,
        hierarchyValid: true,
        deterministic: true,
        detail: `name "${input.district}" matched ${communes[0]!.fullName}`,
      });
      return provinceCode;
    }

    if (communes.length > 1) {
      reasons.push('AMBIGUOUS_NAME');
      for (const commune of communes) {
        evidence.push({
          method: 'exact_name',
          provinceCode: commune.parentCode,
          communeCode: commune.code,
          hierarchyValid: true,
          deterministic: false,
          detail: `${commune.fullName} (${commune.code})`,
        });
      }
      return provinceCode;
    }

    if (provinceCode) {
      evidence.push({
        method: 'exact_name',
        provinceCode,
        communeCode: null,
        hierarchyValid: true,
        deterministic: true,
        detail: `city text matched province ${provinceCode}, district text matched no current commune`,
      });
    }
    return provinceCode;
  }

  /**
   * Precedence 5: historical names and the canonical change mapping.
   *
   * Two doors in. A stored commune code that is no longer current — the case a
   * place mapped before 2025-07-01 is in — and a district name that names a
   * dissolved unit. Both end at the same question: does this old unit have
   * exactly one successor GoGo is willing to assert?
   */
  private async fromHistory(
    input: {
      datasetVersionId: string;
      district: string | null;
      current: CurrentMapping;
    },
    provinceCode: string | null,
    evidence: Evidence[],
    reasons: ResolverReason[],
  ): Promise<void> {
    const historicalCodes = new Set<string>();

    if (input.current.communeCode) {
      const periods = await this.repository.unitPeriods(
        input.datasetVersionId,
        input.current.communeCode,
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

    if (input.district) {
      const normalized = normalizeVietnamese(input.district);
      const districts = await this.repository.unitsByNormalizedName(
        input.datasetVersionId,
        normalized,
        { level: 'LEGACY_DISTRICT', period: 'historical' },
      );
      if (districts.length === 1) {
        evidence.push({
          method: 'exact_name',
          provinceCode: null,
          communeCode: null,
          legacyDistrictCode: districts[0]!.code,
          hierarchyValid: true,
          deterministic: true,
          detail: `district text matched dissolved ${districts[0]!.fullName} (${districts[0]!.code})`,
        });
      }
      const communes = await this.repository.unitsByNormalizedName(
        input.datasetVersionId,
        normalized,
        { level: 'COMMUNE', period: 'historical' },
      );
      if (communes.length === 1) historicalCodes.add(communes[0]!.code);
    }

    for (const code of historicalCodes) {
      const edges = await this.repository.successorsOf(input.datasetVersionId, code);
      const targets = [...new Set(edges.map((e) => e.newCode))];

      if (targets.length === 1) {
        const successor = await this.repository.currentUnit(
          input.datasetVersionId,
          targets[0]!,
          'COMMUNE',
        );
        evidence.push({
          method: 'change_mapping',
          provinceCode: successor?.parentCode ?? null,
          communeCode: targets[0]!,
          hierarchyValid:
            Boolean(successor) && (provinceCode === null || successor!.parentCode === provinceCode),
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
      if ((await this.repository.quarantinedCount(input.datasetVersionId, code)) > 0) {
        reasons.push('DIVIDED_CHANGE');
      }
    }
  }

  private async placeRow(placeId: string) {
    const [row] = await this.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', `no place ${placeId}`);
    return row;
  }

  private async datasetFor(datasetVersionId: string | undefined) {
    const rows = await this.db
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
