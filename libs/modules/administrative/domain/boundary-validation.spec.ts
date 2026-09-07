import { describe, expect, it } from 'vitest';
import { anomaly, validateBoundaries, type BoundaryMeasurements } from './boundary-validation';

/**
 * ADM-007 (#460) — which findings stop a boundary release and which do not.
 *
 * The split is the design. Vietnam's real geography trips a naive checker
 * constantly: 1,370 of the pinned release's 3,321 communes are not fully
 * covered by their own province polygon, because the two outlines were
 * simplified independently. A gate that blocked on that would block the only
 * boundary release there is, and the gates that matter would be turned off
 * alongside it.
 */

const clean: BoundaryMeasurements = {
  boundaryVersion: 'v5.0.0',
  provinceCount: 34,
  communeCount: 3321,
  expected: { provinces: 34, communes: 3321 },
  invalidGeometries: anomaly(0, []),
  emptyGeometries: anomaly(0, []),
  wrongSrid: anomaly(0, []),
  wrongType: anomaly(0, []),
  unsupportedLevels: anomaly(0, []),
  unresolvedCodes: anomaly(0, []),
  parentMismatches: anomaly(0, []),
  duplicateIdentities: anomaly(0, []),
  legacyDistrictRows: anomaly(0, []),
  missingProvinceCodes: anomaly(0, []),
  missingCommuneCodes: anomaly(0, []),
  spatialIndexPresent: true,
  sameLevelOverlaps: anomaly(0, []),
  communesOutsideProvince: anomaly(0, []),
  areaOutliers: anomaly(0, []),
  duplicateGeometryHashes: anomaly(0, []),
  outsideVietnamBbox: anomaly(0, []),
};

const run = (over: Partial<BoundaryMeasurements> = {}) => validateBoundaries({ ...clean, ...over });

describe('a clean release loads', () => {
  it('has no findings at all', () => {
    const report = run();
    expect(report).toMatchObject({ errors: 0, warnings: 0, loadable: true });
    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ provinces: 34, communes: 3321 });
  });
});

describe('structural impossibilities block the load', () => {
  it.each([
    ['invalidGeometries', 'GEOMETRY_VALID'],
    ['emptyGeometries', 'GEOMETRY_NOT_EMPTY'],
    ['wrongSrid', 'GEOMETRY_SRID'],
    ['wrongType', 'GEOMETRY_TYPE'],
    ['unsupportedLevels', 'SUPPORTED_LEVEL'],
    ['unresolvedCodes', 'CODE_RESOLVES'],
    ['parentMismatches', 'PARENT_MATCHES_UNITS'],
    ['duplicateIdentities', 'DUPLICATE_IDENTITY'],
    ['legacyDistrictRows', 'NO_LEGACY_DISTRICT'],
  ] as const)('%s is an ERROR (%s)', (field, gate) => {
    const report = run({ [field]: anomaly(3, ['a', 'b', 'c']) });
    expect(report.loadable).toBe(false);
    expect(report.findings.find((f) => f.gate === gate)).toMatchObject({
      severity: 'ERROR',
      count: 3,
    });
  });

  it('refuses a release whose counts are not the counts that were pinned', () => {
    // The archive may be internally consistent and still be the wrong archive.
    const report = run({ communeCount: 3320 });
    expect(report.loadable).toBe(false);
    const finding = report.findings.find((f) => f.gate === 'COMMUNE_COVERAGE')!;
    expect(finding.samples[0]).toBe('loaded 3320, pinned 3321');
  });

  it('refuses to load without the spatial index', () => {
    // Without it every resolution scans 3,355 multipolygons.
    expect(run({ spatialIndexPresent: false }).loadable).toBe(false);
  });

  it('reports the real count, not the length of a truncated sample', () => {
    const report = run({ unresolvedCodes: anomaly(1370, ['00004', '00008']) });
    const finding = report.findings.find((f) => f.gate === 'CODE_RESOLVES')!;
    expect(finding.count).toBe(1370);
    expect(finding.samples).toHaveLength(2);
  });
});

describe('coherent geography is reported, never blocked', () => {
  it.each([
    ['sameLevelOverlaps', 'SAME_LEVEL_OVERLAP'],
    ['communesOutsideProvince', 'COMMUNE_OUTSIDE_PROVINCE'],
    ['areaOutliers', 'AREA_OUTLIER'],
    ['duplicateGeometryHashes', 'DUPLICATE_GEOMETRY'],
    ['outsideVietnamBbox', 'BBOX_OUTSIDE_VIETNAM'],
  ] as const)('%s is a WARNING (%s)', (field, gate) => {
    const report = run({ [field]: anomaly(200, ['x']) });
    expect(report.loadable).toBe(true);
    expect(report.findings.find((f) => f.gate === gate)?.severity).toBe('WARNING');
  });

  it('loads the pinned release exactly as measured: three warnings, no errors', () => {
    const report = run({
      sameLevelOverlaps: anomaly(233, ['COMMUNE 00004/00008']),
      communesOutsideProvince: anomaly(1370, ['00004']),
      areaOutliers: anomaly(56, ['00004: measured 3.1 vs published 2.97']),
    });
    expect(report).toMatchObject({ errors: 0, warnings: 3, loadable: true });
  });

  it('does not treat an offshore bounding box as a defect', () => {
    // Trường Sa is 400 km offshore. It is in the release because it is part of
    // the country, and a bbox rule that refused it would be asserting geography.
    expect(run({ outsideVietnamBbox: anomaly(2, ['22736', '20333']) }).loadable).toBe(true);
  });
});
