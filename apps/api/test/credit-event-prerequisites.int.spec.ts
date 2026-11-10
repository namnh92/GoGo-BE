import { PlaceSubmissionService } from '../../../libs/modules/ingestion/application/place-submission.service';
import { PlaceDedupService } from '../../../libs/modules/ingestion/application/place-dedup.service';
import { SubmissionPhotosService } from '../../../libs/modules/ingestion/application/submission-photos.service';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { schema, type Db } from '@gogo/database';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CmsOpsService } from '../../../libs/modules/cms/application/cms-ops.service';
import { UserContentService } from '../../../libs/modules/reviews/application/user-content.service';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import { IdentityRepository } from '../../../libs/modules/identity/infrastructure/identity.repository';
import type { Tx } from '../../../libs/modules/shared/outbox';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let oldReviewId: string;
let oldPlaceId: string;
const adminId = randomUUID();
const migrations = path.resolve(__dirname, '../../../migrations');
const ops = (file: string) => path.resolve(__dirname, '../../../scripts/ops', file);
const dialect = new PgDialect();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pause after a real SQL statement, keeping its real transaction/locks open. */
function gatedDb(match: (sql: string) => boolean) {
  const reached = deferred();
  const release = deferred();
  let paused = false;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'transaction')
        return (work: (tx: Tx) => Promise<unknown>) =>
          target.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property !== 'execute') return Reflect.get(transaction, property);
                  return async (query: SQL) => {
                    const result = await transaction.execute(query);
                    if (!paused && match(dialect.sqlToQuery(query).sql)) {
                      paused = true;
                      reached.resolve();
                      await release.promise;
                    }
                    return result;
                  };
                },
              }),
            ),
          );
      return Reflect.get(target, key);
    },
  });
  return { db: wrapped, reached: reached.promise, release: release.resolve };
}

function content(connection = db) {
  return new UserContentService(
    connection,
    {} as never,
    {
      enqueue: async () => [],
      attemptNow: async () => undefined,
    } as never,
    null,
  );
}
async function user() {
  const [u] = await db.insert(schema.users).values({ displayName: 'Credit subject' }).returning();
  return u!;
}
async function place() {
  const [p] = await db
    .insert(schema.places)
    .values({
      name: 'Owned place',
      nameNormalized: 'x',
      geom: { x: 106.7, y: 10.77 },
      status: 'published',
    })
    .returning();
  return p!;
}
async function review(userId: string, placeId: string) {
  return content().createReview(
    { type: 'user', id: userId, sessionId: 'test' },
    { placeId, rating: 5 },
  );
}
async function room() {
  const u = await user();
  const [r] = await db
    .insert(schema.rooms)
    .values({
      code: randomUUID(),
      type: 'group',
      decisionMode: 'vote',
      hostUserId: u.id,
      status: 'active',
    })
    .returning();
  const [m] = await db
    .insert(schema.roomMembers)
    .values({ roomId: r!.id, userId: u.id, role: 'host', displayName: 'Host' })
    .returning();
  return { user: u, room: r!, member: m! };
}
const complete = (repo: RoomsRepository, id: string) =>
  repo.updateStatus(id, 'completed', {
    eventType: 'room.status_completed',
    resourceType: 'room',
    resourceId: id,
    payload: {},
  });
async function event(type: string, id: string) {
  const result = await pool.query(
    'select payload, payload_schema_version from outbox_events where event_type=$1 and resource_id=$2 order by occurred_at desc',
    [type, id],
  );
  return result.rows[0] as { payload: Record<string, unknown>; payload_schema_version: number };
}
async function activate() {
  await pool.query(
    "update credit_cutover set mode='evaluator', epoch=epoch+1, first_activated_at=coalesce(first_activated_at,clock_timestamp())",
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  db = drizzle(pool, { schema });
  // A populated 0096 database, not just a fresh-schema forward test.
  const folder = await mkdtemp(path.join(os.tmpdir(), 'credit-s1-'));
  try {
    const journal = JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 97);
    await mkdir(path.join(folder, 'meta'));
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await cp(path.join(migrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: folder });
    const u = (
      await pool.query("insert into users(display_name) values ('Old author') returning id")
    ).rows[0].id;
    oldPlaceId = (
      await pool.query(
        "insert into places(name,name_normalized,geom) values ('Owned','x',ST_SetSRID(ST_MakePoint(106.7,10.77),4326)) returning id",
      )
    ).rows[0].id;
    oldReviewId = (
      await pool.query(
        "insert into reviews(user_id,place_id,rating,status) values ($1,$2,5,'published') returning id",
        [u, oldPlaceId],
      )
    ).rows[0].id;
    await pool.query(
      "insert into assistant_credit_ledger(delta,reason,submission_id,venue_identity) values (70,'submission_approved',gen_random_uuid(),'google:s1-legacy')",
    );
    await migrate(db, { migrationsFolder: migrations });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  // Tests use isolated lifecycle scenarios. Production never resets this boundary.
  await pool.query("update credit_cutover set mode='sync',epoch=0,first_activated_at=null");
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('#829 S1 migration, eligibility and atomic publication', () => {
  it('preserves old history and legacy ledger, with no synthetic eligibility', async () => {
    const result = await pool.query(
      'select credit_epoch,first_published_at from reviews where id=$1',
      [oldReviewId],
    );
    expect(result.rows).toEqual([{ credit_epoch: null, first_published_at: null }]);
    expect(
      (
        await pool.query(
          "select delta from assistant_credit_ledger where venue_identity='google:s1-legacy'",
        )
      ).rows,
    ).toEqual([{ delta: 70 }]);
    await pool.query(await readFile(ops('validate-credit-event-prerequisites.sql'), 'utf8'));
    await expect(
      pool.query('update reviews set credit_epoch=1 where id=$1', [oldReviewId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('never rewards creation before activation; stamps eligible publication only once', async () => {
    const u = await user();
    const p = await place();
    const before = await review(u.id, p.id);
    await activate();
    const cms = new CmsOpsService(db);
    await cms.decideReview(adminId, before.id, 'published', 'checked');
    expect((await event('review.published', before.id)).payload).toMatchObject({
      firstPublication: false,
    });
    const after = await review(u.id, p.id);
    await cms.decideReview(adminId, after.id, 'published', 'checked');
    expect(await event('review.published', after.id)).toMatchObject({
      payload_schema_version: 2,
      payload: { firstPublication: true, grantOwner: 'evaluator', userId: u.id },
    });
    const [stamp] = await db.select().from(schema.reviews).where(eq(schema.reviews.id, after.id));
    await cms.decideReview(adminId, after.id, 'rejected', 'hidden');
    await cms.decideReview(adminId, after.id, 'published', 'checked');
    expect((await event('review.published', after.id)).payload.firstPublication).toBe(false);
    const [again] = await db.select().from(schema.reviews).where(eq(schema.reviews.id, after.id));
    expect(again!.firstPublishedAt).toEqual(stamp!.firstPublishedAt);
    const first = (await pool.query('select first_activated_at from credit_cutover')).rows[0];
    await pool.query("update credit_cutover set mode='sync'");
    const paused = await review(u.id, p.id);
    await cms.decideReview(adminId, paused.id, 'published', 'checked');
    expect((await event('review.published', paused.id)).payload.grantOwner).toBe('none');
    await activate();
    expect((await pool.query('select first_activated_at from credit_cutover')).rows[0]).toEqual(
      first,
    );
  });
  it('activation waits for a creation that already holds FOR SHARE', async () => {
    const u = await user();
    const p = await place();
    const gate = gatedDb((s) => s.includes('from credit_cutover'));
    const creating = content(gate.db).createReview(
      { type: 'user', id: u.id, sessionId: 't' },
      { placeId: p.id, rating: 5 },
    );
    try {
      await gate.reached;
      const activating = activate();
      gate.release();
      const created = await creating;
      await activating;
      const [row] = await db.select().from(schema.reviews).where(eq(schema.reviews.id, created.id));
      expect(row!.creditEpoch).toBeNull();
    } finally {
      gate.release();
      await creating;
    }
  });
  it('creation reading after an in-flight activation commits receives the activated epoch', async () => {
    const u = await user();
    const p = await place();
    const client = await pool.connect();
    let creating: ReturnType<UserContentService['createReview']> | undefined;
    try {
      await client.query('begin');
      await client.query(
        "update credit_cutover set mode='evaluator',epoch=1,first_activated_at=clock_timestamp()",
      );
      creating = review(u.id, p.id);
      await client.query('commit');
      const created = await creating;
      expect(
        (await pool.query('select credit_epoch from reviews where id=$1', [created.id])).rows[0]
          .credit_epoch,
      ).toBe(1);
    } finally {
      await client.query('rollback');
      client.release();
      if (creating) await creating;
    }
  });
  it('rolls status, publication stamp, audit and event back on outbox failure', async () => {
    const u = await user();
    const p = await place();
    const r = await review(u.id, p.id);
    await pool.query(`create function fail_credit_publication() returns trigger language plpgsql as $$
      begin if new.event_type = 'review.published' then raise exception 'publication failpoint'; end if; return new; end; $$;
      create trigger fail_credit_publication before insert on outbox_events for each row execute function fail_credit_publication()`);
    try {
      await expect(
        new CmsOpsService(db).decideReview(adminId, r.id, 'published', 'checked'),
      ).rejects.toThrow();
      expect(
        (await pool.query('select status, first_published_at from reviews where id=$1', [r.id]))
          .rows,
      ).toEqual([{ status: 'pending', first_published_at: null }]);
      expect(
        (await pool.query('select count(*)::int n from audit_logs where resource_id=$1', [r.id]))
          .rows[0].n,
      ).toBe(0);
      expect(await event('review.published', r.id)).toBeUndefined();
    } finally {
      await pool.query(
        'drop trigger fail_credit_publication on outbox_events; drop function fail_credit_publication()',
      );
    }
  });
  it('backfill is bounded and resumable, stamps audit-proven history only, never epochs', async () => {
    const u = await user();
    const p = await place();
    const audited = await review(u.id, p.id);
    const missingAudit = await review(u.id, p.id);
    await pool.query(
      "insert into audit_logs(actor_type,action,resource_type,resource_id,diff) values ('system','review.moderated','review',$1,'{\"decision\":\"published\"}')",
      [audited.id],
    );
    const batch = await readFile(ops('backfill-credit-events.sql'), 'utf8');
    await pool.query(batch);
    await pool.query(batch);
    const a = (
      await pool.query('select credit_epoch,first_published_at from reviews where id=$1', [
        audited.id,
      ])
    ).rows[0];
    expect(a.credit_epoch).toBeNull();
    expect(a.first_published_at).toBeTruthy();
    expect(
      (await pool.query('select first_published_at from reviews where id=$1', [missingAudit.id]))
        .rows[0].first_published_at,
    ).toBeNull();
  });
});

describe('#829 S1 cohort / erasure interleavings', () => {
  it.each(['erase-first', 'approve-first'])(
    '%s serializes approval, legacy grant and recipient scrubbing',
    async (order) => {
      const u = await user();
      const identity = randomUUID();
      const [submission] = await db
        .insert(schema.placeSubmissions)
        .values({ googlePlaceId: identity, submittedByUserId: u.id })
        .returning();
      const providerReached = deferred();
      const releaseProvider = deferred();
      const gate = gatedDb((q) => q.includes('from users'));
      const connection = order === 'approve-first' ? gate.db : db;
      const service = new PlaceSubmissionService(
        connection,
        {
          resolveByProviderId: async (id: string) => {
            providerReached.resolve();
            if (order === 'erase-first') await releaseProvider.promise;
            return {
              status: 'RESOLVED',
              details: {
                providerPlaceId: id,
                name: 'Fixture',
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
              },
            };
          },
          scoreFor: async () => 0.5,
        } as never,
        new PlaceDedupService(connection),
        {} as never,
        {} as never,
        new SubmissionPhotosService(connection, {} as never, {} as never, {} as never),
      );
      const approving = service.decide(adminId, submission!.id, 'approved', 'Checked');
      try {
        if (order === 'erase-first') {
          await providerReached.promise;
          await content().deleteForUser(u.id, { actorType: 'user', actorId: u.id });
          releaseProvider.resolve();
          await approving;
          expect(
            (await event('place.submission_decided', submission!.id)).payload.recipientUserId,
          ).toBeNull();
        } else {
          await gate.reached;
          const erasing = content().deleteForUser(u.id, { actorType: 'user', actorId: u.id });
          gate.release();
          await approving;
          await erasing;
          expect(
            (await event('place.submission_decided', submission!.id)).payload,
          ).not.toHaveProperty('recipientUserId');
        }
      } finally {
        gate.release();
        releaseProvider.resolve();
        await approving;
      }
      const ledger = await pool.query(
        'select delta,user_id from assistant_credit_ledger where submission_id=$1',
        [submission!.id],
      );
      expect(ledger.rows).toEqual(order === 'approve-first' ? [{ delta: 50, user_id: null }] : []);
      expect(
        (await pool.query('select * from assistant_credit_accounts where user_id=$1', [u.id])).rows,
      ).toEqual([]);
    },
  );

  it('erasure scrubs submission recipient fields while preserving facts and unrelated recipients', async () => {
    const u = await user();
    const other = await user();
    const ids: string[] = [];
    for (const type of ['place.submission_decided', 'place.submission_evidence_approved']) {
      const [row] = await db
        .insert(schema.outboxEvents)
        .values({
          eventType: type,
          resourceType: 'place_submission',
          resourceId: randomUUID(),
          payloadSchemaVersion: 2,
          publishedAt: new Date(),
          payload: {
            recipientUserId: u.id,
            decision: 'approved',
            approvedEvidenceCount: 1,
            grantOwner: 'sync',
          },
        })
        .returning();
      ids.push(row!.id);
    }
    const [unrelated] = await db
      .insert(schema.outboxEvents)
      .values({
        eventType: 'place.submission_decided',
        resourceType: 'place_submission',
        resourceId: randomUUID(),
        payload: { recipientUserId: other.id },
      })
      .returning();
    await content().deleteForUser(u.id, { actorType: 'user', actorId: u.id });
    for (const id of ids) {
      const result = (await pool.query('select payload from outbox_events where id=$1', [id]))
        .rows[0].payload;
      expect(result).not.toHaveProperty('recipientUserId');
      expect(result).toMatchObject({
        decision: 'approved',
        approvedEvidenceCount: 1,
        grantOwner: 'sync',
      });
    }
    expect(
      (await pool.query('select payload from outbox_events where id=$1', [unrelated!.id])).rows[0]
        .payload.recipientUserId,
    ).toBe(other.id);
  });

  it.each(['erase-first', 'complete-first'])(
    '%s never leaves a deleted cohort recipient',
    async (order) => {
      const f = await room();
      const repo = new RoomsRepository(db);
      if (order === 'erase-first') {
        await content().deleteForUser(f.user.id, { actorType: 'user', actorId: f.user.id });
        await complete(repo, f.room.id);
      } else {
        const gate = gatedDb((s) => s.includes('as stops_completed'));
        const completing = complete(new RoomsRepository(gate.db), f.room.id);
        try {
          await gate.reached;
          const erasing = content().deleteForUser(f.user.id, {
            actorType: 'user',
            actorId: f.user.id,
          });
          gate.release();
          await completing;
          await erasing;
        } finally {
          gate.release();
          await completing;
        }
      }
      expect((await event('room.completed', f.room.id)).payload.subjects).toEqual([]);
    },
  );
  it.each(['erase-first', 'publish-first'])(
    '%s never resurrects a retained review author',
    async (order) => {
      const u = await user();
      const p = await place();
      const r = await review(u.id, p.id);
      if (order === 'erase-first') {
        await content().deleteForUser(u.id, { actorType: 'user', actorId: u.id });
        await new CmsOpsService(db).decideReview(adminId, r.id, 'published', 'checked');
        expect((await event('review.published', r.id)).payload.userId).toBeNull();
      } else {
        const gate = gatedDb((s) => s.includes('from users'));
        const publishing = new CmsOpsService(gate.db).decideReview(
          adminId,
          r.id,
          'published',
          'checked',
        );
        try {
          await gate.reached;
          const erasing = content().deleteForUser(u.id, { actorType: 'user', actorId: u.id });
          gate.release();
          await publishing;
          await erasing;
        } finally {
          gate.release();
          await publishing;
        }
        expect((await event('review.published', r.id)).payload).not.toHaveProperty('userId');
      }
    },
  );
  it('retries discovery when a guest is claimed before the completion room lock', async () => {
    const f = await room();
    const claimant = await user();
    const [g] = await db
      .insert(schema.guestSessions)
      .values({
        roomId: f.room.id,
        displayName: 'Guest',
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .returning();
    await db
      .insert(schema.roomMembers)
      .values({ roomId: f.room.id, guestSessionId: g!.id, role: 'member', displayName: 'Guest' });
    const gate = gatedDb((s) => s.includes('select distinct user_id'));
    const completing = complete(new RoomsRepository(gate.db), f.room.id);
    try {
      await gate.reached;
      await new IdentityRepository(db).claimGuestSession(g!.id, claimant.id);
      gate.release();
      await completing;
    } finally {
      gate.release();
      await completing;
    }
    expect((await event('room.completed', f.room.id)).payload.subjects).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: claimant.id })]),
    );
    expect(
      (
        await pool.query(
          "select count(*)::int as n from outbox_events where event_type='room.completed' and resource_id=$1",
          [f.room.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('removal before the room lock is excluded; removal after the snapshot does not rewrite it', async () => {
    for (const before of [true, false]) {
      const f = await room();
      const repo = new RoomsRepository(db);
      const removal = () =>
        repo.removeMember({
          memberId: f.member.id,
          removedByMemberId: f.member.id,
          event: {
            eventType: 'member.removed',
            resourceType: 'room',
            resourceId: f.room.id,
            payload: {},
          },
        });
      const gate = gatedDb((s) =>
        s.includes(before ? 'select distinct user_id' : 'as stops_completed'),
      );
      const completing = complete(new RoomsRepository(gate.db), f.room.id);
      try {
        await gate.reached;
        if (before) {
          await removal();
          gate.release();
          await completing;
        } else {
          const removing = removal();
          gate.release();
          await completing;
          await removing;
        }
      } finally {
        gate.release();
        await completing;
      }
      const subjects = (await event('room.completed', f.room.id)).payload.subjects as unknown[];
      expect(subjects).toHaveLength(before ? 0 : 1);
    }
  });
});
