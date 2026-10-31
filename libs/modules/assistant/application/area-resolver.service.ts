import { Injectable } from '@nestjs/common';
import { AdministrativeQueryService } from '../../administrative/application/administrative-query.service';
import { normalizeVietnamese } from '../../search/domain/normalize';

export type ResolvedArea = {
  area: { datasetVersion: string; provinceCode: string; communeCode: string | null };
  /** Names from the published dataset — never the user's spelling, never a model's. */
  label: string;
};

/** A unit as the scope question shows it: dataset names only (#733 D-6). */
export type ScopeUnit = { code: string; name: string; fullName: string };

export type AreaResolution =
  | { kind: 'resolved'; value: ResolvedArea }
  | { kind: 'ambiguous' }
  /**
   * #733 D-6 — the phrase names a province (by alias or name) and, inside it,
   * a commune of the same name ("Sài Gòn"): the person chooses the scope.
   */
  | { kind: 'scope_choice'; province: ScopeUnit; communes: ScopeUnit[] }
  | { kind: 'none' };

/** The newest message of an episode (#733 D-5): its own words decide first. */
export type LatestMessage = { text: string; areaText: string | null };

/** Spoken names for the provinces people abbreviate, folded. */
const PROVINCE_ALIASES: [RegExp, string][] = [
  [/(?:^| )(sai gon|sg|hcm|tphcm|tp hcm|ho chi minh)(?= |$)/, 'ho chi minh'],
  [/(?:^| )(ha noi|hn)(?= |$)/, 'ha noi'],
  [/(?:^| )(da nang|dn)(?= |$)/, 'da nang'],
];

/** The word right before a phrase that says which level it means (D-6). */
const PROVINCE_QUALIFIER = /(?:^| )(?:thanh pho|tp|tinh|ca) $/;
const COMMUNE_QUALIFIER = /(?:^| )(?:phuong|xa|dac khu) $/;
/** An area phrase that is only a level word ("Ở TP.HCM" parses to "TP"). */
const QUALIFIER_ONLY = new Set(['tp', 'thanh pho', 'tinh', 'phuong', 'xa']);

const strip = (name: string) =>
  normalizeVietnamese(name)
    .replace(/^(thanh pho|tinh|tp\.?|phuong|xa|dac khu|quan|huyen|thi xa)\s+/, '')
    .trim();

/** Folded, letters/digits/space only, padded for whole-word tests. */
const fold = (text: string) =>
  ` ${normalizeVietnamese(text)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

type Snapshot = Awaited<ReturnType<AdministrativeQueryService['snapshot']>>;
type Unit = Snapshot['currentProvinces'][number];

/**
 * ADR-0036 §3B — the area phrase (`parseIntentFacts.areaText`, as typed) to a
 * canonical administrative area through the published dataset, the same
 * source room constraints use. Deterministic; a model never resolves a place
 * name. A name that fits communes in more than one province with no province
 * named is ambiguous and the assistant asks instead of guessing; a name that
 * is both a province and a commune inside it is a scope choice (#733 D-6).
 */
@Injectable()
export class AssistantAreaResolver {
  constructor(private readonly query: AdministrativeQueryService) {}

  /**
   * #733 D-5 — whether the text names a current unit by its full dataset name
   * ("Phường Sài Gòn", "Thành phố Hồ Chí Minh"). Read before the decision
   * call, to tell an answer from a fresh request; a snapshot failure is
   * "no", never an error.
   */
  async hasExactUnitName(text: string): Promise<boolean> {
    try {
      return exactHits(await this.query.snapshot(), fold(text)).length > 0;
    } catch {
      return false;
    }
  }

  async resolve(
    fullText: string,
    areaText: string | null,
    latest: LatestMessage = { text: fullText, areaText },
  ): Promise<AreaResolution> {
    let snapshot: Snapshot;
    try {
      snapshot = await this.query.snapshot();
    } catch {
      return { kind: 'none' };
    }
    const folded = fold(fullText);
    const foldedLatest = fold(latest.text);

    const provinceArea = (p: { code: string; name: string }): AreaResolution => ({
      kind: 'resolved',
      value: {
        area: { datasetVersion: snapshot.datasetVersion, provinceCode: p.code, communeCode: null },
        label: p.name,
      },
    });
    const communeArea = (commune: {
      code: string;
      fullName: string;
      parentCode: string | null;
    }): AreaResolution => {
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
    };

    // 0. An exact level-qualified name wins — the newest message first, so a
    //    chip answer settles what the request before it left open.
    for (const text of foldedLatest === folded ? [folded] : [foldedLatest, folded]) {
      const hit = exactResolution(snapshot, text);
      if (hit === 'ambiguous') return { kind: 'ambiguous' };
      if (hit?.level === 'PROVINCE') return provinceArea(hit);
      if (hit) return communeArea(hit);
    }

    // The phrase under test: the newest message's area, else an alias in it,
    // else the episode's area, else an alias anywhere.
    const meaningful = (t: string | null) =>
      t !== null && !QUALIFIER_ONLY.has(normalizeVietnamese(t).replace(/\./g, '').trim())
        ? t
        : null;
    const aliasIn = (text: string) => {
      for (const [re, target] of PROVINCE_ALIASES) {
        const m = re.exec(text);
        if (m) return { phrase: m[1]!, target };
      }
      return null;
    };
    const phrase =
      meaningful(latest.areaText) ??
      aliasIn(foldedLatest)?.phrase ??
      meaningful(areaText) ??
      aliasIn(folded)?.phrase ??
      null;

    // A province named anywhere else in the text scopes the commune search.
    const contextAlias = aliasIn(foldedLatest) ?? aliasIn(folded);
    const byAlias = (target: string) =>
      snapshot.currentProvinces.find((p) => strip(p.name).includes(target));
    const contextProvince =
      (contextAlias ? byAlias(contextAlias.target) : undefined) ??
      snapshot.currentProvinces.find((p) => {
        const n = strip(p.name);
        return n.length >= 4 && folded.includes(` ${n} `);
      }) ??
      null;

    if (!phrase) return contextProvince ? provinceArea(contextProvince) : { kind: 'none' };
    const needle = strip(phrase);
    // "Quận 1" strips to "1": an explicit phrase too short to name a current
    // unit is not recognised either (Sol N-02).
    if (needle.length < 2) return { kind: 'none' };

    // The phrase itself names a province ("ở Hà Nội", "Sài Gòn").
    const aliasOfPhrase = aliasIn(` ${needle} `);
    const named =
      snapshot.currentProvinces.find((p) => strip(p.name) === needle) ??
      (aliasOfPhrase && aliasOfPhrase.phrase === needle
        ? byAlias(aliasOfPhrase.target)
        : undefined) ??
      null;

    // The level word right before the phrase, read before `strip` drops it.
    const at = folded.indexOf(` ${normalizeVietnamese(phrase).replace(/[^\p{L}\p{N} ]/gu, ' ')} `);
    const before = at >= 0 ? folded.slice(0, at + 1) : '';
    const qualifier = PROVINCE_QUALIFIER.test(before)
      ? 'province'
      : COMMUNE_QUALIFIER.test(before)
        ? 'commune'
        : null;
    if (named && qualifier === 'province') return provinceArea(named);

    let hits;
    try {
      hits = this.query.search(snapshot, {
        query: needle,
        provinceCode: qualifier === 'commune' ? undefined : (named ?? contextProvince)?.code,
        includeLegacy: false,
        limit: 20,
      }).items;
    } catch {
      return named || contextProvince
        ? provinceArea((named ?? contextProvince)!)
        : { kind: 'none' };
    }
    const communes = hits.filter((h) => h.level !== 'PROVINCE' && strip(h.name) === needle);

    if (named && qualifier === null) {
      if (communes.length === 0) return provinceArea(named);
      return {
        kind: 'scope_choice',
        province: { code: named.code, name: named.name, fullName: named.fullName },
        communes: communes.map((c) => ({ code: c.code, name: c.name, fullName: c.fullName })),
      };
    }

    const provinces = new Set(communes.map((c) => c.parentCode));
    if (communes.length > 0 && provinces.size === 1) return communeArea(communes[0]!);
    if (provinces.size > 1) return { kind: 'ambiguous' };

    // Owner 2026-10-28 (Sol N-02): the new administrative address only. A
    // pre-2025 district ("Quận 10") or any phrase that names no current unit
    // is not recognised — not widened to a province, even one also named —
    // so the person is asked for a new address.
    return { kind: 'none' };
  }
}

/** Current units whose full dataset name the folded text contains as whole words. */
function exactHits(snapshot: Snapshot, folded: string): Unit[] {
  const out: Unit[] = [];
  for (const entry of snapshot.currentSearch ?? []) {
    const name = fold(entry.unit.fullName);
    if (name.trim().length >= 4 && folded.includes(name)) out.push(entry.unit);
  }
  return out;
}

/**
 * D-6 step 0: one commune hit → that commune (its parent named too is
 * consistent); several → narrowed by a province also named, else ambiguous;
 * only province hits → the province.
 */
function exactResolution(snapshot: Snapshot, folded: string): Unit | 'ambiguous' | null {
  const hits = exactHits(snapshot, folded);
  const communes = hits.filter((u) => u.level !== 'PROVINCE');
  const provinces = hits.filter((u) => u.level === 'PROVINCE');
  if (communes.length === 1) return communes[0]!;
  if (communes.length > 1) {
    const narrowed = communes.filter((c) => provinces.some((p) => p.code === c.parentCode));
    return narrowed.length === 1 ? narrowed[0]! : 'ambiguous';
  }
  return provinces.length === 1 ? provinces[0]! : null;
}
