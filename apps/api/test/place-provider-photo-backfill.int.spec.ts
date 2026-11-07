import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@gogo/database';
import { SubmissionPhotoService } from '../../../libs/modules/ingestion/application/submission-photo.service';
import {
  backfillProviderPhotos,
  DbPhotoBackfillStore,
} from '../../../libs/modules/places/application/place-provider-photo-backfill';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
const answer = {
  status: 'ok',
  photos: [
    {
      contentType: 'image/jpeg',
      dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
      authorAttributions: [{ displayName: 'Synthetic author', uri: null, photoUri: null }],
      googleMapsUri: 'https://maps.google.com/synthetic',
    },
  ],
};
const photos = {
  enabled: vi.fn(async () => true),
  firstForProvider: vi.fn(async () => answer),
  probeForProvider: vi.fn(async () => ({ status: 'ok' as const, hasPhoto: true })),
};
const storage = {
  putObject: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
};
let persistence: SubmissionPhotoService;
let store: DbPhotoBackfillStore;
const options = { dryRun: false, probe: false, limit: 100 };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  persistence = new SubmissionPhotoService(db, photos as never, storage as never, true);
  store = new DbPhotoBackfillStore(db, persistence);
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});
beforeEach(async () => {
  await db.execute(sql`truncate places cascade`);
  await db.execute(sql`delete from media_cleanup_queue`);
  vi.clearAllMocks();
});
async function place(status: 'published' | 'draft' = 'published', canonical = true) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: 'Synthetic fixture',
      nameNormalized: 'synthetic fixture',
      geom: { x: 106.7, y: 10.77 },
      status,
    })
    .returning();
  const externalId = `fixture-${row!.id}`;
  if (canonical)
    await db.insert(schema.placeProviderSources).values({
      placeId: row!.id,
      provider: 'google_places',
      externalId,
    });
  else
    await db
      .insert(schema.placeSources)
      .values({ placeId: row!.id, provider: 'google', externalId });
  return { id: row!.id, externalId };
}
const media = (id: string) =>
  db.select().from(schema.placeMedia).where(eq(schema.placeMedia.placeId, id));

describe('#797 real SQL + shared #786 persistence', () => {
  it('filters publication/identity/approved media; dry-run/probe do not persist', async () => {
    const canonical = await place();
    const legacy = await place('published', false);
    await place('draft');
    const covered = await place();
    await db
      .insert(schema.placeMedia)
      .values({ placeId: covered.id, storageKey: 'editorial.jpg', moderation: 'approved' });
    const moved = await place();
    await db.execute(
      sql`update place_provider_sources set source_status = 'moved' where place_id = ${moved.id}::uuid`,
    );
    const noId = await place();
    await db.execute(sql`delete from place_provider_sources where place_id = ${noId.id}::uuid`);
    expect((await store.scan(null, 100)).map((p) => p.id).sort()).toEqual(
      [canonical.id, legacy.id].sort(),
    );
    for (const probe of [false, true]) {
      expect(
        await backfillProviderPhotos(store, photos, persistence, {
          ...options,
          dryRun: true,
          probe,
        }),
      ).toMatchObject({ total: 2, written: 0 });
    }
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(0);
    expect(await media(canonical.id)).toHaveLength(0);
  });
  it('retains one approved Google photo + credits, removes intent, reruns idempotently', async () => {
    const p = await place();
    expect(await backfillProviderPhotos(store, photos, persistence, options)).toMatchObject({
      written: 1,
      errors: 0,
    });
    expect(await media(p.id)).toMatchObject([
      {
        sourceType: 'google_derived',
        moderation: 'approved',
        attribution: 'Google Maps',
        moderatedBy: null,
        providerPhoto: {
          sourceReference: p.externalId,
          authorAttributions: answer.photos[0]!.authorAttributions,
        },
      },
    ]);
    const [row] = await media(p.id);
    expect(row!.storageKey).toMatch(/^places\/provider\//);
    expect(JSON.stringify(row)).not.toContain('/photos/');
    expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(0);
    expect(await backfillProviderPhotos(store, photos, persistence, options)).toMatchObject({
      total: 0,
      written: 0,
    });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent backfills and compensates the loser', async () => {
    const p = await place();
    const [a, b] = await Promise.all([
      persistence.prepare(p.externalId),
      persistence.prepare(p.externalId),
    ]);
    const results = await Promise.all([
      store.attachIfEligible(p, a!),
      store.attachIfEligible(p, b!),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await persistence.discard(results[0] ? b! : a!);
    expect(await media(p.id)).toHaveLength(1);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(0);
  });
  it.each(['identity', 'status', 'media'])(
    'rechecks %s after provider/storage work',
    async (change) => {
      const p = await place();
      const prepared = await persistence.prepare(p.externalId);
      if (change === 'identity')
        await db.execute(
          sql`update place_provider_sources set external_id = 'changed' where place_id = ${p.id}::uuid`,
        );
      if (change === 'status')
        await db.execute(sql`update places set status = 'draft' where id = ${p.id}::uuid`);
      if (change === 'media')
        await db
          .insert(schema.placeMedia)
          .values({ placeId: p.id, storageKey: 'manual.jpg', moderation: 'approved' });
      expect(await store.attachIfEligible(p, prepared!)).toBe(false);
      await persistence.discard(prepared!);
      expect((await media(p.id)).filter((m) => m.sourceType === 'google_derived')).toHaveLength(0);
      expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(0);
    },
  );
  it('rolls back attachment/intent deletion on audit failure, then compensation removes bytes', async () => {
    const p = await place();
    const prepared = await persistence.prepare(p.externalId);
    await db.execute(
      sql`create function fail_photo_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic'; end $$`,
    );
    await db.execute(
      sql`create trigger fail_photo_audit before insert on audit_logs for each row execute function fail_photo_audit()`,
    );
    try {
      await expect(store.attachIfEligible(p, prepared!)).rejects.toThrow();
      expect(await media(p.id)).toHaveLength(0);
      expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(1);
      await persistence.discard(prepared!);
      expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger fail_photo_audit on audit_logs`);
      await db.execute(sql`drop function fail_photo_audit()`);
    }
  });
});
