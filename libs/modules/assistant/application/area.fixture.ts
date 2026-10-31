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
const UNITS = [
  HN_V5,
  PHU_THO_V5,
  HCM_V5,
  unit('00004', 'Ba Đình', 'Phường Ba Đình', '01'),
  // The same ward name in two provinces, as in v5.1.0.
  unit('07942', 'Phú Thọ', 'Phường Phú Thọ', '25'),
  BEN_THANH_WARD,
  SAI_GON_WARD,
  unit('27226', 'Phú Thọ', 'Phường Phú Thọ', '79'),
];

/** An `AdministrativeQueryService` double over the units above. */
export function v5Query() {
  return {
    snapshot: async () => ({
      datasetVersion: 'v5.1.0',
      currentProvinces: [HN_V5, PHU_THO_V5, HCM_V5],
      currentSearch: UNITS.map((u) => ({
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
