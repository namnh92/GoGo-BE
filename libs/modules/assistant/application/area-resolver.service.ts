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
export type LatestMessage = { text: string; areaText: string | null; allowBareArea?: boolean };

/** Spoken names for the provinces people abbreviate, folded. */
const PROVINCE_ALIASES: [RegExp, string][] = [
  [/(?:^| )(sai gon|sg|hcm|tphcm|tp hcm|ho chi minh)(?= |$)/, 'ho chi minh'],
  [/(?:^| )(ha noi|hn)(?= |$)/, 'ha noi'],
  [/(?:^| )(da nang|dn)(?= |$)/, 'da nang'],
];

/** The word right before a phrase that says which level it means (D-6). */
const PROVINCE_QUALIFIER = /(?:^| )(?:thanh pho|tp|tinh|ca) $/;
const COMMUNE_QUALIFIER = /(?:^| )(?:phuong|xa|dac khu) $/;
/**
 * #739 (F-17) — the words that, typed right before a pre-2025 district's name,
 * say the person means that district ("Quận 1", "Huyện Củ Chi", "Q. Bình
 * Thạnh", "TP Thủ Đức"). Raw tokens, read before folding: "quán" is not "quận".
 * A level word alone decides nothing — the name after it must be a legacy
 * district in the published snapshot, so "Q Coffee" is a brand, not a district.
 */
const LEGACY_QUALIFIERS: readonly (readonly string[])[] = [
  ['quận'],
  ['quan'],
  ['q'],
  ['huyện'],
  ['huyen'],
  ['thị', 'xã'],
  ['thi', 'xa'],
  ['thành', 'phố'],
  ['thanh', 'pho'],
  ['tp'],
];
/** Qualifiers a current province-level city is also called by ("TP Huế"). */
const CITY_QUALIFIERS = new Set(['thành phố', 'thanh pho', 'tp']);
/**
 * PR #741 F-01 — "Quận"/"Q" before a number names a district whatever the
 * snapshot holds: no current unit is a quận (2025-07-01 left provinces,
 * phường, xã and đặc khu), and the pinned historical snapshot (v2.4.1) lacks
 * Quận 2 and Quận 9, dissolved into Thủ Đức in 2021. Not finding one there
 * must not widen "Q2, TP HCM" to the city (owner 2026-10-28).
 */
const NUMBERED_DISTRICT_QUALIFIERS = new Set(['quận', 'quan', 'q']);
const NUMBER = /^\d{1,2}$/;
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
  async namesArea(text: string, allowBareArea = true): Promise<boolean> {
    try {
      const snapshot = await this.query.snapshot();
      return namesAreaIn(snapshot, { text, areaText: null, allowBareArea });
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
    if (hasLegacyLocality(snapshot, message.text)) return { kind: 'none' };

    // 0. An exact level-qualified name in the message wins.
    const hit = exactResolution(snapshot, own);
    if (hit === 'ambiguous') return { kind: 'ambiguous' };
    if (hit?.level === 'PROVINCE') return provinceArea(hit);
    if (hit) return communeArea(hit);

    // The phrase under test: the message's area, else an alias in it, else a
    // bare unit name typed as the whole message.
    const bare = acceptsBareArea(message, own) ? bareHits(snapshot, own) : [];
    const phrase = bare[0]?.name ?? area ?? aliasIn(own)?.phrase ?? null;

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
      hits =
        bare.length > 0
          ? bare
          : this.query.search(snapshot, {
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
function bareHits(snapshot: Snapshot, folded: string): Unit[] {
  const answer = folded.replace(LOCATIVE, ' ').trim();
  if (answer.length < 2) return [];
  const units = snapshot.currentSearch?.map((entry) => entry.unit) ?? snapshot.currentProvinces;
  return units.filter((unit) => fold(strip(unit.name)).trim() === answer);
}

function acceptsBareArea(message: LatestMessage, folded: string): boolean {
  return message.allowBareArea !== false || LOCATIVE.test(folded);
}

/** Lowercase NFC words; "q1" splits into "q" and "1" as people type it. */
function rawTokens(text: string): string[] {
  const words =
    text
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.flatMap((w) => (/^q\d+$/.test(w) ? ['q', w.slice(1)] : [w]));
}

/** A name as folded tokens ("Bình Thạnh" → ["binh", "thanh"]). */
const foldedTokens = (name: string) => fold(name).trim().split(' ').filter(Boolean);

type LegacyIndex = {
  /** Legacy district names by their first folded token. */
  districts: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** Current provinces whose dataset name starts with "Thành phố", by name. */
  cities: readonly (readonly string[])[];
};

/** Built once per snapshot: snapshots are immutable (ADR-0019 §8). */
const legacyIndexes = new WeakMap<Snapshot, LegacyIndex>();

function legacyIndex(snapshot: Snapshot): LegacyIndex {
  const cached = legacyIndexes.get(snapshot);
  if (cached) return cached;
  const districts = new Map<string, string[][]>();
  for (const { unit } of snapshot.legacySearch ?? []) {
    if (unit.level !== 'LEGACY_DISTRICT') continue;
    const tokens = foldedTokens(unit.name);
    if (tokens.length === 0) continue;
    const list = districts.get(tokens[0]!);
    if (list) list.push(tokens);
    else districts.set(tokens[0]!, [tokens]);
  }
  const cities = snapshot.currentProvinces
    .filter((p) => fold(p.fullName).startsWith(' thanh pho '))
    .map((p) => foldedTokens(strip(p.name)));
  const index = { districts, cities };
  legacyIndexes.set(snapshot, index);
  return index;
}

const startsWith = (tokens: readonly string[], at: number, prefix: readonly string[]) =>
  prefix.length > 0 && prefix.every((t, i) => tokens[at + i] === t);

/**
 * #739 (F-17) — the text names a pre-2025 district: a level word (raw) right
 * before the name of a legacy district in the published snapshot
 * (`legacySearch`, level `LEGACY_DISTRICT`). A current province-level city
 * named after "Thành phố"/"TP" ("Thành phố Huế") is that city, not its old
 * same-name district. Owner 2026-10-28: such a district is not recognised.
 */
function hasLegacyLocality(snapshot: Snapshot, text: string): boolean {
  const { districts, cities } = legacyIndex(snapshot);
  const raw = rawTokens(text);
  const folded = raw.map((t) => foldedTokens(t).join(' '));
  for (let i = 0; i < raw.length; i++) {
    for (const qualifier of LEGACY_QUALIFIERS) {
      if (!startsWith(raw, i, qualifier)) continue;
      const at = i + qualifier.length;
      if (CITY_QUALIFIERS.has(qualifier.join(' ')) && cities.some((c) => startsWith(folded, at, c)))
        continue;
      if (NUMBERED_DISTRICT_QUALIFIERS.has(qualifier.join(' ')) && NUMBER.test(folded[at] ?? ''))
        return true;
      const candidates = districts.get(folded[at] ?? '') ?? [];
      if (candidates.some((name) => startsWith(folded, at, name))) return true;
    }
  }
  return false;
}

/** The message names an area on its own (D-5 gate, A-F-03 newest-first). */
function namesAreaIn(snapshot: Snapshot, message: LatestMessage): boolean {
  const own = fold(message.text);
  return (
    meaningful(message.areaText) !== null ||
    hasLegacyLocality(snapshot, message.text) ||
    aliasIn(own) !== null ||
    exactHits(snapshot, own).length > 0 ||
    (acceptsBareArea(message, own) && bareHits(snapshot, own).length > 0)
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
