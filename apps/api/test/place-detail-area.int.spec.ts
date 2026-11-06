import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { SearchRepository } from '../../../libs/modules/search/infrastructure/search.repository';
import { SearchService } from '../../../libs/modules/search/application/search.service';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let service: SearchService;
let datasetId: string;
let placeId: string;
const version = 'detail-area-784';
const province = '79';
const commune = '26734';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  const [dataset] = await db
    .insert(schema.administrativeDatasetVersions)
    .values({
      combinedDatasetVersion: version,
      combinedChecksum: version,
      currentSourceVersion: version,
      source: 'test-fixture',
      effectiveDate: '2025-07-01',
      status: 'PUBLISHED',
    })
    .returning();
  datasetId = dataset!.id;
  await db.insert(schema.administrativeUnits).values(
    [
      {
        code: province,
        name: 'Hồ Chí Minh',
        level: 'PROVINCE' as const,
        unitType: 'MUNICIPALITY' as const,
      },
      {
        code: commune,
        name: 'Bến Nghé',
        level: 'COMMUNE' as const,
        unitType: 'WARD' as const,
        parentCode: province,
      },
    ].map((u) => ({
      ...u,
      datasetVersionId: datasetId,
      fullName: u.name,
      nameNormalized: u.code,
      fullNameNormalized: u.code,
      effectiveFrom: '2025-07-01',
      source: 'test-fixture',
      sourceVersion: version,
    })),
  );
  const [place] = await db
    .insert(schema.places)
    .values({
      name: 'detailarea784',
      nameNormalized: 'detailarea784',
      status: 'published',
      geom: { x: 106.7, y: 10.77 },
      addressText: '12 Nguyễn Huệ',
    })
    .returning();
  placeId = place!.id;
  service = new SearchService(new SearchRepository(db), db);
});

beforeEach(async () => {
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED' })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));
  await db
    .update(schema.administrativeUnits)
    .set({ status: 'ACTIVE', effectiveFrom: '2025-07-01', effectiveTo: null });
  await db
    .update(schema.places)
    .set({
      status: 'published',
      administrativeMappingStatus: 'VERIFIED',
      administrativeDatasetVersion: version,
      provinceCode: province,
      communeCode: commune,
    })
    .where(eq(schema.places.id, placeId));
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function expectArea(expected: unknown) {
  const detail = await service.placeDetail(placeId);
  const page = await service.search({
    q: 'detailarea784',
    sort: 'curated',
    limit: 10,
    scoredAt: new Date(),
  });
  expect(page.results).toHaveLength(1);
  expect(detail.areaSummary).toEqual(expected);
  expect(detail.areaSummary).toEqual(page.results[0]!.areaSummary);
  expect(detail.addressText).toBe('12 Nguyễn Huệ');
  if (expected === undefined)
    expect(JSON.parse(JSON.stringify(detail))).not.toHaveProperty('areaSummary');
}

const area = (communeCode: string | null, label: string) => ({
  datasetVersion: version,
  provinceCode: province,
  communeCode,
  label,
  locale: 'vi',
});

describe('Place Detail/search administrative parity (#784)', () => {
  it('prefers a current verified commune over its province', async () => {
    await expectArea(area(commune, 'Bến Nghé'));
  });
  it('falls back to province without a commune', async () => {
    await db.update(schema.places).set({ communeCode: null }).where(eq(schema.places.id, placeId));
    await expectArea(area(null, 'Hồ Chí Minh'));
  });
  it.each(['INACTIVE', 'expired', 'future'] as const)(
    'falls back for a %s commune',
    async (state) => {
      await db
        .update(schema.administrativeUnits)
        .set(
          state === 'INACTIVE'
            ? { status: state }
            : state === 'expired'
              ? { effectiveTo: '2025-07-02' }
              : { effectiveFrom: '2099-01-01' },
        )
        .where(eq(schema.administrativeUnits.code, commune));
      await expectArea(area(null, 'Hồ Chí Minh'));
    },
  );
  it.each(['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW', 'REJECTED', 'STALE'] as const)(
    'omits %s mappings',
    async (status) => {
      await db
        .update(schema.places)
        .set({ administrativeMappingStatus: status })
        .where(eq(schema.places.id, placeId));
      await expectArea(undefined);
    },
  );
  it('omits mappings from an older dataset', async () => {
    await db
      .update(schema.places)
      .set({ administrativeDatasetVersion: 'older' })
      .where(eq(schema.places.id, placeId));
    await expectArea(undefined);
  });
  it('omits mappings when the dataset is no longer published', async () => {
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'ROLLED_BACK' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    await expectArea(undefined);
  });
  it('omits when neither unit is active', async () => {
    await db.update(schema.administrativeUnits).set({ status: 'INACTIVE' });
    await expectArea(undefined);
  });
  it.each(['draft', 'suspended'] as const)('keeps %s places inaccessible', async (status) => {
    await db.update(schema.places).set({ status }).where(eq(schema.places.id, placeId));
    await expect(service.placeDetail(placeId)).rejects.toMatchObject({ code: 'PLACE_NOT_FOUND' });
  });
});
