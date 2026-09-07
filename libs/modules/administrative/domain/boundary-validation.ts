/**
 * ADM-007 (#460) / ADR-0019 — what must be true of a boundary release before it
 * is allowed to answer "which commune is this point in".
 *
 * The split between ERROR and WARNING is the whole design. Vietnam's real
 * geography is full of things that look wrong to a naive checker and are not:
 * communes that share a border with themselves across a river mouth, islands
 * hundreds of kilometres offshore, a coastline that leaves gaps against any
 * simplified province outline. A gate that blocked on those would be a gate
 * operators learn to bypass, and then the gates that matter go with it.
 *
 * So: **ERROR is a structural impossibility** — geometry PostGIS cannot use, a
 * code no unit holds, a hierarchy the units contradict, a duplicate identity,
 * a count that says the archive is not the archive that was pinned. Every one
 * of those makes the release unusable or dishonest.
 *
 * **WARNING is a coherent geographic anomaly** — overlaps, outliers, gaps,
 * duplicated shapes. Each is worth a person's attention and none of them is
 * grounds for refusing a release the source shipped deliberately.
 */

export type BoundarySeverity = 'ERROR' | 'WARNING';

export type BoundaryGateId =
  | 'GEOMETRY_VALID'
  | 'GEOMETRY_NOT_EMPTY'
  | 'GEOMETRY_SRID'
  | 'GEOMETRY_TYPE'
  | 'SUPPORTED_LEVEL'
  | 'CODE_RESOLVES'
  | 'PARENT_MATCHES_UNITS'
  | 'DUPLICATE_IDENTITY'
  | 'NO_LEGACY_DISTRICT'
  | 'PROVINCE_COVERAGE'
  | 'COMMUNE_COVERAGE'
  | 'SPATIAL_INDEX_PRESENT'
  | 'SAME_LEVEL_OVERLAP'
  | 'COMMUNE_OUTSIDE_PROVINCE'
  | 'AREA_OUTLIER'
  | 'DUPLICATE_GEOMETRY'
  | 'BBOX_OUTSIDE_VIETNAM';

export type BoundaryFinding = {
  gate: BoundaryGateId;
  severity: BoundarySeverity;
  message: string;
  count: number;
  samples: string[];
};

export const BOUNDARY_SAMPLE_LIMIT = 10;

/**
 * A measured anomaly: how many there are, and a bounded window onto them.
 *
 * The count and the samples are separate because they answer different
 * questions and one of them must not be inferred from the other. An early
 * version returned only the rows a `LIMIT 200` produced, and reported "200
 * overlaps" for a release that has a different number — a figure that reads
 * like a measurement and is an artefact of the query.
 */
export type Anomaly = { count: number; samples: string[] };

export function anomaly(count: number, samples: string[]): Anomaly {
  return { count, samples: samples.slice(0, BOUNDARY_SAMPLE_LIMIT) };
}

/** Measurements the loader takes in PostgreSQL and hands here to be judged. */
export type BoundaryMeasurements = {
  boundaryVersion: string;
  provinceCount: number;
  communeCount: number;
  expected: { provinces: number; communes: number };
  invalidGeometries: Anomaly;
  emptyGeometries: Anomaly;
  wrongSrid: Anomaly;
  /** Anything that is not a MultiPolygon after normalization. */
  wrongType: Anomaly;
  unsupportedLevels: Anomaly;
  /** Boundary codes with no current unit of that level in the pinned dataset. */
  unresolvedCodes: Anomaly;
  /** `code: boundary parent -> unit parent`, where the two disagree. */
  parentMismatches: Anomaly;
  duplicateIdentities: Anomaly;
  legacyDistrictRows: Anomaly;
  missingProvinceCodes: Anomaly;
  missingCommuneCodes: Anomaly;
  spatialIndexPresent: boolean;
  /** Coherent anomalies, measured but never blocking. */
  sameLevelOverlaps: Anomaly;
  communesOutsideProvince: Anomaly;
  areaOutliers: Anomaly;
  duplicateGeometryHashes: Anomaly;
  outsideVietnamBbox: Anomaly;
};

export type BoundaryValidationReport = {
  boundaryVersion: string;
  ranAt: string;
  findings: BoundaryFinding[];
  errors: number;
  warnings: number;
  /** True exactly when no ERROR fired. Nothing else may gate a load. */
  loadable: boolean;
  counts: { provinces: number; communes: number };
};

export function validateBoundaries(m: BoundaryMeasurements): BoundaryValidationReport {
  const findings: BoundaryFinding[] = [];

  const error = (gate: BoundaryGateId, rows: Anomaly, message: string) => {
    if (rows.count > 0) findings.push(finding(gate, 'ERROR', rows, message));
  };
  const warn = (gate: BoundaryGateId, rows: Anomaly, message: string) => {
    if (rows.count > 0) findings.push(finding(gate, 'WARNING', rows, message));
  };

  // --- structural impossibilities ------------------------------------------
  error(
    'GEOMETRY_VALID',
    m.invalidGeometries,
    'geometry PostGIS reports as invalid; containment against it is undefined, ' +
      'and repairing it silently would change which commune a point falls in',
  );
  error('GEOMETRY_NOT_EMPTY', m.emptyGeometries, 'empty geometry: a unit that contains nothing');
  error(
    'GEOMETRY_SRID',
    m.wrongSrid,
    'geometry is not SRID 4326, so it cannot be compared with places.geom',
  );
  error('GEOMETRY_TYPE', m.wrongType, 'geometry is not a MultiPolygon after normalization');
  error('SUPPORTED_LEVEL', m.unsupportedLevels, 'boundary level is neither PROVINCE nor COMMUNE');
  error(
    'CODE_RESOLVES',
    m.unresolvedCodes,
    'boundary code names no current unit in the pinned dataset; a polygon for a unit ' +
      'GoGo does not hold could only ever produce a code that resolves to nothing',
  );
  error(
    'PARENT_MATCHES_UNITS',
    m.parentMismatches,
    'the boundary release and the unit release disagree about which province this commune is in',
  );
  error(
    'DUPLICATE_IDENTITY',
    m.duplicateIdentities,
    'two boundary rows claim one code at this version',
  );
  error(
    'NO_LEGACY_DISTRICT',
    m.legacyDistrictRows,
    'legacy district geometry: the units were dissolved before any of these releases were drawn',
  );
  // Two different failures, both fatal. A count that does not match the pin
  // means the archive is not the archive the coverage was established against;
  // a named unit with no polygon means the archive is the right one and is
  // short. The first is caught even when the second cannot be — a partial
  // release is not checked against every current unit, but it is still checked
  // against what it said it contained.
  error(
    'PROVINCE_COVERAGE',
    countMismatch(m.provinceCount, m.expected.provinces, m.missingProvinceCodes),
    `province coverage: ${m.provinceCount}/${m.expected.provinces} loaded`,
  );
  error(
    'COMMUNE_COVERAGE',
    countMismatch(m.communeCount, m.expected.communes, m.missingCommuneCodes),
    `commune coverage: ${m.communeCount}/${m.expected.communes} loaded`,
  );
  if (!m.spatialIndexPresent) {
    findings.push(
      finding(
        'SPATIAL_INDEX_PRESENT',
        'ERROR',
        anomaly(1, ['administrative_boundaries_geom_gist']),
        'the GiST index is missing; every resolution would scan every polygon',
      ),
    );
  }

  // --- coherent anomalies ---------------------------------------------------
  warn(
    'SAME_LEVEL_OVERLAP',
    m.sameLevelOverlaps,
    'two units of the same level overlap by more than a shared border. A point in the ' +
      'overlap resolves to NEEDS_REVIEW rather than to a guess, so this degrades review ' +
      'load rather than correctness',
  );
  warn(
    'COMMUNE_OUTSIDE_PROVINCE',
    m.communesOutsideProvince,
    'commune polygon is not contained by its province polygon. Routine where the two ' +
      'outlines were simplified independently, and worth looking at',
  );
  warn('AREA_OUTLIER', m.areaOutliers, 'area differs sharply from the value the source publishes');
  warn('DUPLICATE_GEOMETRY', m.duplicateGeometryHashes, 'two units share an identical shape');
  warn(
    'BBOX_OUTSIDE_VIETNAM',
    m.outsideVietnamBbox,
    'bounding box falls outside Vietnam. Expected for the offshore special zones, ' +
      'which is why this is a warning and not a rule',
  );

  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  return {
    boundaryVersion: m.boundaryVersion,
    ranAt: new Date().toISOString(),
    findings,
    errors,
    warnings: findings.length - errors,
    loadable: errors === 0,
    counts: { provinces: m.provinceCount, communes: m.communeCount },
  };
}

function finding(
  gate: BoundaryGateId,
  severity: BoundarySeverity,
  rows: Anomaly,
  message: string,
): BoundaryFinding {
  return {
    gate,
    severity,
    message,
    count: rows.count,
    samples: rows.samples.slice(0, BOUNDARY_SAMPLE_LIMIT),
  };
}

/**
 * A coverage failure is either "the archive is short" or "the archive is not
 * the one that was pinned". Both are fatal; only the first can name rows.
 */
function countMismatch(loaded: number, expected: number, missing: Anomaly): Anomaly {
  if (loaded === expected) return missing;
  return anomaly(missing.count + 1, [`loaded ${loaded}, pinned ${expected}`, ...missing.samples]);
}
