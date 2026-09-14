/**
 * ADM-022 (#569) — the canonical area a saved place or plan belongs to, as
 * facts a client can group by. Never a composed label, never a guess.
 *
 * A place belongs to a commune only through a VERIFIED mapping in the published
 * dataset (the bar publication uses). A plan belongs to an area only when every
 * stop does: all in one commune → that commune; one province, several communes
 * → the province; several provinces → `multiple_provinces`. One stop without a
 * usable mapping makes the whole plan `unknown` — grouping it by the stops that
 * happen to be mapped would be choosing for the user, and taking the first stop
 * would be choosing silently.
 */

export type MappingFacts = {
  provinceCode: string | null;
  communeCode: string | null;
  status: string;
  datasetVersion: string | null;
};

export type CommuneCodes = { provinceCode: string; communeCode: string };

export type SavedAreaCodes =
  | { scope: 'commune'; provinceCode: string; communeCode: string }
  | { scope: 'province'; provinceCode: string }
  | { scope: 'multiple_provinces' }
  | { scope: 'unknown' };

export type SavedItemArea = {
  scope: 'commune' | 'province' | 'multiple_provinces' | 'unknown';
  datasetVersion: string | null;
  provinceCode: string | null;
  provinceName: string | null;
  communeCode: string | null;
  communeName: string | null;
};

export const UNKNOWN_AREA: SavedItemArea = {
  scope: 'unknown',
  datasetVersion: null,
  provinceCode: null,
  provinceName: null,
  communeCode: null,
  communeName: null,
};

export function placeArea(
  mapping: MappingFacts | undefined,
  publishedVersion: string | null,
): CommuneCodes | null {
  if (!mapping || !publishedVersion) return null;
  if (mapping.status !== 'VERIFIED' || mapping.datasetVersion !== publishedVersion) return null;
  if (!mapping.provinceCode || !mapping.communeCode) return null;
  return { provinceCode: mapping.provinceCode, communeCode: mapping.communeCode };
}

export function planArea(stops: readonly (CommuneCodes | null)[]): SavedAreaCodes {
  if (stops.length === 0 || stops.some((stop) => stop === null)) return { scope: 'unknown' };
  const mapped = stops as readonly CommuneCodes[];
  const provinces = new Set(mapped.map((stop) => stop.provinceCode));
  if (provinces.size > 1) return { scope: 'multiple_provinces' };
  const provinceCode = mapped[0]!.provinceCode;
  const communes = new Set(mapped.map((stop) => stop.communeCode));
  return communes.size === 1
    ? { scope: 'commune', provinceCode, communeCode: mapped[0]!.communeCode }
    : { scope: 'province', provinceCode };
}

export type UnitLabel = {
  code: string;
  level: string;
  fullName: string;
  parentCode: string | null;
};

/** Labels come from the published dataset; a code it does not carry is unknown. */
export function withLabels(
  codes: SavedAreaCodes,
  datasetVersion: string,
  units: ReadonlyMap<string, UnitLabel>,
): SavedItemArea {
  if (codes.scope === 'unknown') return UNKNOWN_AREA;
  if (codes.scope === 'multiple_provinces')
    return { ...UNKNOWN_AREA, scope: 'multiple_provinces', datasetVersion };
  const province = units.get(`PROVINCE:${codes.provinceCode}`);
  if (!province) return UNKNOWN_AREA;
  if (codes.scope === 'province') {
    return {
      ...UNKNOWN_AREA,
      scope: 'province',
      datasetVersion,
      provinceCode: province.code,
      provinceName: province.fullName,
    };
  }
  const commune = units.get(`COMMUNE:${codes.communeCode}`);
  if (!commune || commune.parentCode !== province.code) return UNKNOWN_AREA;
  return {
    scope: 'commune',
    datasetVersion,
    provinceCode: province.code,
    provinceName: province.fullName,
    communeCode: commune.code,
    communeName: commune.fullName,
  };
}

/** Every province and commune code the labels have to be looked up for. */
export function codesToLabel(items: Iterable<SavedAreaCodes>): string[] {
  const codes = new Set<string>();
  for (const item of items) {
    if (item.scope === 'commune') {
      codes.add(item.provinceCode);
      codes.add(item.communeCode);
    } else if (item.scope === 'province') {
      codes.add(item.provinceCode);
    }
  }
  return [...codes];
}
