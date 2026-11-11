import { SubmissionPhotosService } from '../../../libs/modules/ingestion/application/submission-photos.service';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { schema, type Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrateWithCreditIndexes as migrate } from './support/credit-events';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaceDedupService } from '../../../libs/modules/ingestion/application/place-dedup.service';
import { PlaceImportJobService } from '../../../libs/modules/ingestion/application/place-import-job.service';
import { PlaceSubmissionService } from '../../../libs/modules/ingestion/application/place-submission.service';
import { validateRow } from '../../../libs/modules/ingestion/domain/template';
import { creditBalance } from '../../../libs/modules/shared/assistant-credits';

// CI only. Both services use real PostgreSQL transactions on separate sessions;
// only provider I/O is stubbed. No sleeps decide which transaction wins.
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Pause after the actual PostgreSQL lock, before the owner's first write. */
class PausedIdentityClaim extends PlaceDedupService {
  acquired = false;
  readonly resume = barrier();

  override async lockGoogleIdentities(runner: Pick<Db, 'execute'>, ids: string[]): Promise<void> {
    await super.lockGoogleIdentities(runner, ids);
    if (!this.acquired) {
      this.acquired = true;
      await this.resume.promise;
    }
  }
}

const detailsFor = (providerPlaceId: string): ResolvedProviderPlace => ({
  providerPlaceId,
  name: `Identity race ${providerPlaceId}`,
  addressText: '',
  lat: 10.77,
  lng: 106.7,
  rating: null,
  ratingCount: 0,
  priceLevel: null,
  hours: [],
  businessStatus: 'OPERATIONAL',
  fetchTier: 'quality',
  primaryType: 'cafe',
  types: ['cafe'],
  attribution: 'Google',
  googleMapsUri: null,
  raw: null,
});

// Attach a rejection handler as soon as a competing operation starts, including
// assertion-failure cleanup while the other transaction is still paused.
function settled<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

describe('F-02 PostgreSQL approval versus bulk import identity claims', () => {
  it.each(['approval', 'import'] as const)(
    '%s wins: one place, no ownership overwrite, at most one +50 award',
    async (winner) => {
      const identity = `775-race-${randomUUID()}`;
      const adminId = randomUUID();
      const [contributor] = await db
        .insert(schema.users)
        .values({ displayName: 'Race contributor' })
        .returning();
      const [submission] = await db
        .insert(schema.placeSubmissions)
        .values({
          googlePlaceId: identity,
          submittedByUserId: contributor!.id,
        })
        .returning();
      const [job] = await db
        .insert(schema.placeIngestJobs)
        .values({
          sourceType: 'csv',
          mode: 'create_drafts',
          createdByAdminId: adminId,
        })
        .returning();
      const normalized = validateRow({
        source_row_id: identity,
        google_place_id: identity,
      }).normalized;
      const [row] = await db
        .insert(schema.placeIngestRows)
        .values({
          jobId: job!.id,
          sourceRowId: identity,
          rowNumber: 1,
          rawInput: {},
          normalizedInput: normalized,
          resolvedGooglePlaceId: identity,
          status: 'ready',
        })
        .returning();
      const resolver = {
        resolveByProviderId: async (id: string) => ({
          status: 'RESOLVED',
          details: detailsFor(id),
        }),
        scoreFor: async () => 0.5,
      };
      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      // Dedicated clients make pg_blocking_pids evidence specific to these two
      // application transactions, rather than an unrelated test/session.
      const firstDb = drizzle(firstClient, { schema }) as unknown as Db;
      const secondDb = drizzle(secondClient, { schema }) as unknown as Db;
      const firstDedup = new PausedIdentityClaim(firstDb);
      const secondDedup = new PlaceDedupService(secondDb);
      const approveDb = winner === 'approval' ? firstDb : secondDb;
      const importDb = winner === 'import' ? firstDb : secondDb;
      const approval = new PlaceSubmissionService(
        approveDb,
        resolver as never,
        winner === 'approval' ? firstDedup : secondDedup,
        {} as never,
        {} as never,
        new SubmissionPhotosService(approveDb, {} as never, {} as never, {} as never),
      );
      const imports = new PlaceImportJobService(
        importDb,
        resolver as never,
        winner === 'import' ? firstDedup : secondDedup,
        {} as never,
        {} as never,
        { APP_ENV: 'dev', PLACE_RESOLUTION_TTL_S: 600 },
      );
      const approve = () => approval.decide(adminId, submission!.id, 'approved', 'Checked');
      // Exercise the bulk creator itself: job iteration catches this conflict
      // to mark a row, while the real creator owns the atomic place/source write.
      const importPlace = () =>
        (
          imports as unknown as {
            createPlaceFromRow: (
              row: typeof schema.placeIngestRows.$inferSelect,
              mode: 'create_drafts',
              actor: string,
            ) => Promise<string>;
          }
        ).createPlaceFromRow(row!, 'create_drafts', adminId);
      const pending: Promise<unknown>[] = [];
      try {
        // Bound unexpected deadlocks and ensure cleanup can always drain work.
        await firstClient.query("set statement_timeout = '15s'");
        await secondClient.query("set statement_timeout = '15s'");
        const firstPid = (
          await firstClient.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0]!.pid;
        const secondPid = (
          await secondClient.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0]!.pid;
        const before = await db.select({ id: schema.places.id }).from(schema.places);
        const first = settled<string | Awaited<ReturnType<typeof approve>>>(
          winner === 'approval' ? approve() : importPlace(),
        );
        pending.push(first);
        await expect.poll(() => firstDedup.acquired, { timeout: 5000 }).toBe(true);
        const second = settled<string | Awaited<ReturnType<typeof approve>>>(
          winner === 'approval' ? importPlace() : approve(),
        );
        pending.push(second);
        // The loser must actually be waiting for the winner's advisory lock.
        // Releasing after a JS callback alone would not establish a DB race.
        await expect
          .poll(
            async () => {
              const blocked = await pool.query<{ blockers: number[]; wait_event: string }>(
                'select pg_blocking_pids(pid) as blockers, wait_event from pg_stat_activity where pid=$1',
                [secondPid],
              );
              return blocked.rows[0];
            },
            { timeout: 5000 },
          )
          .toEqual({ blockers: [firstPid], wait_event: 'advisory' });
        expect(await db.select({ id: schema.places.id }).from(schema.places)).toEqual(before);
        firstDedup.resume.release();
        const won = await first;
        expect(won.status).toBe('fulfilled');
        expect(await second).toMatchObject({
          status: 'rejected',
          reason: { code: 'DUPLICATE_VENUE' },
        });
        const sources = await db
          .select()
          .from(schema.placeProviderSources)
          .where(eq(schema.placeProviderSources.externalId, identity));
        expect(sources).toHaveLength(1);
        const ownerId = sources[0]!.placeId;
        if (won.status === 'fulfilled') {
          expect(typeof won.value === 'string' ? won.value : won.value.placeId).toBe(ownerId);
        }
        const places = await db.select({ id: schema.places.id }).from(schema.places);
        expect(places.filter((p) => !before.some((old) => old.id === p.id))).toEqual([
          { id: ownerId },
        ]);
        const [decided] = await db
          .select()
          .from(schema.placeSubmissions)
          .where(eq(schema.placeSubmissions.id, submission!.id));
        const [imported] = await db
          .select()
          .from(schema.placeIngestRows)
          .where(eq(schema.placeIngestRows.id, row!.id));
        expect(decided!.status).toBe(winner === 'approval' ? 'approved' : 'pending');
        expect(decided!.resultPlaceId).toBe(winner === 'approval' ? ownerId : null);
        expect(imported!.status).toBe(winner === 'import' ? 'imported' : 'ready');
        expect(imported!.matchedPlaceId).toBe(winner === 'import' ? ownerId : null);
        const ledger = await db.execute(sql`
          select user_id, delta, submission_id from assistant_credit_ledger
          where venue_identity = ${`google:${identity}`}
        `);
        expect(ledger.rows).toEqual(
          winner === 'approval'
            ? [
                {
                  user_id: contributor!.id,
                  delta: 50,
                  submission_id: submission!.id,
                },
              ]
            : [],
        );
        expect(await creditBalance(db, contributor!.id)).toBe(winner === 'approval' ? 50 : 0);
        // A later snapshot refresh aimed at a different place must also refuse
        // the identity, leaving the first owner's source and award intact.
        const [other] = await db
          .insert(schema.places)
          .values({
            name: 'Unrelated target',
            nameNormalized: 'x',
            status: 'draft',
            geom: { x: 106.7, y: 10.77 },
          })
          .returning();
        await expect(
          new PlaceDedupService(db).upsertProviderSource({
            placeId: other!.id,
            details: detailsFor(identity),
            derivedScore: 0.5,
            fetchTier: 'quality',
          }),
        ).rejects.toMatchObject({ code: 'DUPLICATE_VENUE' });
        expect(
          await db
            .select()
            .from(schema.placeProviderSources)
            .where(eq(schema.placeProviderSources.externalId, identity)),
        ).toEqual(sources);
        expect(await creditBalance(db, contributor!.id)).toBe(winner === 'approval' ? 50 : 0);
      } finally {
        firstDedup.resume.release();
        await Promise.allSettled(pending);
        firstClient.release();
        secondClient.release();
      }
    },
  );
});
