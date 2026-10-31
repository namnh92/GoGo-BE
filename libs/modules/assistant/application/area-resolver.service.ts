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
/** A pre-2025 district or town as typed ("Quận 1", "Huyện Củ Chi", "Q.3"). */
const LEGACY_LOCALITY = /^(?:quan |huyen |thi xa |q\.?\s*\d)/;
/** Locative words a bare answer may start with ("ở Bến Thành"). */
const LOCATIVE = /^ (?:o|tai|khu vuc|khu|gan|quanh) /;

const meaningful = (t: string | null) =>
  t !== null && !QUALIFIER_ONLY.has(normalizeVietnamese(t).replace(/\./g, '').trim()) ? t : null;

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
   * #733 D-5 — whether the text, on its own, names an area: a current unit's
   * full dataset name ("Phường Sài Gòn"), a province alias ("Hà Nội", "SG"),
   * or a bare current unit name typed as the whole answer ("Bến Thành").
   * Read before the decision call, to tell an answer from a fresh request; a
   * snapshot failure is "no", never an error.
   */
  async namesArea(text: string): Promise<boolean> {
    try {
      const snapshot = await this.query.snapshot();
      return namesAreaIn(snapshot, { text, areaText: null });
    } catch {
      return false;
    }
  }

  /**
   * `messages` (#733 D-5/D-6, oldest first) are the episode's user turns:
   * the newest one that names an area decides (Astra A-F-03), so a later
   * correction outlives the turns after it. Without them, `latest` alone.
   */
  async resolve(
    fullText: string,
    areaText: string | null,
    latest: LatestMessage = { text: fullText, areaText },
    messages?: readonly LatestMessage[],
  ): Promise<AreaResolution> {
    let snapshot: Snapshot;
    try {
      snapshot = await this.query.snapshot();
    } catch {
      return { kind: 'none' };
    }
    const list = messages && messages.length > 0 ? messages : [latest];
    const chosen =
      [...list].reverse().find((m) => namesAreaIn(snapshot, m)) ?? list[list.length - 1]!;
    return this.resolveMessage(snapshot, chosen, fold(fullText));
  }

  private resolveMessage(
    snapshot: Snapshot,
    message: LatestMessage,
    folded: string,
  ): AreaResolution {
    const own = fold(message.text);

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

    // Owner 2026-10-28 / I-8 (Astra A-F-02): a pre-2025 district is not
    // recognised, and a province named next to it ("Quận 1, Thành phố Hồ Chí
    // Minh") does not widen it to the province.
    const area = meaningful(message.areaText);
    if (area && LEGACY_LOCALITY.test(normalizeVietnamese(area))) return { kind: 'none' };

    // 0. An exact level-qualified name in the message wins.
    const hit = exactResolution(snapshot, own);
    if (hit === 'ambiguous') return { kind: 'ambiguous' };
    if (hit?.level === 'PROVINCE') return provinceArea(hit);
    if (hit) return communeArea(hit);

    // The phrase under test: the message's area, else an alias in it, else a
    // bare unit name typed as the whole message.
    const phrase = area ?? aliasIn(own)?.phrase ?? bareName(snapshot, own) ?? null;

    // A province named elsewhere (this message first) scopes the commune search.
    const byAlias = (target: string) => provinceByAlias(snapshot, target);
    const contextProvince = provinceNamedIn(snapshot, own) ?? provinceNamedIn(snapshot, folded);

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

    // The level word right before the phrase, read in this message before
    // `strip` drops it: a typed "cả Sài Gòn" answers the scope question.
    const target = fold(phrase);
    const at = own.indexOf(target);
    const before = at >= 0 ? own.slice(0, at + 1) : '';
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

function aliasIn(folded: string): { phrase: string; target: string } | null {
  for (const [re, target] of PROVINCE_ALIASES) {
    const m = re.exec(folded);
    if (m) return { phrase: m[1]!, target };
  }
  return null;
}

function provinceByAlias(snapshot: Snapshot, target: string): Unit | undefined {
  return snapshot.currentProvinces.find((p) => strip(p.name).includes(target));
}

/** A province the folded text names, by alias or by its name (≥ 4 letters). */
function provinceNamedIn(snapshot: Snapshot, folded: string): Unit | null {
  const alias = aliasIn(folded);
  return (
    (alias ? provinceByAlias(snapshot, alias.target) : undefined) ??
    snapshot.currentProvinces.find((p) => {
      const n = strip(p.name);
      return n.length >= 4 && folded.includes(` ${n} `);
    }) ??
    null
  );
}

/** The whole message is a current unit's or province's bare name (Astra A-F-05). */
function bareName(snapshot: Snapshot, folded: string): string | null {
  const answer = folded.replace(LOCATIVE, ' ').trim();
  if (answer.length < 2) return null;
  for (const entry of snapshot.currentSearch ?? []) {
    if (strip(entry.unit.name) === answer) return answer;
  }
  return snapshot.currentProvinces.some((p) => strip(p.name) === answer) ? answer : null;
}

/** The message names an area on its own (D-5 gate, A-F-03 newest-first). */
function namesAreaIn(snapshot: Snapshot, message: LatestMessage): boolean {
  const own = fold(message.text);
  return (
    meaningful(message.areaText) !== null ||
    aliasIn(own) !== null ||
    exactHits(snapshot, own).length > 0 ||
    bareName(snapshot, own) !== null
  );
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
  // A province also named — by its full name, or by an alias or its name
  // outside the commune names ("phường Phú Thọ, TP HCM"); a province named
  // only inside a commune's own name ("Phú Thọ") is not one.
  let rest = folded;
  for (const c of communes) rest = rest.split(fold(c.fullName)).join('  ');
  const context = provinceNamedIn(snapshot, rest);
  if (communes.length === 1) {
    const commune = communes[0]!;
    // Sol F-05: a ward with a different province named next to it
    // ("Phường Ba Đình, TP HCM") is not guessed either way.
    const named = [...provinces.map((p) => p.code), ...(context ? [context.code] : [])];
    return named.every((code) => code === commune.parentCode) ? commune : 'ambiguous';
  }
  if (communes.length > 1) {
    const narrowed = communes.filter(
      (c) => provinces.some((p) => p.code === c.parentCode) || c.parentCode === context?.code,
    );
    return narrowed.length === 1 ? narrowed[0]! : 'ambiguous';
  }
  return provinces.length === 1 ? provinces[0]! : null;
}
