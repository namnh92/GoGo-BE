import { Injectable } from '@nestjs/common';
import { AdministrativeQueryService } from '../../administrative/application/administrative-query.service';
import { normalizeVietnamese } from '../../search/domain/normalize';

export type ResolvedArea = {
  area: { datasetVersion: string; provinceCode: string; communeCode: string | null };
  /** Names from the published dataset — never the user's spelling, never a model's. */
  label: string;
};

export type AreaResolution =
  { kind: 'resolved'; value: ResolvedArea } | { kind: 'ambiguous' } | { kind: 'none' };

/** Spoken names for the provinces people abbreviate, folded. */
const PROVINCE_ALIASES: [RegExp, string][] = [
  [/(?:^| )(?:sai gon|sg|hcm|tphcm|tp hcm|ho chi minh)(?: |$)/, 'ho chi minh'],
  [/(?:^| )(?:ha noi|hn)(?: |$)/, 'ha noi'],
  [/(?:^| )(?:da nang|dn)(?: |$)/, 'da nang'],
];

const strip = (name: string) =>
  normalizeVietnamese(name)
    .replace(/^(thanh pho|tinh|tp\.?|phuong|xa|dac khu|quan|huyen|thi xa)\s+/, '')
    .trim();

/**
 * ADR-0036 §3B — the area phrase (`parseIntentFacts.areaText`, as typed) to a
 * canonical administrative area through the published dataset, the same
 * source room constraints use. Deterministic; a model never resolves a place
 * name. A name that fits communes in more than one province with no province
 * named is ambiguous and the assistant asks instead of guessing.
 */
@Injectable()
export class AssistantAreaResolver {
  constructor(private readonly query: AdministrativeQueryService) {}

  async resolve(fullText: string, areaText: string | null): Promise<AreaResolution> {
    let snapshot: Awaited<ReturnType<AdministrativeQueryService['snapshot']>>;
    try {
      snapshot = await this.query.snapshot();
    } catch {
      return { kind: 'none' };
    }
    const folded = ` ${normalizeVietnamese(fullText).replace(/[^\p{L}\p{N} ]/gu, ' ')} `;
    const aliasTarget = PROVINCE_ALIASES.find(([re]) => re.test(folded))?.[1];
    const province =
      snapshot.currentProvinces.find(
        (p) => aliasTarget !== undefined && strip(p.name).includes(aliasTarget),
      ) ??
      snapshot.currentProvinces.find((p) => {
        const n = strip(p.name);
        return n.length >= 4 && folded.includes(` ${n} `);
      }) ??
      null;

    const provinceArea = (p: { code: string; name: string }): AreaResolution => ({
      kind: 'resolved',
      value: {
        area: { datasetVersion: snapshot.datasetVersion, provinceCode: p.code, communeCode: null },
        label: p.name,
      },
    });

    if (!areaText) return province ? provinceArea(province) : { kind: 'none' };
    const needle = strip(areaText);
    // "Quận 1" strips to "1": an explicit phrase too short to name a current
    // unit is not recognised either (Sol N-02).
    if (needle.length < 2) return { kind: 'none' };

    // The phrase itself names a province ("ở Hà Nội").
    const named = snapshot.currentProvinces.find((p) => strip(p.name) === needle);
    if (named) return provinceArea(named);

    let hits;
    try {
      hits = this.query.search(snapshot, {
        query: areaText,
        provinceCode: province?.code,
        includeLegacy: false,
        limit: 20,
      }).items;
    } catch {
      return province ? provinceArea(province) : { kind: 'none' };
    }
    const communes = hits.filter((h) => h.level !== 'PROVINCE' && strip(h.name) === needle);
    const provinces = new Set(communes.map((c) => c.parentCode));
    if (communes.length > 0 && provinces.size === 1) {
      const commune = communes[0]!;
      const parent = snapshot.currentProvinces.find((p) => p.code === commune.parentCode);
      return {
        kind: 'resolved',
        value: {
          area: {
            datasetVersion: snapshot.datasetVersion,
            provinceCode: commune.parentCode!,
            communeCode: commune.code,
          },
          label: parent ? `${commune.fullName}, ${parent.name}` : commune.fullName,
        },
      };
    }
    if (provinces.size > 1) return { kind: 'ambiguous' };

    // Owner 2026-10-28 (Sol N-02): the new administrative address only. A
    // pre-2025 district ("Quận 10") or any phrase that names no current unit
    // is not recognised — not widened to a province, even one also named —
    // so the person is asked for a new address.
    return { kind: 'none' };
  }
}
