import type { MappingRow } from '../domain/change-classification';

/**
 * ADM-002 (#455) — the advisory mapping CSV.
 *
 * Hand-parsed rather than pulled in behind a CSV library, because the parse has
 * to be exact about two things a general parser would paper over.
 *
 * First, `wardCode` arrives as a float string — `"1.0"`, `"4.0"` — while the
 * unit snapshots use zero-padded fixed-width codes (`"00001"`). Reading it as
 * text gives `1.0`, which matches nothing; reading it as a number and
 * re-padding is what makes the two sources comparable at all. The same applies
 * to province (2) and district (3).
 *
 * Second, five rows have an empty `wardCode`. Those are the island districts
 * that became đặc khu — a district-level predecessor, which is correct data in
 * an unexpected shape. `null` carries that through to the classifier instead of
 * a parse error or a zero.
 *
 * The file is verified to contain no quoted fields, so splitting on commas is
 * safe; the check is asserted rather than assumed.
 */

const REQUIRED = [
  'provinceCode',
  'districtCode',
  'wardCode',
  'province',
  'district',
  'ward',
  'newProvinceCode',
  'newWardCode',
  'newProvince',
  'newWard',
  'isMergedWard',
  'isDividedWard',
] as const;

function pad(value: string, width: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return String(Math.trunc(n)).padStart(width, '0');
}

export function parseMappingCsv(text: string): MappingRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('change-mapping snapshot is empty');
  if (text.includes('"')) {
    throw new Error(
      'change-mapping snapshot contains a quoted field; the comma split in this parser is no longer safe',
    );
  }

  const header = lines[0]!.split(',');
  const at: Record<string, number> = {};
  header.forEach((name, i) => (at[name.trim()] = i));
  for (const column of REQUIRED) {
    if (at[column] === undefined) {
      throw new Error(`change-mapping snapshot is missing column ${column}`);
    }
  }

  const rows: MappingRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const provinceCode = pad(c[at.provinceCode!]!, 2);
    const districtCode = pad(c[at.districtCode!]!, 3);
    if (provinceCode === null || districtCode === null) {
      throw new Error(`change-mapping row has no province or district code: ${line.slice(0, 80)}`);
    }
    rows.push({
      provinceCode,
      districtCode,
      wardCode: pad(c[at.wardCode!]!, 5),
      province: c[at.province!]!.trim(),
      district: c[at.district!]!.trim(),
      ward: c[at.ward!]!.trim(),
      newProvinceCode: c[at.newProvinceCode!]!.trim(),
      newWardCode: c[at.newWardCode!]!.trim(),
      newProvince: c[at.newProvince!]!.trim(),
      newWard: c[at.newWard!]!.trim(),
      isMergedWard: c[at.isMergedWard!]!.trim() === 'True',
      isDividedWard: c[at.isDividedWard!]!.trim() === 'True',
    });
  }
  return rows;
}
