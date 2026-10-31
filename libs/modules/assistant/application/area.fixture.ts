/**
 * A small published-dataset stand-in for the assistant's area tests (#733):
 * names as in v5.1.0 — province `name` "Hồ Chí Minh", `fullName` "Thành phố
 * Hồ Chí Minh", and Phường Sài Gòn (26740) inside it.
 */
import { normalizeVietnamese } from '../../search/domain/normalize';

const unit = (code: string, name: string, fullName: string, parentCode: string | null) => ({
  code,
  name,
  fullName,
  level: parentCode ? 'WARD' : 'PROVINCE',
  parentCode,
  isCurrent: true,
});

export const HCM_V5 = unit('79', 'Hồ Chí Minh', 'Thành phố Hồ Chí Minh', null);
export const HN_V5 = unit('01', 'Hà Nội', 'Thành phố Hà Nội', null);
export const SAI_GON_WARD = unit('26740', 'Sài Gòn', 'Phường Sài Gòn', '79');
export const BEN_THANH_WARD = unit('26734', 'Bến Thành', 'Phường Bến Thành', '79');
export const PHU_THO_V5 = unit('25', 'Phú Thọ', 'Tỉnh Phú Thọ', null);
const THAI_NGUYEN = unit('19', 'Thái Nguyên', 'Tỉnh Thái Nguyên', null);
const LAM_DONG = unit('68', 'Lâm Đồng', 'Tỉnh Lâm Đồng', null);
const QUANG_NINH = unit('22', 'Quảng Ninh', 'Thành phố Quảng Ninh', null);
const UNITS = [
  HN_V5,
  PHU_THO_V5,
  HCM_V5,
  THAI_NGUYEN,
  LAM_DONG,
  QUANG_NINH,
  unit('05587', 'Bình Yên', 'Xã Bình Yên', '19'),
  // Synthetic codes: punctuation coverage needs names, not production ids.
  unit('99991', "B'Lao", "Phường B'Lao", '68'),
  unit('99992', "D'Ran", "Xã D'Ran", '68'),
  unit('00004', 'Ba Đình', 'Phường Ba Đình', '01'),
  // The same ward name in two provinces, as in v5.1.0.
  unit('07942', 'Phú Thọ', 'Phường Phú Thọ', '25'),
  BEN_THANH_WARD,
  SAI_GON_WARD,
  unit('27226', 'Phú Thọ', 'Phường Phú Thọ', '79'),
];

/**
 * Pre-2025 districts as the historical snapshot names them (v2.4.1 codes):
 * `name` without the level word, `level` LEGACY_DISTRICT (#739).
 */
const legacy = (code: string, name: string, fullName: string, parentCode: string) => ({
  code,
  name,
  fullName,
  level: 'LEGACY_DISTRICT',
  parentCode,
  isCurrent: false,
});
const LEGACY = [
  legacy('760', '1', 'Quận 1', '79'),
  legacy('771', '10', 'Quận 10', '79'),
  legacy('765', 'Bình Thạnh', 'Quận Bình Thạnh', '79'),
  legacy('769', 'Thủ Đức', 'Thành phố Thủ Đức', '79'),
  legacy('783', 'Củ Chi', 'Huyện Củ Chi', '79'),
  legacy('164', 'Thái Nguyên', 'Thành phố Thái Nguyên', '19'),
  legacy('672', 'Đà Lạt', 'Thành phố Đà Lạt', '68'),
  legacy('721', 'Bến Cát', 'Thành phố Bến Cát', '74'),
  // Named like a current province-level city (Thành phố Quảng Ninh, v5.1.0).
  legacy('456', 'Quảng Ninh', 'Huyện Quảng Ninh', '44'),
];

/** An `AdministrativeQueryService` double over the units above. */
export function v5Query() {
  return {
    snapshot: async () => ({
      datasetVersion: 'v5.1.0',
      currentProvinces: [HN_V5, QUANG_NINH, PHU_THO_V5, HCM_V5, THAI_NGUYEN, LAM_DONG],
      currentSearch: UNITS.map((u) => ({
        unit: u,
        nameNormalized: normalizeVietnamese(u.name),
        fullNameNormalized: normalizeVietnamese(u.fullName),
      })),
      legacySearch: LEGACY.map((u) => ({
        unit: u,
        nameNormalized: normalizeVietnamese(u.name),
        fullNameNormalized: normalizeVietnamese(u.fullName),
      })),
    }),
    search: (_s: unknown, o: { query: string; provinceCode?: string }) => ({
      items: UNITS.filter((u) => {
        const owner = u.parentCode ?? u.code;
        if (o.provinceCode && owner !== o.provinceCode) return false;
        const n = normalizeVietnamese(o.query);
        return (
          normalizeVietnamese(u.name).includes(n) || normalizeVietnamese(u.fullName).includes(n)
        );
      }),
    }),
  };
}
