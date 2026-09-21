import { describe, expect, it } from 'vitest';
import { diffDatasets, impactedCodes, type DiffInput } from './dataset-diff';
import type { ProvenancedUnit, QuarantineSummary } from './validation';
import type { ChangeRow } from './snapshot';

/**
 * ADM-004 (#457) — the diff, one category at a time.
 *
 * The property worth guarding hardest is that a **code is not an identity**.
 * Diffing on code alone would report a rename for every one of the 2,212
 * commune codes that changed meaning on 2025-07-01, which is both wrong and the
 * single most plausible way to get this wrong.
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

const noPlaces = { total: 0, samples: [], truncated: false, sampleLimit: 20 };

function run(over: Partial<DiffInput> = {}) {
  return diffDatasets({
    fromVersion: 'v1',
    toVersion: 'v2',
    fromUnits: [],
    toUnits: [],
    toChanges: [],
    toQuarantine: [],
    fromSources: null,
    toSources: {},
    affectedPlaces: noPlaces,
    ...over,
  });
}

describe('unit-shape categories', () => {
  it('CREATED for an identity only the new dataset has', () => {
    const diff = run({ toUnits: [unit()] });
    expect(diff.countsByCategory.CREATED).toBe(1);
    expect(diff.entries[0]).toMatchObject({
      category: 'CREATED',
      from: null,
      to: { code: '00004', effectiveFrom: '2025-07-01' },
      provenance: 'thanglequoc/vietnamese-provinces-database@v5.0.0',
    });
  });

  it('DISSOLVED for an identity only the old dataset has', () => {
    const diff = run({ fromUnits: [unit()] });
    expect(diff.countsByCategory.DISSOLVED).toBe(1);
    expect(diff.entries[0]).toMatchObject({ category: 'DISSOLVED', to: null });
  });

  it('RENAMED when the same identity carries a different name', () => {
    const diff = run({
      fromUnits: [unit({ fullName: 'Phường Cũ' })],
      toUnits: [unit()],
    });
    expect(diff.countsByCategory.RENAMED).toBe(1);
    expect(diff.entries[0]!.detail).toBe('Phường Cũ → Phường Ba Đình');
  });

  it('PARENT_CHANGED, STATUS_CHANGED and EFFECTIVE_PERIOD_CHANGED are separate entries', () => {
    // One identity can move in several ways at once, and a reviewer reading
    // "renamed" should not have to notice that the parent moved too.
    const diff = run({
      fromUnits: [unit()],
      toUnits: [unit({ parentCode: '79', status: 'INACTIVE', effectiveTo: '2026-01-01' })],
    });
    expect(diff.countsByCategory).toMatchObject({
      PARENT_CHANGED: 1,
      STATUS_CHANGED: 1,
      EFFECTIVE_PERIOD_CHANGED: 1,
      RENAMED: 0,
    });
  });
});

describe('a code is not an identity', () => {
  it('reports reuse as one dissolved unit and one created unit, never a rename', () => {
    // 00004 was Phường Trúc Bạch until 2025-06-30 and is Phường Ba Đình after.
    // Two units, not one renamed unit.
    const before = unit({
      fullName: 'Phường Trúc Bạch',
      effectiveFrom: '1900-01-01',
      effectiveTo: '2025-06-30',
      status: 'INACTIVE',
    });
    const diff = run({ fromUnits: [before], toUnits: [unit()] });
    expect(diff.countsByCategory).toMatchObject({ CREATED: 1, DISSOLVED: 1, RENAMED: 0 });
  });

  it('leaves an unchanged identity out of the diff entirely', () => {
    const diff = run({ fromUnits: [unit()], toUnits: [unit()] });
    expect(diff.entries).toEqual([]);
  });
});

describe('migration categories come from canonical changes, not from shape', () => {
  const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
    oldCode: '00001',
    newCode: '00004',
    changeType: 'MERGED',
    effectiveDate: '2025-07-01',
    legalReference: 'Nghị quyết 202/2025/QH15',
    ...over,
  });

  it('MERGED, SPLIT and REASSIGNED each get their own category', () => {
    const diff = run({
      toUnits: [unit()],
      toChanges: [
        change(),
        change({ oldCode: '00007', changeType: 'SPLIT' }),
        change({ oldCode: '755', newCode: '26732', changeType: 'REASSIGNED' }),
      ],
    });
    expect(diff.countsByCategory).toMatchObject({ MERGED: 1, SPLIT: 1, REASSIGNED: 1 });
  });

  it('carries the legal reference as provenance', () => {
    const diff = run({ toUnits: [unit()], toChanges: [change()] });
    const merged = diff.entries.find((e) => e.category === 'MERGED')!;
    expect(merged.provenance).toBe('Nghị quyết 202/2025/QH15');
    expect(merged.detail).toBe('00001 → 00004 on 2025-07-01');
  });

  it('separates a record renaming itself from one code becoming another', () => {
    // Two different facts that happen to share a category name. The shape entry
    // says unit 00004 is now called something else; the migration entry says
    // code 00001 became code 00004. Collapsing them would lose one of the two,
    // so they are distinct entries with non-colliding keys.
    const diff = run({
      fromUnits: [unit({ fullName: 'Phường Cũ' })],
      toUnits: [unit()],
      toChanges: [change({ changeType: 'RENAMED' })],
    });
    expect(diff.countsByCategory.RENAMED).toBe(2);
    expect(diff.entries.filter((e) => e.category === 'RENAMED').map((e) => e.key)).toEqual([
      'RENAMED:00001>00004',
      'RENAMED:00004@2025-07-01',
    ]);
  });

  it('leaves out a migration the published dataset already asserted', () => {
    // A reviewer bumping an override revision must not be shown all 9,569
    // migrations again; only what this dataset adds is news.
    const diff = run({
      toUnits: [unit()],
      toChanges: [change()],
      fromChanges: [change()],
    });
    expect(diff.countsByCategory.MERGED).toBe(0);
  });

  it('leaves out a quarantined row the published dataset already held', () => {
    const row: QuarantineSummary = {
      classification: 'DIVIDED_REQUIRES_REVIEW',
      oldCode: '00007',
      newCode: '00008',
    };
    const diff = run({ toUnits: [unit()], toQuarantine: [row], fromQuarantine: [row] });
    expect(diff.countsByCategory.UNRESOLVED).toBe(0);
  });
});

describe('OVERRIDE_RETRACTED (GoGo-BE#623)', () => {
  const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
    oldCode: '00007',
    newCode: '00025',
    changeType: 'SPLIT',
    effectiveDate: '2025-07-01',
    legalReference: 'GoGo override set',
    overrideDecisionId: 'dec-1',
    ...over,
  });

  it('reports a baseline override this version no longer carries', () => {
    // The to-side has nothing to iterate for a dropped edge; the entry is
    // derived from what the baseline had and this version does not.
    const diff = run({
      fromUnits: [unit({ code: '00007', fullName: 'Phường Cống Vị' }), unit({ code: '00025' })],
      toUnits: [unit({ code: '00007', fullName: 'Phường Cống Vị' }), unit({ code: '00025' })],
      fromChanges: [change()],
      toChanges: [],
    });
    expect(diff.countsByCategory.OVERRIDE_RETRACTED).toBe(1);
    const entry = diff.entries.find((e) => e.category === 'OVERRIDE_RETRACTED')!;
    expect(entry.key).toBe('OVERRIDE_RETRACTED:00007>00025');
    expect(entry.from?.code).toBe('00007');
    expect(entry.to?.code).toBe('00025');
    expect(entry.detail).toContain('retracted');
    expect(entry.provenance).toContain('dec-1');
  });

  it('does not report an override that was re-pointed, which is a target change', () => {
    const diff = run({
      toUnits: [unit({ code: '00007' }), unit({ code: '00008' })],
      fromChanges: [change()],
      toChanges: [change({ newCode: '00008', overrideDecisionId: 'dec-2' })],
    });
    expect(diff.countsByCategory.OVERRIDE_RETRACTED).toBe(0);
    expect(diff.countsByCategory.OVERRIDE_TARGET_CHANGED).toBe(1);
  });

  it('does not report an override the version still carries', () => {
    const diff = run({ fromChanges: [change()], toChanges: [change()] });
    expect(diff.countsByCategory.OVERRIDE_RETRACTED).toBe(0);
  });
});

describe('UNRESOLVED and SOURCE_DRIFT', () => {
  it('surfaces a quarantined row as UNRESOLVED, never as a resolved migration', () => {
    const quarantine: QuarantineSummary[] = [
      { classification: 'DIVIDED_REQUIRES_REVIEW', oldCode: '00007', newCode: '00008' },
    ];
    const diff = run({ toUnits: [unit()], toQuarantine: quarantine });
    expect(diff.countsByCategory).toMatchObject({ UNRESOLVED: 1, SPLIT: 0, MERGED: 0 });
    expect(diff.entries.find((e) => e.category === 'UNRESOLVED')!.provenance).toContain(
      'quarantined',
    );
  });

  it('reports each pinned component that moved', () => {
    const diff = run({
      fromSources: { currentSourceVersion: 'v5.0.0', mappingSourceCommit: 'aaa' },
      toSources: { currentSourceVersion: 'v5.1.0', mappingSourceCommit: 'aaa' },
    });
    expect(diff.countsByCategory.SOURCE_DRIFT).toBe(1);
    expect(diff.entries[0]!.detail).toBe('currentSourceVersion: v5.0.0 → v5.1.0');
  });

  it('reports no drift for a first publication, which has nothing to drift from', () => {
    const diff = run({ fromSources: null, toSources: { currentSourceVersion: 'v5.0.0' } });
    expect(diff.countsByCategory.SOURCE_DRIFT).toBe(0);
  });
});

describe('ordering, bounding and linkage', () => {
  it('orders by category then key, identically on every run', () => {
    const units = Array.from({ length: 30 }, (_, i) => unit({ code: String(i).padStart(5, '0') }));
    const a = run({
      toUnits: units,
      toQuarantine: [{ classification: 'DUPLICATE', oldCode: 'x', newCode: 'y' }],
    });
    const b = run({
      toUnits: [...units].reverse(),
      toQuarantine: [{ classification: 'DUPLICATE', oldCode: 'x', newCode: 'y' }],
    });
    expect(a.entries.map((e) => e.key)).toEqual(b.entries.map((e) => e.key));
    // CREATED sorts before UNRESOLVED because the category order is fixed.
    expect(a.entries[0]!.category).toBe('CREATED');
    expect(a.entries.at(-1)!.category).toBe('UNRESOLVED');
  });

  it('caps the entry list while leaving the counts complete', () => {
    const units = Array.from({ length: 50 }, (_, i) => unit({ code: String(i).padStart(5, '0') }));
    const diff = run({ toUnits: units, entryLimit: 10 });
    expect(diff.entries).toHaveLength(10);
    expect(diff.entriesTruncated).toBe(true);
    expect(diff.countsByCategory.CREATED).toBe(50);
    expect(diff.entryLimit).toBe(10);
  });

  it('links an entry to the gates that actually fired', () => {
    const withGate = run({ toUnits: [unit()], firedGates: ['CURRENT_COMMUNE_PARENT'] });
    expect(withGate.entries[0]!.validation).toEqual(['CURRENT_COMMUNE_PARENT']);
    // A gate that did not fire is not cited, so the linkage means something.
    const withoutGate = run({ toUnits: [unit()], firedGates: [] });
    expect(withoutGate.entries[0]!.validation).toEqual([]);
  });

  it('reports every category key even when nothing fell into it', () => {
    // A category that vanishes when empty cannot be told apart from one nobody
    // computed. #484 added two, so this is 13.
    const diff = run();
    expect(Object.values(diff.countsByCategory).every((n) => n === 0)).toBe(true);
    expect(Object.keys(diff.countsByCategory)).toHaveLength(14);
    expect(diff.countsByCategory.OVERRIDE_ACCEPTED).toBe(0);
    expect(diff.countsByCategory.OVERRIDE_TARGET_CHANGED).toBe(0);
  });
});

describe('impactedCodes', () => {
  it('collects both sides of every entry, sorted and deduplicated', () => {
    const diff = run({
      fromUnits: [unit({ code: '00001' })],
      toUnits: [unit(), unit({ code: '00008' })],
    });
    expect(impactedCodes(diff.entries)).toEqual(['00001', '00004', '00008']);
  });

  it('is empty for an empty diff, so no place query runs at all', () => {
    expect(impactedCodes(run().entries)).toEqual([]);
  });
});
