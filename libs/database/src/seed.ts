import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * FND-008 (data part): seeded demo data matching the mockup flows — taxonomy,
 * service areas, and a small verified place corpus around HCMC so search,
 * suggestion and plan flows are exercisable locally. Idempotent by design.
 */

const TAXONOMY: Record<string, { keys: string[]; labelsVi: Record<string, string> }> = {
  mood: {
    keys: ['chill', 'romantic', 'adventurous', 'festive', 'cozy'],
    labelsVi: {
      chill: 'Thư giãn',
      romantic: 'Lãng mạn',
      adventurous: 'Phiêu lưu',
      festive: 'Sôi động',
      cozy: 'Ấm cúng',
    },
  },
  category: {
    keys: ['cafe', 'restaurant', 'bar', 'park', 'museum', 'cinema', 'shopping', 'lodging'],
    labelsVi: {
      cafe: 'Cà phê',
      restaurant: 'Nhà hàng',
      bar: 'Bar',
      park: 'Công viên',
      museum: 'Bảo tàng',
      cinema: 'Rạp phim',
      shopping: 'Mua sắm',
      lodging: 'Lưu trú',
    },
  },
  setting: {
    keys: ['indoor', 'outdoor', 'rooftop', 'riverside'],
    labelsVi: {
      indoor: 'Trong nhà',
      outdoor: 'Ngoài trời',
      rooftop: 'Rooftop',
      riverside: 'Ven sông',
    },
  },
  dietary: {
    keys: ['vegetarian', 'vegan', 'halal', 'no_seafood'],
    labelsVi: {
      vegetarian: 'Chay',
      vegan: 'Thuần chay',
      halal: 'Halal',
      no_seafood: 'Không hải sản',
    },
  },
  accessibility: {
    keys: ['wheelchair', 'stroller', 'elevator'],
    labelsVi: { wheelchair: 'Xe lăn', stroller: 'Xe đẩy', elevator: 'Thang máy' },
  },
  spending_style: {
    keys: ['saver', 'balanced', 'treat'],
    labelsVi: { saver: 'Tiết kiệm', balanced: 'Cân bằng', treat: 'Chịu chi' },
  },
  suitability: {
    keys: ['couple', 'group', 'family'],
    labelsVi: { couple: 'Cặp đôi', group: 'Nhóm bạn', family: 'Gia đình' },
  },
};

const SERVICE_AREAS = [
  {
    key: 'hcm_q1',
    name: 'Quận 1, TP.HCM',
    city: 'TP.HCM',
    centerLat: 10.7769,
    centerLng: 106.7009,
    radiusM: 3000,
  },
  {
    key: 'hcm_q3',
    name: 'Quận 3, TP.HCM',
    city: 'TP.HCM',
    centerLat: 10.7843,
    centerLng: 106.6844,
    radiusM: 2500,
  },
  {
    key: 'hcm_thuduc',
    name: 'TP. Thủ Đức',
    city: 'TP.HCM',
    centerLat: 10.8494,
    centerLng: 106.7537,
    radiusM: 8000,
  },
  {
    key: 'hn_hoankiem',
    name: 'Hoàn Kiếm, Hà Nội',
    city: 'Hà Nội',
    centerLat: 21.0285,
    centerLng: 105.8542,
    radiusM: 2500,
  },
];

type DemoPlace = {
  name: string;
  lat: number;
  lng: number;
  areaKey: string;
  categories: string[];
  moods: string[];
  settings: string[];
  suitability: Record<string, number>;
  priceMin: number;
  priceMax: number;
  rating: number;
  ratingCount: number;
  avgVisitMinutes: number;
  hours: { open: number; close: number };
};

const DEMO_PLACES: DemoPlace[] = [
  {
    name: 'The Workshop Coffee',
    lat: 10.7743,
    lng: 106.7038,
    areaKey: 'hcm_q1',
    categories: ['cafe'],
    moods: ['chill', 'cozy'],
    settings: ['indoor'],
    suitability: { couple: 0.9, group: 0.7 },
    priceMin: 60000,
    priceMax: 120000,
    rating: 4.5,
    ratingCount: 2100,
    avgVisitMinutes: 90,
    hours: { open: 8 * 60, close: 21 * 60 },
  },
  {
    name: 'Nhà hàng Ngon 138',
    lat: 10.7797,
    lng: 106.6994,
    areaKey: 'hcm_q1',
    categories: ['restaurant'],
    moods: ['festive'],
    settings: ['indoor', 'outdoor'],
    suitability: { couple: 0.7, group: 0.9 },
    priceMin: 150000,
    priceMax: 350000,
    rating: 4.3,
    ratingCount: 8900,
    avgVisitMinutes: 75,
    hours: { open: 10 * 60, close: 22 * 60 },
  },
  {
    name: 'Công viên Tao Đàn',
    lat: 10.7756,
    lng: 106.6917,
    areaKey: 'hcm_q1',
    categories: ['park'],
    moods: ['chill'],
    settings: ['outdoor'],
    suitability: { couple: 0.8, group: 0.8, family: 0.9 },
    priceMin: 0,
    priceMax: 0,
    rating: 4.4,
    ratingCount: 5200,
    avgVisitMinutes: 60,
    hours: { open: 5 * 60, close: 21 * 60 },
  },
  {
    name: 'Bảo tàng Mỹ thuật TP.HCM',
    lat: 10.7699,
    lng: 106.6992,
    areaKey: 'hcm_q1',
    categories: ['museum'],
    moods: ['chill', 'romantic'],
    settings: ['indoor'],
    suitability: { couple: 0.85, group: 0.6 },
    priceMin: 30000,
    priceMax: 30000,
    rating: 4.4,
    ratingCount: 3100,
    avgVisitMinutes: 90,
    hours: { open: 8 * 60, close: 17 * 60 },
  },
  {
    name: 'Saigon Rooftop Bar',
    lat: 10.7721,
    lng: 106.7042,
    areaKey: 'hcm_q1',
    categories: ['bar'],
    moods: ['festive', 'romantic'],
    settings: ['rooftop'],
    suitability: { couple: 0.9, group: 0.85 },
    priceMin: 200000,
    priceMax: 500000,
    rating: 4.2,
    ratingCount: 1700,
    avgVisitMinutes: 120,
    hours: { open: 17 * 60, close: 23 * 60 + 59 },
  },
  {
    name: 'Cà phê Đỗ Phủ - Biệt động Sài Gòn',
    lat: 10.7889,
    lng: 106.6903,
    areaKey: 'hcm_q3',
    categories: ['cafe', 'museum'],
    moods: ['cozy'],
    settings: ['indoor'],
    suitability: { couple: 0.8, group: 0.7 },
    priceMin: 45000,
    priceMax: 90000,
    rating: 4.6,
    ratingCount: 980,
    avgVisitMinutes: 60,
    hours: { open: 7 * 60, close: 20 * 60 },
  },
  {
    name: 'Hồ Con Rùa Foodcourt',
    lat: 10.7827,
    lng: 106.6959,
    areaKey: 'hcm_q3',
    categories: ['restaurant'],
    moods: ['festive', 'chill'],
    settings: ['outdoor'],
    suitability: { couple: 0.6, group: 0.95 },
    priceMin: 40000,
    priceMax: 120000,
    rating: 4.1,
    ratingCount: 4300,
    avgVisitMinutes: 60,
    hours: { open: 15 * 60, close: 23 * 60 },
  },
  {
    name: 'Landmark 81 SkyView',
    lat: 10.7951,
    lng: 106.7218,
    areaKey: 'hcm_thuduc',
    categories: ['shopping'],
    moods: ['romantic', 'adventurous'],
    settings: ['indoor', 'rooftop'],
    suitability: { couple: 0.95, group: 0.7 },
    priceMin: 250000,
    priceMax: 450000,
    rating: 4.5,
    ratingCount: 6100,
    avgVisitMinutes: 90,
    hours: { open: 9 * 60, close: 22 * 60 },
  },
  {
    name: 'Phố đi bộ Nguyễn Huệ',
    lat: 10.7741,
    lng: 106.7047,
    areaKey: 'hcm_q1',
    categories: ['park'],
    moods: ['festive'],
    settings: ['outdoor'],
    suitability: { couple: 0.75, group: 0.9 },
    priceMin: 0,
    priceMax: 50000,
    rating: 4.5,
    ratingCount: 12000,
    avgVisitMinutes: 60,
    hours: { open: 0, close: 23 * 60 + 59 },
  },
  {
    name: 'CGV Vincom Đồng Khởi',
    lat: 10.7782,
    lng: 106.7018,
    areaKey: 'hcm_q1',
    categories: ['cinema'],
    moods: ['cozy', 'chill'],
    settings: ['indoor'],
    suitability: { couple: 0.9, group: 0.8 },
    priceMin: 90000,
    priceMax: 180000,
    rating: 4.3,
    ratingCount: 7800,
    avgVisitMinutes: 150,
    hours: { open: 9 * 60, close: 23 * 60 },
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  // Taxonomy + vi labels
  for (const [kind, def] of Object.entries(TAXONOMY)) {
    for (const [i, key] of def.keys.entries()) {
      const [row] = await db
        .insert(schema.taxonomies)
        .values({ kind: kind as never, key, sortOrder: i })
        .onConflictDoUpdate({
          target: [schema.taxonomies.kind, schema.taxonomies.key],
          set: { sortOrder: i, updatedAt: sql`now()` },
        })
        .returning({ id: schema.taxonomies.id });
      if (!row) continue;
      await db
        .insert(schema.taxonomyLabels)
        .values({ taxonomyId: row.id, locale: 'vi', label: def.labelsVi[key] ?? key })
        .onConflictDoUpdate({
          target: [schema.taxonomyLabels.taxonomyId, schema.taxonomyLabels.locale],
          set: { label: def.labelsVi[key] ?? key },
        });
    }
  }

  // SE-001 — generic-term synonyms expanding to categories in search.
  const CATEGORY_SYNONYMS: Record<string, string[]> = {
    cafe: ['cà phê', 'quán cà phê', 'coffee'],
    restaurant: ['quán ăn', 'nhà hàng', 'ăn uống'],
    park: ['công viên'],
    bar: ['quán bar', 'pub'],
    cinema: ['rạp phim', 'rạp chiếu phim'],
    museum: ['bảo tàng'],
    lodging: ['khách sạn', 'homestay'],
  };
  const catRows = await db
    .select()
    .from(schema.taxonomies)
    .where(sql`${schema.taxonomies.kind} = 'category'`);
  for (const [key, terms] of Object.entries(CATEGORY_SYNONYMS)) {
    const cat = catRows.find((c) => c.key === key);
    if (!cat) continue;
    for (const term of terms) {
      await db
        .insert(schema.taxonomySynonyms)
        .values({ taxonomyId: cat.id, term, locale: 'vi' })
        .onConflictDoNothing();
    }
  }

  for (const [i, area] of SERVICE_AREAS.entries()) {
    await db
      .insert(schema.serviceAreas)
      .values({ ...area, sortOrder: i })
      .onConflictDoUpdate({
        target: schema.serviceAreas.key,
        set: { name: area.name, city: area.city, sortOrder: i },
      });
  }

  const taxonomyRows = await db.select().from(schema.taxonomies);
  const taxId = (kind: string, key: string): string => {
    const row = taxonomyRows.find((t) => t.kind === kind && t.key === key);
    if (!row) throw new Error(`missing taxonomy ${kind}/${key}`);
    return row.id;
  };

  for (const p of DEMO_PLACES) {
    const existing = await db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(sql`${schema.places.name} = ${p.name}`);
    if (existing.length > 0) continue;

    const [place] = await db
      .insert(schema.places)
      .values({
        name: p.name,
        nameNormalized: p.name.toLowerCase(),
        status: 'published',
        geom: { x: p.lng, y: p.lat },
        areaKey: p.areaKey,
        rating: p.rating.toFixed(2),
        ratingCount: p.ratingCount,
        avgVisitMinutes: p.avgVisitMinutes,
        suitability: p.suitability,
        isLodging: p.categories.includes('lodging'),
        confidence: '0.90',
        freshnessCheckedAt: new Date(),
      })
      .returning({ id: schema.places.id });
    if (!place) continue;

    const links = [
      ...p.categories.map((k) => taxId('category', k)),
      ...p.moods.map((k) => taxId('mood', k)),
      ...p.settings.map((k) => taxId('setting', k)),
    ];
    for (const taxonomyId of links) {
      await db
        .insert(schema.placeTaxonomies)
        .values({ placeId: place.id, taxonomyId })
        .onConflictDoNothing();
    }
    await db.insert(schema.placePrices).values({
      placeId: place.id,
      priceMin: p.priceMin,
      priceMax: p.priceMax,
      currency: 'VND',
      unit: 'per_person',
      confidence: '0.80',
      source: 'editor',
      verifiedAt: new Date(),
    });
    for (let day = 0; day < 7; day++) {
      await db.insert(schema.placeHours).values({
        placeId: place.id,
        dayOfWeek: day,
        openMinute: p.hours.open,
        closeMinute: p.hours.close,
        isOvernight: false,
        source: 'editor',
      });
    }
  }

  // Dev-only CMS bootstrap admin — production admins are created by a
  // super admin through the API and must enroll MFA.
  //
  // Guarded on APP_ENV, not NODE_ENV. NODE_ENV is the build mode and every
  // deployed environment sets it to `production`, including DEV — so this used
  // to skip on the one environment that needs it, leaving no way to sign in to
  // the CMS at all. APP_ENV names the environment: dev, staging, prod.
  //
  // Unset means a workstation, which is also not production.
  const appEnv = process.env.APP_ENV ?? 'dev';
  if (appEnv !== 'prod' && appEnv !== 'production') {
    const { default: argon2 } = await import('argon2');

    // Overridable rather than hardcoded. The default is a convenience for a
    // shared DEV environment that already sits behind Cloudflare Access, and it
    // is weak on purpose — but it lives in version control, and the APP_ENV
    // guard above is the only thing keeping it out of production. An
    // environment that wants different credentials should not need a code
    // change to get them.
    const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@gogo.id.vn';
    const password = process.env.SEED_ADMIN_PASSWORD ?? '123456';

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await db
      .insert(schema.adminUsers)
      .values({
        email,
        passwordHash,
        displayName: 'Dev Super Admin',
        role: 'super_admin',
      })
      .onConflictDoNothing();
  }

  await pool.end();
  // eslint-disable-next-line no-console
  console.log('seed complete');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
