import type { IntentTaxonomy } from '../domain/intent';

/** The seed taxonomy (libs/database/src/seed.ts) — in production the caller reads it from the database. */
export const SEED_TAXONOMY: IntentTaxonomy = {
  category: [
    { key: 'cafe', label: 'Cà phê' },
    { key: 'restaurant', label: 'Nhà hàng' },
    { key: 'bar', label: 'Bar' },
    { key: 'park', label: 'Công viên' },
    { key: 'museum', label: 'Bảo tàng' },
    { key: 'cinema', label: 'Rạp phim' },
    { key: 'shopping', label: 'Mua sắm' },
    { key: 'lodging', label: 'Lưu trú' },
  ],
  mood: [
    { key: 'chill', label: 'Thư giãn' },
    { key: 'romantic', label: 'Lãng mạn' },
    { key: 'adventurous', label: 'Phiêu lưu' },
    { key: 'festive', label: 'Sôi động' },
    { key: 'cozy', label: 'Ấm cúng' },
  ],
  setting: [
    { key: 'indoor', label: 'Trong nhà' },
    { key: 'outdoor', label: 'Ngoài trời' },
    { key: 'rooftop', label: 'Rooftop' },
    { key: 'riverside', label: 'Ven sông' },
  ],
  suitability: [
    { key: 'couple', label: 'Cặp đôi' },
    { key: 'group', label: 'Nhóm bạn' },
    { key: 'family', label: 'Gia đình' },
  ],
  categorySynonyms: {
    cafe: ['cà phê', 'quán cà phê', 'coffee'],
    restaurant: ['quán ăn', 'nhà hàng', 'ăn uống'],
    park: ['công viên'],
    bar: ['quán bar', 'pub'],
    cinema: ['rạp phim', 'rạp chiếu phim'],
    museum: ['bảo tàng'],
    lodging: ['khách sạn', 'homestay'],
  },
};
