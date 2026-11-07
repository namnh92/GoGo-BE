import { SubmissionPhotosService } from '../../../libs/modules/ingestion/application/submission-photos.service';
import { PlaceSubmissionService } from '../../../libs/modules/ingestion/application/place-submission.service';
import { PlaceDedupService } from '../../../libs/modules/ingestion/application/place-dedup.service';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type Db } from '@gogo/database';
import {
  SearchRepository,
  DEFAULT_WEIGHTS,
  type SearchFilters,
} from '../../../libs/modules/search/infrastructure/search.repository';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import {
  creditBalance,
  grantSubmissionCredits,
  lockAssistantAccount,
  spendAssistantCredit,
} from '../../../libs/modules/shared/assistant-credits';
import {
  readVenueVerification,
  setVenueVerification,
} from '../../../libs/modules/shared/venue-verification';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { AssistantAvailabilityService } from '../../../libs/modules/assistant/application/assistant-availability.service';

// CI only: real PostGIS, migrations, statement snapshots and transaction locks.
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let userId: string;
let adminId: string;
let placeA: string;
let placeB: string;
let repo: SearchRepository;
const now = new Date('2026-11-06T12:00:00Z');
const filter = (extra: Partial<SearchFilters> = {}): SearchFilters => ({
  q: 'discovery774',
  sort: 'curated',
  limit: 1,
  scoredAt: now,
  includeTotal: true,
  ...extra,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  // Fresh migration must seed production labels, including English, before any demo seed.
  const labels = await db.execute(
    sql`select l.locale from taxonomies t join taxonomy_labels l on l.taxonomy_id=t.id where t.kind='amenity' and t.key='wifi'`,
  );
  expect(labels.rows).toHaveLength(2);
  const [user] = await db.insert(schema.users).values({ displayName: 'Contributor' }).returning();
  userId = user!.id;
  adminId = randomUUID();
  const places = await db
    .insert(schema.places)
    .values([
      {
        name: 'discovery774 A',
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
        curatedRank: 1,
        rating: '4.50',
        suitability: { couple: 0.5, work_reading: 0.1 },
      },
      {
        name: 'discovery774 B',
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.71, y: 10.78 },
        curatedRank: 2,
        rating: '3.00',
        suitability: { group: 0.8, work_reading: 0.9 },
      },
    ])
    .returning();
  placeA = places[0]!.id;
  placeB = places[1]!.id;
  const tags = await db.select().from(schema.taxonomies);
  const addTags = async (placeId: string, keys: string[]) =>
    db.insert(schema.placeTaxonomies).values(
      keys.map((key) => ({
        placeId,
        taxonomyId: tags.find((t) => t.kind === 'amenity' && t.key === key)!.id,
      })),
    );
  await addTags(placeA, ['wifi', 'power_outlets', 'card_payment']);
  await addTags(placeB, ['wifi', 'qr_payment']);
  await db.insert(schema.placePrices).values([
    {
      placeId: placeA,
      priceMin: 100,
      priceMax: 200,
      unit: 'per_person',
      verifiedAt: new Date('2026-01-01'),
    },
    {
      placeId: placeA,
      priceMin: 500,
      priceMax: 600,
      unit: 'per_person',
      verifiedAt: new Date('2026-02-01'),
    },
    { placeId: placeB, priceMin: 200, priceMax: 300, unit: 'per_person' },
  ]);
  repo = new SearchRepository(db, {
    PROVENANCE_UNIFIED_READS: true,
    SEARCH_COUNT_TIMEOUT_MS: 10000,
  });
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('#774 exact count and filter eligibility', () => {
  it('count stays before cursor/limit, including an empty page and zero matches', async () => {
    const first = await repo.search(filter(), DEFAULT_WEIGHTS);
    expect(first.totalCount).toBe(2);
    expect(first).toHaveLength(2); // repository fetches limit+1
    const last = first[1]!;
    const empty = await repo.search(
      filter({ cursor: { v: last.sort_value, id: last.id } }),
      DEFAULT_WEIGHTS,
    );
    expect(empty).toHaveLength(0);
    expect(empty.totalCount).toBe(2);
    const zero = await repo.search(filter({ q: 'no774matchesxyz' }), DEFAULT_WEIGHTS);
    expect(zero.totalCount).toBe(0);
    expect(zero).toHaveLength(0);
  });
  it('shares latest-price, rating and geographic eligibility with the counted page', async () => {
    const cheap = await repo.search(filter({ priceMaxPerPerson: 350 }), DEFAULT_WEIGHTS);
    expect(cheap.map((r) => r.id)).toEqual([placeB]);
    expect(cheap.totalCount).toBe(1);
    const rated = await repo.search(filter({ minRating: 4 }), DEFAULT_WEIGHTS);
    expect(rated.map((r) => r.id)).toEqual([placeA]);
    expect(rated.totalCount).toBe(1);
    const geo = await repo.search(
      filter({ lat: 10.77, lng: 106.7, radiusM: 100 }),
      DEFAULT_WEIGHTS,
    );
    expect(geo.map((r) => r.id)).toEqual([placeA]);
    expect(geo.totalCount).toBe(1);
  });
  it('ALL amenities, payment expansion, OR suitability and AND between dimensions', async () => {
    const all = await repo.search(
      filter({
        amenities: ['wifi', 'wifi', 'power_outlets', 'cashless_payment'],
        suitedFor: ['couple', 'work_reading'],
      }),
      DEFAULT_WEIGHTS,
    );
    expect(all.map((r) => r.id)).toEqual([placeA]);
    expect(all.totalCount).toBe(1);
    const either = await repo.search(
      filter({ amenities: ['cashless_payment'], suitedFor: ['couple', 'work_reading'] }),
      DEFAULT_WEIGHTS,
    );
    expect(either.totalCount).toBe(2);
    const unknown = await repo.search(filter({ amenities: ['pets_allowed'] }), DEFAULT_WEIGHTS);
    expect(unknown.totalCount).toBe(0);
  });
  it('count/page use one snapshot while a concurrent catalogue write is uncommitted', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("update places set status='draft' where id=$1", [placeA]);
      const rows = await repo.search(filter(), DEFAULT_WEIGHTS);
      expect(rows.totalCount).toBe(rows.length);
      expect(rows.totalCount).toBe(2);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('#774 credits serialize grants and spend', () => {
  it('one grant per submission and venue; concurrent duplicate approvals cannot inflate balance', async () => {
    const submissionId = randomUUID();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        db.transaction((tx) =>
          grantSubmissionCredits(tx, userId, submissionId, 'google:774credits'),
        ),
      ),
    );
    await db.transaction((tx) =>
      grantSubmissionCredits(tx, userId, randomUUID(), 'google:774credits'),
    );
    expect(await creditBalance(db, userId)).toBe(50);
    const ledger = await db.execute(
      sql`select count(*)::int as n from assistant_credit_ledger where user_id=${userId}`,
    );
    expect(ledger.rows[0]).toEqual({ n: 1 });
  });
  it('funding is daily-first; credit-funded usage does not consume daily allowance', async () => {
    const assistantRepo = new AssistantRepository(db);
    const availability = new AssistantAvailabilityService(db, {} as never, assistantRepo);
    const limits = { dailyMessageLimit: 1, messagesPerMinuteLimit: 100 };
    await db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      expect(await availability.requireAllowance(tx, userId, limits, now)).toBe('daily');
      await tx.execute(
        sql`insert into assistant_usage_ledger(user_id,allowance_source,accepted_at) values (${userId},'credit',${now.toISOString()}::timestamptz)`,
      );
      expect(await availability.requireAllowance(tx, userId, limits, now)).toBe('daily');
      await tx.execute(
        sql`insert into assistant_usage_ledger(user_id,allowance_source,accepted_at) values (${userId},'daily',${now.toISOString()}::timestamptz)`,
      );
      expect(await availability.requireAllowance(tx, userId, limits, now)).toBe('credit');
    });
  });
  it('exactly 50 concurrent locked spends succeed; replay costs zero; rollback restores ledger and balance', async () => {
    const replayId = randomUUID();
    await db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      await spendAssistantCredit(tx, userId, replayId);
      await spendAssistantCredit(tx, userId, replayId);
    });
    expect(await creditBalance(db, userId)).toBe(49);
    await expect(
      db.transaction(async (tx) => {
        await lockAssistantAccount(tx, userId);
        await spendAssistantCredit(tx, userId, randomUUID());
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await creditBalance(db, userId)).toBe(49);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        db.transaction(async (tx) => {
          await lockAssistantAccount(tx, userId);
          await spendAssistantCredit(tx, userId, randomUUID());
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(49);
    expect(await creditBalance(db, userId)).toBe(0);
  });
});

describe('#774 verification lifecycle', () => {
  it('evidence-bound decision, replay, repeat timestamp, stale ETag and automatic revocation', async () => {
    const scope = () => ({
      storedKey: randomUUID(),
      actorScope: `admin:${adminId}`,
      endpoint: 'PUT /v1/cms/places/:id/verification',
      requestHash: '774',
    });
    const initial = await readVenueVerification(db, placeA);
    expect(initial.status).toBe('unverified');
    const input = {
      status: 'verified' as const,
      evidenceType: 'site_visit' as const,
      evidenceReference: 'approved-evidence:774',
      reason: 'Identity and location independently checked',
    };
    const key = scope();
    const verified = await setVenueVerification(db, adminId, placeA, initial.etag, input, key);
    expect(await setVenueVerification(db, adminId, placeA, initial.etag, input, key)).toEqual(
      verified,
    );
    const repeat = await setVenueVerification(db, adminId, placeA, verified.etag, input, scope());
    expect(repeat.verifiedAt).toBe(verified.verifiedAt);
    await expect(
      setVenueVerification(db, adminId, placeA, initial.etag, input, scope()),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await db
      .update(schema.places)
      .set({ name: 'discovery774 renamed' })
      .where(eq(schema.places.id, placeA));
    const revoked = await readVenueVerification(db, placeA);
    expect(revoked.status).toBe('unverified');
    expect(revoked.identityRevision).toBe(initial.identityRevision + 1);
    const page = await repo.search(filter(), DEFAULT_WEIGHTS);
    expect(page.find((row) => row.id === placeA)!.verification).toEqual({ status: 'unverified' });
    expect(JSON.stringify(page)).not.toContain('approved-evidence');
    const again = await setVenueVerification(db, adminId, placeA, revoked.etag, input, scope());
    const laterFacts = await repo.factsFor([placeA], 'en');
    expect(laterFacts[0]).not.toHaveProperty('verification');
    expect(page.find((row) => row.id === placeA)!.verification).toEqual({ status: 'unverified' });
    const newPage = await repo.search(filter(), DEFAULT_WEIGHTS);
    expect(newPage.find((row) => row.id === placeA)!.verification).toMatchObject({
      status: 'verified',
    });
    await db
      .update(schema.places)
      .set({ geom: { x: 107, y: 11 } })
      .where(eq(schema.places.id, placeA));
    expect((await readVenueVerification(db, placeA)).status).toBe('unverified');
    expect(again.status).toBe('verified');
  });
});

describe('#774 Home selects across all memberships before limit', () => {
  it('active proximity beats activity, expired ends excluded, upcoming ordered and removed membership excluded', async () => {
    const add = async (
      status: 'active' | 'ready',
      startAt: Date | null,
      endAt: Date | null,
      removed = false,
    ) => {
      const [room] = await db
        .insert(schema.rooms)
        .values({
          code: randomUUID().slice(0, 10),
          hostUserId: userId,
          type: 'group',
          decisionMode: 'vote',
          participantCount: 3,
          status,
        })
        .returning();
      await db.insert(schema.roomMembers).values({
        roomId: room!.id,
        userId,
        role: 'host',
        displayName: 'Host',
        ...(removed ? { removedAt: now } : {}),
      });
      await db.insert(schema.roomConstraints).values({
        roomId: room!.id,
        version: 1,
        startAt,
        endAt,
        budgetMode: 'total',
        budgetAmount: 100,
        currency: 'VND',
      });
      return room!.id;
    };
    await add('active', new Date(now.getTime() - 3600000), new Date(now.getTime() - 1));
    await add('active', null, null);
    await add('active', new Date(now.getTime() - 600000), null);
    const nearest = await add('active', new Date(now.getTime() + 60000), null);
    await add('active', now, null, true);
    const upcoming = await add('ready', new Date(now.getTime() + 1000), null);
    const rooms = new RoomsRepository(db);
    const selected = await rooms.listRoomsForActor({
      actorType: 'user',
      actorId: userId,
      limit: 1,
      homeAt: now,
    });
    expect(selected.map((r) => r.id)).toEqual([nearest]);
    await db.execute(sql`update rooms set status='completed' where status='active'`);
    expect(
      (
        await rooms.listRoomsForActor({ actorType: 'user', actorId: userId, limit: 1, homeAt: now })
      ).map((r) => r.id),
    ).toEqual([upcoming]);
    expect(
      await rooms.listRoomsForActor({
        actorType: 'user',
        actorId: randomUUID(),
        limit: 1,
        homeAt: now,
      }),
    ).toEqual([]);
  });
});

describe('#774 approval commits its decision, draft, source and award atomically', () => {
  const details = (providerPlaceId: string) => ({
    providerPlaceId,
    name: 'Contributor draft',
    lat: 10.7,
    lng: 106.7,
    rating: null,
    ratingCount: 0,
    priceLevel: null,
    hours: [],
    businessStatus: 'OPERATIONAL',
    fetchTier: 'quality',
    primaryType: 'cafe',
    attribution: 'Google',
    googleMapsUri: null,
  });
  const service = (resolve: (id: string) => Promise<unknown>) =>
    new PlaceSubmissionService(
      db,
      { resolveByProviderId: resolve, scoreFor: async () => 0.5 } as never,
      new PlaceDedupService(db),
      {} as never,
      {} as never,
      new SubmissionPhotosService(db, {} as never, {} as never, {} as never),
    );

  it('concurrent decisions cannot create two drafts or two awards', async () => {
    const [contributor] = await db
      .insert(schema.users)
      .values({ displayName: 'Approval contributor' })
      .returning();
    const identity = '774-approved-once';
    const [submission] = await db
      .insert(schema.placeSubmissions)
      .values({ googlePlaceId: identity, submittedByUserId: contributor!.id })
      .returning();
    const svc = service(async (id) => ({ status: 'RESOLVED', details: details(id) }));
    const decisions = await Promise.allSettled([
      svc.decide(adminId, submission!.id, 'approved', 'Checked'),
      svc.decide(adminId, submission!.id, 'approved', 'Checked'),
    ]);
    expect(decisions.filter((d) => d.status === 'fulfilled')).toHaveLength(1);
    expect(await creditBalance(db, contributor!.id)).toBe(50);
    const sources = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, identity));
    expect(sources).toHaveLength(1);
    const [decided] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submission!.id));
    expect(decided!.status).toBe('approved');
    expect(decided!.resultPlaceId).toBe(sources[0]!.placeId);
  });

  it('a reviewer edit during provider preparation invalidates the prepared draft', async () => {
    const identity = '774-prepared-version';
    const [submission] = await db
      .insert(schema.placeSubmissions)
      .values({ googlePlaceId: identity, submittedByUserId: userId })
      .returning();
    const svc = service(async (id) => {
      await db
        .update(schema.placeSubmissions)
        .set({ reviewDraft: { description: 'New editorial draft' } })
        .where(eq(schema.placeSubmissions.id, submission!.id));
      return { status: 'RESOLVED', details: details(id) };
    });
    await expect(svc.decide(adminId, submission!.id, 'approved', 'Checked')).rejects.toMatchObject({
      code: 'SUBMISSION_CHANGED',
    });
    const [stillPending] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submission!.id));
    expect(stillPending!.status).toBe('pending');
    expect(stillPending!.resultPlaceId).toBeNull();
    expect(
      await db
        .select()
        .from(schema.placeProviderSources)
        .where(eq(schema.placeProviderSources.externalId, identity)),
    ).toEqual([]);
  });
});
