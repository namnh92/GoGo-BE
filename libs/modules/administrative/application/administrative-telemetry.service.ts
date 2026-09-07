import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { GAUGE_SINK, type GaugeSink } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { remediationCategory, type RemediationCategory } from '../domain/approval-policy';

/**
 * ADM-010 (#463) — the administrative feature's current state, as gauges and as
 * a capability report.
 *
 * Counters answer "what happened"; these answer "what is true now". Whether a
 * dataset is published, how old it is, how many places are waiting for a
 * reviewer — none of that can be derived from an event stream, and any process
 * that restarted would answer wrong if it tried.
 *
 * Every label here comes from a closed set: a lifecycle status, a mapping
 * status, a remediation category, a unit level. Deliberately **not** the
 * dataset version, the dataset id, a place id or a checksum — a label whose
 * values grow with time turns a dashboard into a memory leak, which is the
 * mistake `place_import_unknown_mapping_total{field}` already made once here.
 * The exact version lives on the capability endpoint and in the audit log,
 * where a person can read it and nothing has to keep every value forever.
 */

export type CapabilityState = 'AVAILABLE' | 'MISSING' | 'ERROR';
export type ResolverCapability = 'FULL' | 'PARTIAL' | 'UNAVAILABLE';

export type AdministrativeCapability = {
  dataset: {
    state: CapabilityState;
    /** The exact version, here rather than in a Prometheus label. */
    version: string | null;
    publishedAt: string | null;
    ageSeconds: number | null;
    counts: Record<string, number>;
    quarantined: number;
    unresolved: number;
    validation: { errors: number; warnings: number } | null;
  };
  boundaries: {
    state: CapabilityState;
    version: string | null;
    loadedAt: string | null;
    ageSeconds: number | null;
    provinces: number;
    communes: number;
  };
  resolver: ResolverCapability;
  publication: 'ENABLED' | 'BLOCKED';
  mappings: Record<string, number>;
  remediation: Record<RemediationCategory, number>;
  observedAt: string;
};

@Injectable()
export class AdministrativeTelemetryService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(GAUGE_SINK) private readonly gauges?: GaugeSink,
  ) {}

  onModuleInit(): void {
    // Refreshed immediately before each scrape rather than on a timer: a gauge
    // read on a schedule is a gauge that is wrong between schedules, and the
    // queries below are three indexed aggregates.
    this.gauges?.registerCollector(() => this.refresh());
  }

  /** Reads the state once and writes every gauge derived from it. */
  async refresh(): Promise<void> {
    if (!this.gauges) return;
    const capability = await this.capability();
    const g = this.gauges;

    g.gauge('administrative_dataset_active', capability.dataset.state === 'AVAILABLE' ? 1 : 0);
    if (capability.dataset.ageSeconds !== null) {
      g.gauge('administrative_dataset_age_seconds', capability.dataset.ageSeconds);
    }
    for (const [state, n] of Object.entries(capability.dataset.counts)) {
      g.gauge('administrative_datasets', n, { state });
    }
    g.gauge('administrative_quarantined_changes', capability.dataset.quarantined);
    g.gauge('administrative_unresolved_changes', capability.dataset.unresolved);

    g.gauge('administrative_boundary_active', capability.boundaries.state === 'AVAILABLE' ? 1 : 0);
    if (capability.boundaries.ageSeconds !== null) {
      g.gauge('administrative_boundary_age_seconds', capability.boundaries.ageSeconds);
    }
    g.gauge('administrative_boundary_units', capability.boundaries.provinces, {
      level: 'PROVINCE',
    });
    g.gauge('administrative_boundary_units', capability.boundaries.communes, { level: 'COMMUNE' });

    for (const [status, n] of Object.entries(capability.mappings)) {
      g.gauge('administrative_mappings', n, { status });
    }
    for (const [category, n] of Object.entries(capability.remediation)) {
      g.gauge('administrative_remediation', n, { category });
    }
    g.gauge('administrative_publication_enabled', capability.publication === 'ENABLED' ? 1 : 0);
  }

  /**
   * What this environment can currently do.
   *
   * Separate from readiness on purpose. An environment with no administrative
   * dataset can still serve rooms, search, plans and every other route — it
   * simply cannot publish a place, which the domain guard already refuses.
   * Taking the whole API out of the load balancer for that would turn a
   * configuration gap into an outage.
   */
  async capability(): Promise<AdministrativeCapability> {
    const now = Date.now();
    const [dataset] = await this.db
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);

    const datasetCounts = await this.countBy(
      this.db
        .select({
          key: schema.administrativeDatasetVersions.status,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.administrativeDatasetVersions)
        .groupBy(schema.administrativeDatasetVersions.status),
      ['STAGED', 'VALIDATED', 'REJECTED', 'PUBLISHED', 'ROLLED_BACK'],
    );

    const quarantined = dataset
      ? await this.count(schema.administrativeMappingQuarantine, dataset.id)
      : 0;
    const validation = (dataset?.validationReport ?? null) as {
      errors?: number;
      warnings?: number;
    } | null;

    const boundaryVersion = dataset?.boundarySourceVersion ?? null;
    const [load] = boundaryVersion
      ? await this.db
          .select()
          .from(schema.administrativeBoundaryLoads)
          .where(eq(schema.administrativeBoundaryLoads.boundaryVersion, boundaryVersion))
          .limit(1)
      : [];

    const mappings = await this.countBy(
      this.db
        .select({
          key: schema.places.administrativeMappingStatus,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.places)
        .groupBy(schema.places.administrativeMappingStatus),
      ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED', 'STALE'],
    );

    const datasetState: CapabilityState = dataset ? 'AVAILABLE' : 'MISSING';
    const boundaryState: CapabilityState = load ? 'AVAILABLE' : 'MISSING';

    return {
      dataset: {
        state: datasetState,
        version: dataset?.combinedDatasetVersion ?? null,
        publishedAt: dataset?.publishedAt?.toISOString() ?? null,
        ageSeconds: dataset?.publishedAt
          ? Math.round((now - dataset.publishedAt.getTime()) / 1000)
          : null,
        counts: datasetCounts,
        quarantined,
        unresolved: quarantined,
        validation: validation
          ? { errors: validation.errors ?? 0, warnings: validation.warnings ?? 0 }
          : null,
      },
      boundaries: {
        state: boundaryState,
        version: boundaryVersion,
        loadedAt: load?.loadedAt?.toISOString() ?? null,
        ageSeconds: load?.loadedAt ? Math.round((now - load.loadedAt.getTime()) / 1000) : null,
        provinces: load?.provinceCount ?? 0,
        communes: load?.communeCount ?? 0,
      },
      // Without polygons the resolver still answers from explicit codes, stored
      // names and the change mapping — less of the catalogue, not none of it.
      resolver:
        datasetState !== 'AVAILABLE'
          ? 'UNAVAILABLE'
          : boundaryState === 'AVAILABLE'
            ? 'FULL'
            : 'PARTIAL',
      publication: datasetState === 'AVAILABLE' ? 'ENABLED' : 'BLOCKED',
      mappings,
      remediation: await this.remediation(dataset?.combinedDatasetVersion ?? null),
      observedAt: new Date(now).toISOString(),
    };
  }

  /** Approved places that would not pass today's policy, counted by category. */
  private async remediation(
    activeVersion: string | null,
  ): Promise<Record<RemediationCategory, number>> {
    const counts: Record<RemediationCategory, number> = {
      unmapped: 0,
      auto_matched: 0,
      needs_review: 0,
      rejected: 0,
      stale: 0,
      verified_against_older_version: 0,
      compliant: 0,
    };
    if (!activeVersion) return counts;

    const rows = await this.db
      .select({
        status: schema.places.administrativeMappingStatus,
        version: schema.places.administrativeDatasetVersion,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.places)
      .where(eq(schema.places.status, 'published'))
      .groupBy(
        schema.places.administrativeMappingStatus,
        schema.places.administrativeDatasetVersion,
      );

    for (const row of rows) {
      const category = remediationCategory(
        {
          status: row.status,
          provinceCode: null,
          communeCode: null,
          datasetVersion: row.version,
        },
        activeVersion,
      );
      counts[category] += row.n;
    }
    return counts;
  }

  private async count(
    table: typeof schema.administrativeMappingQuarantine,
    datasetVersionId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.datasetVersionId, datasetVersionId), isNull(table.reviewedAt)));
    return row?.n ?? 0;
  }

  /** Groups a count query and fills every expected key, so a gauge never vanishes. */
  private async countBy(
    query: Promise<{ key: string; n: number }[]>,
    keys: string[],
  ): Promise<Record<string, number>> {
    const rows = await query;
    const counts = Object.fromEntries(keys.map((key) => [key, 0]));
    for (const row of rows) counts[row.key] = row.n;
    return counts;
  }
}
