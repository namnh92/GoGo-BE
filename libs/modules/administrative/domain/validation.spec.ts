import { describe, expect, it } from 'vitest';
import {
  RECORD_COUNT_DELTA_THRESHOLD,
  validateDataset,
  type DatasetUnderValidation,
  type GateId,
  type ProvenancedUnit,
  type QuarantineSummary,
} from './validation';
import type { ChangeRow } from './snapshot';

/**
 * ADM-004 (#457) — every gate, tripped on purpose.
 *
 * Each test states an invariant and then builds the smallest dataset that
 * breaks it. Asserting only that a valid dataset passes would leave every gate
 * untested against the thing it exists to catch.
 */

const unit = (over: Partial<ProvenancedUnit> = {}): ProvenancedUnit => ({
  code: '00004',
  name: 'Ba Đình',
  fullName: 'Phường Ba Đình',
  nameEn: null,
  nameNormalized: 'ba dinh',
  fullNameNormalized: 'phuong ba dinh',
  codeName: null,
  unitType: 'WARD',
  level: 'COMMUNE',
  parentCode: '01',
  status: 'ACTIVE',
  effectiveFrom: '2025-07-01',
  effectiveTo: null,
  source: 'thanglequoc/vietnamese-provinces-database',
  sourceVersion: 'v5.0.0',
  ...over,
});

const province = (over: Partial<ProvenancedUnit> = {}): ProvenancedUnit =>
  unit({
    code: '01',
    name: 'Hà Nội',
    fullName: 'Thành phố Hà Nội',
    nameNormalized: 'ha noi',
    fullNameNormalized: 'thanh pho ha noi',
    unitType: 'MUNICIPALITY',
    level: 'PROVINCE',
    parentCode: null,
    ...over,
  });

/**
 * The real import holds each province twice — once closed on 2025-06-30 and
 * once open — so a historical commune has a historical province to hang off.
 * The fixtures mirror that, because a legacy unit with only a *current* parent
 * is a shape the dataset never actually has.
 */
const legacyProvince = (over: Partial<ProvenancedUnit> = {}): ProvenancedUnit =>
  province({
    status: 'INACTIVE',
    effectiveFrom: '1900-01-01',
    effectiveTo: '2025-06-30',
    sourceVersion: 'v2.4.1',
    ...over,
  });

const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  oldCode: '00001',
  newCode: '00004',
  changeType: 'RENAMED',
  effectiveDate: '2025-07-01',
  legalReference: 'Nghị quyết 202/2025/QH15',
  ...over,
});

const legacy = (over: Partial<ProvenancedUnit> = {}): ProvenancedUnit =>
  unit({
    code: '00001',
    fullName: 'Phường Phúc Xá',
    status: 'INACTIVE',
    effectiveFrom: '1900-01-01',
    effectiveTo: '2025-06-30',
    sourceVersion: 'v2.4.1',
    ...over,
  });

function run(over: Partial<DatasetUnderValidation> = {}) {
  const units = over.units ?? [province(), unit()];
  return validateDataset({
    datasetVersion: 'test+v1',
    units,
    changes: [],
    quarantine: [],
    expected: { combinedDatasetVersion: 'test+v1', combinedChecksum: 'sum' },
    stored: { combinedDatasetVersion: 'test+v1', combinedChecksum: 'sum' },
    snapshotChecksumsVerified: true,
    publishedVersionCount: 1,
    ...over,
  });
}

const gates = (report: ReturnType<typeof validateDataset>): GateId[] =>
  report.findings.map((f) => f.gate);

describe('a clean dataset is publishable', () => {
  it('fires no gate and says so', () => {
    const report = run();
    expect(report.findings).toEqual([]);
    expect(report.errors).toBe(0);
    expect(report.publishable).toBe(true);
  });

  it('counts units by level and currency', () => {
    const report = run({
      units: [
        province(),
        legacyProvince(),
        unit(),
        legacy(),
        unit({
          code: '001',
          level: 'LEGACY_DISTRICT',
          unitType: 'LEGACY_DISTRICT',
          status: 'INACTIVE',
          effectiveTo: '2025-06-30',
          effectiveFrom: '1900-01-01',
        }),
      ],
    });
    expect(report.counts).toMatchObject({
      currentProvinces: 1,
      currentCommunes: 1,
      historicalCommunes: 1,
      historicalDistricts: 1,
    });
  });
});

describe('ERROR gates block publication', () => {
  it('catches a snapshot that no longer matches its manifest', () => {
    const report = run({ snapshotChecksumsVerified: false });
    expect(gates(report)).toContain('SNAPSHOT_CHECKSUM');
    expect(report.publishable).toBe(false);
  });

  it('catches a missing required field', () => {
    const report = run({ units: [province(), unit({ name: '  ' })] });
    expect(gates(report)).toContain('REQUIRED_FIELDS');
    expect(report.publishable).toBe(false);
  });

  it('catches an empty current dataset', () => {
    const report = run({ units: [legacyProvince(), legacy()] });
    expect(gates(report)).toContain('EMPTY_DATASET');
    expect(report.publishable).toBe(false);
  });

  it('catches two current units claiming one code', () => {
    const report = run({
      units: [province(), unit(), unit({ fullName: 'Phường Khác', effectiveFrom: '2026-01-01' })],
    });
    expect(gates(report)).toContain('DUPLICATE_ACTIVE_IDENTITY');
  });

  it('catches two periods of one code covering the same day', () => {
    // Both periods are code 00004, and the earlier one runs to 2025-12-31 while
    // the later opens on 2025-07-01: for five months the code names two units.
    const report = run({
      units: [
        province(),
        legacyProvince(),
        unit(),
        legacy({ code: '00004', effectiveTo: '2025-12-31' }),
      ],
    });
    expect(gates(report)).toContain('EFFECTIVE_PERIOD_OVERLAP');
  });

  it('catches a current commune whose province is not in the dataset', () => {
    const report = run({ units: [province(), unit({ parentCode: '99' })] });
    expect(gates(report)).toContain('CURRENT_COMMUNE_PARENT');
  });

  it('catches a historical unit with no historical province', () => {
    const report = run({
      units: [province(), legacyProvince(), unit(), legacy({ parentCode: '99' })],
    });
    expect(gates(report)).toContain('HISTORICAL_HIERARCHY');
  });

  it('catches a parent cycle', () => {
    const report = run({
      units: [
        province({ parentCode: '00004', level: 'COMMUNE', unitType: 'WARD' }),
        unit({ parentCode: '01' }),
      ],
    });
    expect(gates(report)).toContain('PARENT_CYCLE');
  });

  it('catches a type that is not legal at its level', () => {
    // MUNICIPALITY is a province-level type; at commune level it is nonsense.
    const report = run({ units: [province(), unit({ unitType: 'MUNICIPALITY' })] });
    expect(gates(report)).toContain('UNSUPPORTED_TYPE');
  });

  it('catches a change whose predecessor the dataset does not hold', () => {
    const report = run({ changes: [change({ oldCode: '99999' })] });
    expect(gates(report)).toContain('CHANGE_SOURCE_RESOLVES');
  });

  it('catches a change whose successor the dataset does not hold', () => {
    const report = run({
      units: [province(), legacyProvince(), unit(), legacy()],
      changes: [change({ newCode: '99999' })],
    });
    expect(gates(report)).toContain('CHANGE_TARGET_RESOLVES');
  });

  it('catches a change pointing at a unit that is not current', () => {
    const report = run({
      units: [province(), legacyProvince(), unit(), legacy()],
      changes: [change({ oldCode: '00004', newCode: '00001' })],
    });
    expect(gates(report)).toContain('CHANGE_HIERARCHY');
  });

  it('catches MERGED asserted with a single predecessor', () => {
    const report = run({
      units: [province(), legacyProvince(), unit(), legacy()],
      changes: [change({ changeType: 'MERGED' })],
    });
    expect(gates(report)).toContain('MERGE_SPLIT_STRUCTURE');
  });

  it('catches RENAMED asserted where several predecessors exist', () => {
    const report = run({
      units: [province(), legacyProvince(), unit(), legacy(), legacy({ code: '00002' })],
      changes: [change(), change({ oldCode: '00002' })],
    });
    expect(gates(report)).toContain('MERGE_SPLIT_STRUCTURE');
  });

  it('catches a SPLIT recorded as canonical at all', () => {
    // The advisory source names a default successor for a divided commune.
    // ADR-0019 forbids trusting it, so a SPLIT must never reach this table.
    const report = run({
      units: [province(), legacyProvince(), unit(), legacy()],
      changes: [change({ changeType: 'SPLIT' })],
    });
    expect(gates(report)).toContain('MERGE_SPLIT_STRUCTURE');
    expect(report.findings.find((f) => f.gate === 'MERGE_SPLIT_STRUCTURE')!.samples[0]).toContain(
      'SPLIT is never canonical',
    );
  });

  it('catches a quarantined row that also appears as canonical', () => {
    const quarantine: QuarantineSummary[] = [
      { classification: 'DIVIDED_REQUIRES_REVIEW', oldCode: '00001', newCode: '00004' },
    ];
    const report = run({
      units: [province(), legacyProvince(), unit(), legacy()],
      changes: [change()],
      quarantine,
    });
    expect(gates(report)).toContain('QUARANTINE_EXCLUDED');
  });

  it('catches a stored version that its own components do not produce', () => {
    const report = run({
      expected: { combinedDatasetVersion: 'test+v2', combinedChecksum: 'other' },
    });
    expect(gates(report)).toContain('COMBINED_VERSION_CONSISTENT');
  });

  it('catches two datasets published at once', () => {
    const report = run({ publishedVersionCount: 2 });
    expect(gates(report)).toContain('SINGLE_PUBLISHED_VERSION');
  });
});

describe('WARNING gates are visible but never block', () => {
  it('surfaces a record-count swing without refusing the dataset', () => {
    const baselineUnits = [
      province(),
      ...Array.from({ length: 20 }, (_, i) => unit({ code: String(i).padStart(5, '0') })),
    ];
    const report = run({
      units: [province(), unit()],
      baseline: { datasetVersion: 'test+v0', units: baselineUnits },
      changes: [],
    });
    expect(gates(report)).toContain('RECORD_COUNT_DELTA');
    expect(report.errors).toBe(0);
    expect(report.publishable).toBe(true);
  });

  it('does not fire the delta gate inside the threshold', () => {
    const baselineUnits = [province(), unit(), unit({ code: '00008' })];
    const report = run({
      units: [province(), unit(), unit({ code: '00008' })],
      baseline: { datasetVersion: 'test+v0', units: baselineUnits },
    });
    expect(gates(report)).not.toContain('RECORD_COUNT_DELTA');
    expect(RECORD_COUNT_DELTA_THRESHOLD).toBeGreaterThan(0);
  });

  it('surfaces a unit that vanished with no change row explaining it', () => {
    const report = run({
      units: [province(), unit()],
      baseline: { datasetVersion: 'test+v0', units: [province(), unit(), unit({ code: '00008' })] },
    });
    expect(gates(report)).toContain('REMOVED_UNIT_UNEXPLAINED');
    expect(report.publishable).toBe(true);
  });

  it('does not surface a vanished unit that a change row explains', () => {
    const report = run({
      units: [province(), unit()],
      baseline: { datasetVersion: 'test+v0', units: [province(), unit(), unit({ code: '00008' })] },
      changes: [change({ oldCode: '00008', newCode: '00004' })],
    });
    expect(gates(report)).not.toContain('REMOVED_UNIT_UNEXPLAINED');
  });

  it('surfaces the lowercase type prefix without correcting it', () => {
    // Ward 06325 is "xã Bắc Sơn" in v5.0.0 where every other row capitalises.
    const report = run({ units: [province(), unit({ code: '06325', fullName: 'xã Bắc Sơn' })] });
    expect(gates(report)).toContain('SOURCE_FORMATTING');
    expect(report.publishable).toBe(true);
  });

  it('surfaces quarantined rows and names how many came from divided communes', () => {
    const quarantine: QuarantineSummary[] = [
      { classification: 'DIVIDED_REQUIRES_REVIEW', oldCode: '00007', newCode: '00008' },
      { classification: 'DIVIDED_REQUIRES_REVIEW', oldCode: '00007', newCode: '00025' },
      { classification: 'TARGET_NOT_FOUND', oldCode: '00009', newCode: '99999' },
    ];
    const report = run({ quarantine });
    const found = report.findings.find((f) => f.gate === 'UNRESOLVED_CHANGES')!;
    expect(found.severity).toBe('WARNING');
    expect(found.count).toBe(3);
    expect(found.message).toContain('2 from divided communes');
    expect(report.publishable).toBe(true);
  });
});

describe('the district-to-special-zone transition is valid, not malformed', () => {
  it('accepts a legacy district predecessor whose province differs from the target’s', () => {
    // Côn Đảo: district 755 in province 77 became đặc khu 26732 in province 79.
    // Provinces differing is the *point* of that change, not a defect.
    const report = run({
      units: [
        province({ code: '79', fullName: 'Thành phố Hồ Chí Minh' }),
        province({
          code: '77',
          fullName: 'Tỉnh Bà Rịa - Vũng Tàu',
          status: 'INACTIVE',
          effectiveFrom: '1900-01-01',
          effectiveTo: '2025-06-30',
        }),
        unit({
          code: '26732',
          fullName: 'Đặc khu Côn Đảo',
          unitType: 'SPECIAL_ZONE',
          parentCode: '79',
        }),
        unit({
          code: '755',
          fullName: 'Huyện Côn Đảo',
          unitType: 'LEGACY_DISTRICT',
          level: 'LEGACY_DISTRICT',
          parentCode: '77',
          status: 'INACTIVE',
          effectiveFrom: '1900-01-01',
          effectiveTo: '2025-06-30',
        }),
      ],
      changes: [change({ oldCode: '755', newCode: '26732', changeType: 'REASSIGNED' })],
    });
    expect(report.errors).toBe(0);
    expect(report.publishable).toBe(true);
  });
});

describe('the report is deterministic', () => {
  it('orders errors before warnings and gates alphabetically within each', () => {
    const report = run({
      units: [province(), unit({ name: '' }), unit({ code: '06325', fullName: 'xã Bắc Sơn' })],
      publishedVersionCount: 2,
    });
    const severities = report.findings.map((f) => f.severity);
    expect(severities.indexOf('WARNING')).toBeGreaterThan(severities.lastIndexOf('ERROR'));
    const errorGates = report.findings.filter((f) => f.severity === 'ERROR').map((f) => f.gate);
    expect(errorGates).toEqual([...errorGates].sort());
  });

  it('caps and sorts samples so two runs report the same window', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      unit({ code: String(i).padStart(5, '0'), parentCode: '99' }),
    );
    const a = run({ units: [province(), ...many] });
    const b = run({ units: [province(), ...many] });
    const found = a.findings.find((f) => f.gate === 'CURRENT_COMMUNE_PARENT')!;
    expect(found.count).toBe(40);
    expect(found.samples).toHaveLength(10);
    expect(found.samples).toEqual(
      b.findings.find((f) => f.gate === 'CURRENT_COMMUNE_PARENT')!.samples,
    );
  });
});
