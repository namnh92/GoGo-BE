import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { normalizeVietnamese } from '../../search/domain/normalize';
import {
  anomaly,
  validateBoundaries,
  type Anomaly,
  type BoundaryMeasurements,
  type BoundaryValidationReport,
} from '../domain/boundary-validation';
import {
  BoundaryArchiveReader,
  type BoundaryFeature,
  type ResolvedArchive,
} from './boundary-archive.reader';
import type { ManifestSource } from './pinned-snapshot.reader';

/**
 * ADM-007 (#460) / ADR-0019 — loading a pinned boundary release.
 *
 * Four properties, each of which the obvious implementation loses:
 *
 * 1. **Checksum before mutation.** The archive is verified before a single
 *    entry is inflated, let alone written. A drifted archive is not the archive
 *    the coverage counts and the licence review were done against.
 * 2. **One transaction.** Delete-then-insert for the version happens inside it,
 *    so a version is never half visible. The resolver reads by
 *    `boundary_version`; a partially loaded one would answer some points and
 *    silently fail others, which is worse than answering none.
 * 3. **Validation before commit.** Every gate runs against the rows as
 *    inserted, in the same transaction, and an ERROR rolls the whole load back.
 *    Validating afterwards would mean publishing a release and then discovering
 *    it was unusable.
 * 4. **Nothing is repaired.** No `ST_MakeValid`, no reprojection, no
 *    simplification. `ST_Multi` is the only normalization and it is declared:
 *    it promotes a Polygon to a MultiPolygon so the column type holds, and it
 *    changes no coordinate. An invalid polygon is an ERROR that names the unit,
 *    because repairing one silently would move a border and nobody would know.
 *
 * A failed load leaves the previously loaded version exactly as it was: the
 * transaction rolls back, and the resolver keeps answering from the release it
 * already had.
 */

export type BoundaryLoadOutcome = 'loaded' | 'unchanged';

export type BoundaryLoadResult = {
  outcome: BoundaryLoadOutcome;
  boundaryVersion: string;
  archive: ResolvedArchive;
  counts: { provinces: number; communes: number };
  /** Features whose geometry was a Polygon and had to be promoted. */
  promotedToMultiPolygon: number;
  validation: BoundaryValidationReport;
  topology: TopologyReport;
  durationMs: number;
};

export type TopologyReport = {
  sameLevelOverlaps: Anomaly;
  communesOutsideProvince: Anomaly;
  areaOutliers: Anomaly;
  duplicateGeometryHashes: Anomaly;
  outsideVietnamBbox: Anomaly;
  /** Pairs of communes that share a border. Expected, and worth counting. */
  sharedBoundaryPairs: number;
  measuredAreaKm2: { total: number; largest: string; smallest: string };
};

export class BoundaryVersionConflictError extends Error {
  constructor(version: string, stored: string, incoming: string) {
    super(
      `boundary version ${version} is already loaded from a different archive ` +
        `(stored ${stored}, incoming ${incoming}). A version name identifies its contents; ` +
        `load the new archive under its own version rather than redefining this one.`,
    );
    this.name = 'BoundaryVersionConflictError';
  }
}

export class BoundaryValidationError extends Error {
  constructor(readonly report: BoundaryValidationReport) {
    const gates = report.findings
      .filter((f) => f.severity === 'ERROR')
      .map((f) => `${f.gate}(${f.count})`)
      .join(', ');
    super(`boundary release ${report.boundaryVersion} failed validation: ${gates}`);
    this.name = 'BoundaryValidationError';
  }
}

/** Rows per insert. Bounds the parameter payload; the archive expands to 629 MB. */
const INSERT_BATCH = 20;

/** Vietnam, generously drawn. Offshore special zones are expected to sit near its edge. */
const VN_ENVELOPE = { minLng: 102, minLat: 6, maxLng: 118, maxLat: 24 };

/** A source area this far from the measured one is worth a look, not a refusal. */
const AREA_OUTLIER_RATIO = 0.25;

@Injectable()
export class AdministrativeBoundaryImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly archives: BoundaryArchiveReader = new BoundaryArchiveReader(),
  ) {}

  /**
   * Loads one pinned release. Idempotent: the same archive under the same
   * version is a no-op that reports `unchanged`, and a different archive under
   * the same version is refused rather than merged.
   */
  async load(
    options: {
      role?: string;
      boundaryVersion?: string;
      archivePath?: string;
      datasetVersionId?: string;
    } = {},
  ): Promise<BoundaryLoadResult> {
    const startedAt = Date.now();
    const source = this.archives.source(options.role ?? 'current-boundaries');
    const boundaryVersion = options.boundaryVersion ?? source.ref;
    const archive = await this.archives.resolve(source, options.archivePath);

    const existing = await this.existingLoad(boundaryVersion);
    if (existing) {
      if (existing.sourceChecksum !== archive.sha256) {
        throw new BoundaryVersionConflictError(
          boundaryVersion,
          existing.sourceChecksum,
          archive.sha256,
        );
      }
      return {
        outcome: 'unchanged',
        boundaryVersion,
        archive,
        counts: { provinces: existing.provinceCount, communes: existing.communeCount },
        promotedToMultiPolygon: 0,
        validation: existing.validationReport as BoundaryValidationReport,
        topology: existing.topologyReport as TopologyReport,
        durationMs: Date.now() - startedAt,
      };
    }

    const datasetVersionId = await this.datasetVersionId(options.datasetVersionId);

    return this.db.transaction(async (tx) => {
      // Replacing a version is delete-then-insert inside the transaction, so no
      // reader ever sees the gap.
      await tx.execute(
        sql`delete from administrative_unit_boundaries where boundary_version = ${boundaryVersion}`,
      );

      let provinces = 0;
      let communes = 0;
      let promoted = 0;
      const areaByCode = new Map<string, number>();
      let batch: BoundaryFeature[] = [];

      const flush = async () => {
        if (batch.length === 0) return;
        await this.insert(tx, boundaryVersion, source, archive, batch);
        batch = [];
      };

      for (const feature of this.archives.features(archive.path)) {
        if (feature.geometryType !== 'MultiPolygon') promoted += 1;
        if (feature.level === 'PROVINCE') provinces += 1;
        else communes += 1;
        if (feature.areaKm2 !== null)
          areaByCode.set(`${feature.level}:${feature.code}`, feature.areaKm2);
        batch.push(feature);
        if (batch.length >= INSERT_BATCH) await flush();
      }
      await flush();

      const measurements = await this.measure(tx, boundaryVersion, datasetVersionId, source, {
        provinces,
        communes,
      });
      const topology = await this.topology(tx, boundaryVersion, areaByCode);
      const validation = validateBoundaries({
        ...measurements,
        sameLevelOverlaps: topology.sameLevelOverlaps,
        communesOutsideProvince: topology.communesOutsideProvince,
        areaOutliers: topology.areaOutliers,
        duplicateGeometryHashes: topology.duplicateGeometryHashes,
        outsideVietnamBbox: topology.outsideVietnamBbox,
      });

      // An ERROR rolls back everything above, including the delete — so a failed
      // reload of an existing version leaves that version exactly as it was.
      if (!validation.loadable) throw new BoundaryValidationError(validation);

      const durationMs = Date.now() - startedAt;
      await tx.insert(schema.administrativeBoundaryLoads).values({
        boundaryVersion,
        source: `${source.repository}@${source.ref}`,
        sourceUrl: source.fetchUrl ?? null,
        sourceCommit: source.commit,
        sourceChecksum: archive.sha256,
        license: source.license,
        provinceCount: provinces,
        communeCount: communes,
        validationReport: validation,
        topologyReport: topology,
        loadDurationMs: durationMs,
      });

      return {
        outcome: 'loaded' as const,
        boundaryVersion,
        archive,
        counts: { provinces, communes },
        promotedToMultiPolygon: promoted,
        validation,
        topology,
        durationMs,
      };
    });
  }

  /**
   * `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(...), 4326))`.
   *
   * `ST_SetSRID` rather than `ST_Transform`: GeoJSON is WGS84 by specification
   * and `places.geom` is SRID 4326, so this labels the frame the coordinates are
   * already in. Nothing is reprojected, and nothing is repaired.
   */
  private async insert(
    tx: Tx,
    boundaryVersion: string,
    source: ManifestSource,
    archive: ResolvedArchive,
    features: BoundaryFeature[],
  ): Promise<void> {
    const values = features.map(
      (f) => sql`(
        ${boundaryVersion}, ${f.code}, ${f.level}::administrative_level, ${f.parentCode},
        ${f.fullName}, ${normalizeVietnamese(f.fullName)},
        st_multi(st_setsrid(st_geomfromgeojson(${JSON.stringify(f.geometry)}), 4326)),
        ${`${source.repository}@${source.ref}:${f.entry}`}, ${archive.sha256})`,
    );
    await tx.execute(sql`
      insert into administrative_unit_boundaries
        (boundary_version, code, level, parent_code, name, name_normalized, geom, source, source_checksum)
      values ${sql.join(values, sql`, `)}`);
  }

  /** The structural gates, measured in PostgreSQL against the rows as inserted. */
  private async measure(
    tx: Tx,
    boundaryVersion: string,
    datasetVersionId: string,
    source: ManifestSource,
    counts: { provinces: number; communes: number },
  ): Promise<
    Omit<
      BoundaryMeasurements,
      | 'sameLevelOverlaps'
      | 'communesOutsideProvince'
      | 'areaOutliers'
      | 'duplicateGeometryHashes'
      | 'outsideVietnamBbox'
    >
  > {
    // Counted and sampled separately. A `LIMIT` produces a list, never a
    // measurement: reporting the length of a capped list as the number of
    // defects is how "200 overlaps" gets written about a release that has a
    // different number.
    const measured = async (
      from: ReturnType<typeof sql>,
      select: ReturnType<typeof sql> = sql`b.code`,
    ): Promise<Anomaly> => {
      const [count, sample] = await Promise.all([
        tx.execute(sql`select count(*)::int as n from (select 1 from ${from}) s`),
        tx.execute(sql`select ${select} as code from ${from} limit 200`),
      ]);
      return anomaly(
        (count as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0,
        (sample as unknown as { rows: { code: string }[] }).rows.map((r) => r.code),
      );
    };
    const scope = sql`b.boundary_version = ${boundaryVersion}`;
    const boundaries = (predicate: ReturnType<typeof sql>) =>
      sql`administrative_unit_boundaries b where ${scope} and ${predicate}`;

    const [
      invalid,
      empty,
      wrongSrid,
      wrongType,
      unsupported,
      unresolved,
      mismatched,
      duplicates,
      legacy,
    ] = await Promise.all([
      measured(boundaries(sql`not st_isvalid(b.geom)`)),
      measured(boundaries(sql`st_isempty(b.geom)`)),
      measured(boundaries(sql`st_srid(b.geom) <> 4326`)),
      measured(boundaries(sql`geometrytype(b.geom) <> 'MULTIPOLYGON'`)),
      measured(boundaries(sql`b.level not in ('PROVINCE','COMMUNE')`)),
      measured(
        boundaries(sql`not exists (
            select 1 from administrative_units u
            where u.dataset_version_id = ${datasetVersionId} and u.code = b.code
              and u.level = b.level and u.status = 'ACTIVE' and u.effective_to is null)`),
      ),
      measured(
        sql`administrative_unit_boundaries b
              join administrative_units u
                on u.dataset_version_id = ${datasetVersionId} and u.code = b.code and u.level = b.level
               and u.status = 'ACTIVE' and u.effective_to is null
              where ${scope} and b.level = 'COMMUNE' and b.parent_code is distinct from u.parent_code`,
        sql`b.code || ': ' || coalesce(b.parent_code,'null') || ' -> ' || coalesce(u.parent_code,'null')`,
      ),
      measured(
        sql`(select b.level, b.code from administrative_unit_boundaries b
               where ${scope} group by b.level, b.code having count(*) > 1) b`,
        sql`b.level || ':' || b.code`,
      ),
      measured(boundaries(sql`b.level = 'LEGACY_DISTRICT'`)),
    ]);

    // Only a release claiming complete coverage can be missing a unit. The test
    // fixture is five real entries and declares itself partial, so it is held
    // to its own declared counts instead of to all 3,321 communes.
    const complete = source.coverage !== 'partial';
    const missing = async (level: 'PROVINCE' | 'COMMUNE'): Promise<Anomaly> =>
      !complete
        ? anomaly(0, [])
        : measured(
            sql`administrative_units b
                where b.dataset_version_id = ${datasetVersionId} and b.level = ${level}
                  and b.status = 'ACTIVE' and b.effective_to is null
                  and not exists (
                    select 1 from administrative_unit_boundaries x
                    where x.boundary_version = ${boundaryVersion} and x.code = b.code and x.level = b.level)`,
          );

    const indexes = await tx.execute(sql`
      select indexname from pg_indexes where tablename = 'administrative_unit_boundaries'`);
    const indexNames = (indexes as unknown as { rows: { indexname: string }[] }).rows.map(
      (r) => r.indexname,
    );

    return {
      boundaryVersion,
      provinceCount: counts.provinces,
      communeCount: counts.communes,
      expected: {
        provinces: source.expected?.provinces ?? counts.provinces,
        communes: source.expected?.communes ?? counts.communes,
      },
      invalidGeometries: invalid,
      emptyGeometries: empty,
      wrongSrid,
      wrongType,
      unsupportedLevels: unsupported,
      unresolvedCodes: unresolved,
      parentMismatches: mismatched,
      duplicateIdentities: duplicates,
      legacyDistrictRows: legacy,
      missingProvinceCodes: await missing('PROVINCE'),
      missingCommuneCodes: await missing('COMMUNE'),
      spatialIndexPresent: indexNames.includes('administrative_boundaries_geom_gist'),
    };
  }

  /**
   * The anomalies worth reporting and never worth blocking on.
   *
   * `ST_Overlaps` rather than `ST_Intersects`: neighbours sharing a border
   * intersect by design, and counting 3,300 shared borders as defects would
   * bury the handful of genuine overlaps. The shared borders are counted
   * separately, because "how many units touch" is the sanity check that the
   * release is a partition of a country rather than a pile of shapes.
   */
  private async topology(
    tx: Tx,
    boundaryVersion: string,
    areaByCode: Map<string, number>,
  ): Promise<TopologyReport> {
    const scope = sql`boundary_version = ${boundaryVersion}`;
    const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> => {
      const result = await tx.execute(query);
      return (result as unknown as { rows: T[] }).rows;
    };

    const measured = async (
      from: ReturnType<typeof sql>,
      select: ReturnType<typeof sql>,
    ): Promise<Anomaly> => {
      const [count, sample] = await Promise.all([
        rows<{ n: number }>(sql`select count(*)::int as n from (select 1 from ${from}) s`),
        rows<{ code: string }>(sql`select ${select} as code from ${from} limit 200`),
      ]);
      return anomaly(
        count[0]?.n ?? 0,
        sample.map((r) => r.code),
      );
    };

    const pairs = (predicate: ReturnType<typeof sql>) => sql`
      administrative_unit_boundaries a
      join administrative_unit_boundaries b
        on b.boundary_version = a.boundary_version and b.level = a.level and b.code > a.code
       and ${predicate}
      where a.boundary_version = ${boundaryVersion}`;

    const overlaps = await measured(
      pairs(sql`st_overlaps(a.geom, b.geom)`),
      sql`a.level || ' ' || a.code || '/' || b.code`,
    );
    const touching = await rows<{ n: number }>(sql`
      select count(*)::int as n from (select 1 from ${pairs(sql`st_touches(a.geom, b.geom)`)}) s`);

    const outside = await measured(
      sql`administrative_unit_boundaries c
          join administrative_unit_boundaries p
            on p.boundary_version = c.boundary_version and p.level = 'PROVINCE' and p.code = c.parent_code
          where c.boundary_version = ${boundaryVersion} and c.level = 'COMMUNE'
            and not st_coveredby(c.geom, p.geom)`,
      sql`c.code`,
    );

    const duplicateShapes = await measured(
      sql`(select md5(st_asbinary(geom)) as hash from administrative_unit_boundaries
           where ${scope} group by md5(st_asbinary(geom)) having count(*) > 1) d`,
      sql`d.hash`,
    );

    const bbox = await measured(
      sql`administrative_unit_boundaries e
          where e.boundary_version = ${boundaryVersion} and not st_within(
            st_envelope(e.geom),
            st_makeenvelope(${VN_ENVELOPE.minLng}, ${VN_ENVELOPE.minLat}, ${VN_ENVELOPE.maxLng}, ${VN_ENVELOPE.maxLat}, 4326))`,
      sql`e.code`,
    );

    const areas = await rows<{ level: string; code: string; km2: number }>(sql`
      select level, code, (st_area(geom::geography) / 1000000.0)::float8 as km2
      from administrative_unit_boundaries where ${scope}`);

    const areaOutliers: string[] = [];
    let total = 0;
    let largest = { code: '', km2: -1 };
    let smallest = { code: '', km2: Number.POSITIVE_INFINITY };
    for (const row of areas) {
      if (row.level === 'COMMUNE') total += row.km2;
      if (row.km2 > largest.km2) largest = { code: `${row.level}:${row.code}`, km2: row.km2 };
      if (row.km2 < smallest.km2) smallest = { code: `${row.level}:${row.code}`, km2: row.km2 };
      const published = areaByCode.get(`${row.level}:${row.code}`);
      if (published && published > 0) {
        const ratio = Math.abs(row.km2 - published) / published;
        if (ratio > AREA_OUTLIER_RATIO) {
          areaOutliers.push(
            `${row.code}: measured ${row.km2.toFixed(1)} vs published ${published}`,
          );
        }
      }
    }

    return {
      sameLevelOverlaps: overlaps,
      communesOutsideProvince: outside,
      areaOutliers: anomaly(areaOutliers.length, areaOutliers),
      duplicateGeometryHashes: duplicateShapes,
      outsideVietnamBbox: bbox,
      sharedBoundaryPairs: touching[0]?.n ?? 0,
      measuredAreaKm2: {
        total: Number(total.toFixed(1)),
        largest: `${largest.code} ${largest.km2.toFixed(1)}`,
        smallest: `${smallest.code} ${smallest.km2.toFixed(3)}`,
      },
    };
  }

  private async existingLoad(boundaryVersion: string) {
    const [row] = await this.db
      .select()
      .from(schema.administrativeBoundaryLoads)
      .where(eq(schema.administrativeBoundaryLoads.boundaryVersion, boundaryVersion))
      .limit(1);
    return row ?? null;
  }

  /** The dataset whose current units the boundary codes must resolve against. */
  private async datasetVersionId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const [row] = await this.db
      .select({ id: schema.administrativeDatasetVersions.id })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);
    if (!row) {
      throw new Error(
        'no administrative dataset is published; boundary codes are validated against the ' +
          'pinned current units, so there is nothing to validate them against yet',
      );
    }
    return row.id;
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
