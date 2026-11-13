import { hostedRoom } from './support/hosted-room';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { checkedInGroupCountQuery } from '../../../libs/modules/search/infrastructure/checked-in-group-counts';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let otherApp: NestFastifyApplication;
let userId: string;
let seq = 0;
const api = () => app.getHttpAdapter().getInstance();
const detail = (placeId: string) => api().inject({ method: 'GET', url: `/v1/places/${placeId}` });

async function place(status: 'published' | 'community_submitted' | 'draft' = 'published') {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Check-in place ${++seq}`,
      nameNormalized: 'trigger',
      status,
      geom: { x: 106.7, y: 10.77 },
      confidence: '0.9',
    })
    .returning();
  return row!.id;
}

async function room(type: 'couple' | 'group' = 'group') {
  const [row] = await hostedRoom(db, {
    code: randomUUID(),
    type,
    decisionMode: 'host',
    hostUserId: userId,
    status: 'completed',
    participantCount: 3,
  });
  return row!.id;
}

async function member(roomId: string) {
  const [guest] = await db
    .insert(schema.guestSessions)
    .values({
      roomId,
      displayName: 'Guest',
      tokenHash: randomUUID(),
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    })
    .returning();
  const [row] = await db
    .insert(schema.roomMembers)
    .values({
      roomId,
      guestSessionId: guest!.id,
      role: 'member',
      displayName: 'Guest',
    })
    .returning();
  return row!;
}

async function stop(placeId: string, roomId: string, version = 1, checkedIn = true) {
  const [plan] = await db
    .insert(schema.plans)
    .values({
      roomId,
      version,
      totals: {
        costMin: 0,
        costMax: 0,
        currency: 'VND',
        durationMinutes: 60,
        travelDistanceM: 0,
        overBudget: false,
        uncertain: false,
      },
      constraintVersion: 1,
      status: 'archived',
    })
    .returning();
  const [s] = await db
    .insert(schema.planStops)
    .values({
      planId: plan!.id,
      placeId,
      position: 0,
      durationMinutes: 60,
      status: 'completed',
      completedAt: new Date('2020-01-01T00:00:00Z'),
    })
    .returning();
  const m = await member(roomId);
  if (checkedIn)
    await db.insert(schema.stopCheckins).values({
      planStopId: s!.id,
      memberId: m.id,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
  return { stopId: s!.id, memberId: m.id };
}

async function visits(placeId: string, n: number) {
  for (let i = 0; i < n; i++) await stop(placeId, await room(i % 2 ? 'couple' : 'group'));
}

async function expectConsistentCounts() {
  // Independent source-of-truth oracle, deliberately expensive and never on reads.
  const mismatch = await pool.query(`
    with expected as (
      select s.place_id, count(distinct p.room_id)::int as group_count
      from stop_checkins c join plan_stops s on s.id = c.plan_stop_id
      join plans p on p.id = s.plan_id group by s.place_id
    )
    select * from expected e full join place_checkin_counts a using (place_id)
    where coalesce(e.group_count, 0) <> coalesce(a.group_count, 0)
  `);
  expect(mismatch.rows).toEqual([]);
  const rooms = await pool.query(`
    with expected as (
      select s.place_id, p.room_id, count(*)::int as checkin_count
      from stop_checkins c join plan_stops s on s.id = c.plan_stop_id
      join plans p on p.id = s.plan_id group by s.place_id, p.room_id
    )
    select * from expected e full join place_checkin_rooms a using (place_id, room_id)
    where e.checkin_count is distinct from a.checkin_count
  `);
  expect(rooms.rows).toEqual([]);
  const associations = await pool.query(`
    select c.id from stop_checkins c join plan_stops s on s.id = c.plan_stop_id
    join plans p on p.id = s.plan_id
    full join place_checkin_visits v on v.checkin_id = c.id
    where c.id is null or v.checkin_id is null
       or v.place_id <> s.place_id or v.room_id <> p.room_id
  `);
  expect(associations.rows).toEqual([]);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_checkin_count_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  const [user] = await db.insert(schema.users).values({ displayName: 'Visitor' }).returning();
  userId = user!.id;
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  // Separate DI graph, DB pool and repository, as in another API process.
  otherApp = await createApp();
  await otherApp.init();
  await otherApp.getHttpAdapter().getInstance().ready();
}, 600_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await otherApp?.close();
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('PlaceDetail checked-in group count (#785)', () => {
  it.each([0, 1, 4, 5, 7])('counts %i distinct rooms, suppressing below five', async (n) => {
    const id = await place();
    await visits(id, n);
    const response = await detail(id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().checkedInGroupCount).toBe(n < 5 ? null : n);
    expect(response.json()).not.toHaveProperty('roomIds');
    expect(response.json()).not.toHaveProperty('memberIds');
  });

  it('deduplicates members, repeated check-ins and archived plan versions in the same room', async () => {
    const id = await place();
    await visits(id, 4);
    const r = await room();
    const { stopId, memberId } = await stop(id, r);
    const other = await member(r);
    await db.insert(schema.stopCheckins).values({ planStopId: stopId, memberId: other.id });
    await db
      .insert(schema.stopCheckins)
      .values({ planStopId: stopId, memberId })
      .onConflictDoUpdate({
        target: [schema.stopCheckins.planStopId, schema.stopCheckins.memberId],
        set: { note: 'Edited check-in' },
      });
    await stop(id, r, 2);
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
  });

  it('excludes rooms without check-ins, completed stops alone and visits at another place', async () => {
    const id = await place();
    await visits(id, 4);
    for (let n = 0; n < 6; n++) await stop(id, await room(), 1, false);
    await visits(await place(), 6);
    await db.insert(schema.reviews).values({ userId, placeId: id, rating: 5, status: 'published' });
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
  });

  it('counts visit records independently of content moderation, including textless check-ins', async () => {
    const id = await place();
    for (const moderation of ['pending', 'approved', 'rejected', 'hidden', 'pending']) {
      const { stopId } = await stop(id, await room());
      await db
        .update(schema.planStops)
        .set({ status: 'planned', completedAt: null })
        .where(eq(schema.planStops.id, stopId));
      await db
        .update(schema.stopCheckins)
        .set({ moderation })
        .where(eq(schema.stopCheckins.planStopId, stopId));
    }
    const body = (await detail(id)).json();
    expect(body.checkedInGroupCount).toBe(5);
    expect(body.gogoRatingCount).toBe(0);
  });

  it('reflects a new room and check-in deletion immediately', async () => {
    const id = await place();
    await visits(id, 4);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
    const fifth = await stop(id, await room());
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
    await db.delete(schema.stopCheckins).where(eq(schema.stopCheckins.planStopId, fifth.stopId));
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
  });

  it.each([
    'check-in deletion',
    'room cascade',
    'member erasure',
    'user erasure',
    'plan cascade',
    'stop cascade',
    'place merge',
  ] as const)(
    'F-01: suppresses 5→4 immediately across API instances after %s commits',
    async (mutation) => {
      const id = await place();
      const canonical = await place();
      await visits(id, 4);
      const fifthRoom = await room();
      const fifth = await stop(id, fifthRoom);
      const otherDetail = () =>
        otherApp
          .getHttpAdapter()
          .getInstance()
          .inject({ method: 'GET', url: `/v1/places/${id}` });
      // Freeze time so neither instance can rely on expiry for correctness.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      expect((await detail(id)).json().checkedInGroupCount).toBe(5);
      expect((await otherDetail()).json().checkedInGroupCount).toBe(5);

      // Writes commit through the fixture's pool, independently of either API.
      await db.transaction(async (tx) => {
        if (mutation === 'check-in deletion') {
          await tx
            .delete(schema.stopCheckins)
            .where(eq(schema.stopCheckins.planStopId, fifth.stopId));
        } else if (mutation === 'room cascade') {
          await tx.delete(schema.rooms).where(eq(schema.rooms.id, fifthRoom));
        } else if (mutation === 'member erasure') {
          await tx.delete(schema.roomMembers).where(eq(schema.roomMembers.id, fifth.memberId));
        } else if (mutation === 'user erasure') {
          const [erased] = await tx
            .insert(schema.users)
            .values({ displayName: 'Erased' })
            .returning();
          await tx
            .update(schema.roomMembers)
            .set({ guestSessionId: null, userId: erased!.id })
            .where(eq(schema.roomMembers.id, fifth.memberId));
          await tx.delete(schema.users).where(eq(schema.users.id, erased!.id));
        } else if (mutation === 'plan cascade') {
          await tx.execute(sql`delete from plans where id = (
            select plan_id from plan_stops where id = ${fifth.stopId})`);
        } else if (mutation === 'stop cascade') {
          await tx.delete(schema.planStops).where(eq(schema.planStops.id, fifth.stopId));
        } else {
          await tx
            .update(schema.planStops)
            .set({ placeId: canonical })
            .where(eq(schema.planStops.id, fifth.stopId));
        }
      });
      expect((await detail(id)).json().checkedInGroupCount).toBeNull();
      expect((await otherDetail()).json().checkedInGroupCount).toBeNull();
      await expectConsistentCounts();
    },
  );

  it('answers community places and retains existing 404 behavior', async () => {
    expect(
      (await detail(await place('community_submitted'))).json().checkedInGroupCount,
    ).toBeNull();
    expect((await detail(await place('draft'))).statusCode).toBe(404);
    expect((await detail(randomUUID())).statusCode).toBe(404);
  });

  it('deduplicates overlapping rooms when place references are merged', async () => {
    const canonical = await place();
    const duplicate = await place();
    await visits(canonical, 3);
    await visits(duplicate, 2);
    const overlap = await room();
    await stop(canonical, overlap, 1);
    await stop(duplicate, overlap, 2);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await detail(canonical)).json().checkedInGroupCount).toBeNull();
    // The place merge's existing reference move; no counter-specific write.
    await db
      .update(schema.planStops)
      .set({ placeId: canonical })
      .where(eq(schema.planStops.placeId, duplicate));
    expect((await detail(canonical)).json().checkedInGroupCount).toBe(6);
    expect((await detail(duplicate)).json().checkedInGroupCount).toBeNull();
  });

  it('fails a previously successful request on a database error rather than returning a fabricated zero/null', async () => {
    const id = await place();
    await visits(id, 5);
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
    await db.execute(
      sql`alter table place_checkin_counts rename to place_checkin_counts_unavailable`,
    );
    try {
      const response = await detail(id);
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.body).not.toContain('checkedInGroupCount');
    } finally {
      await db.execute(
        sql`alter table place_checkin_counts_unavailable rename to place_checkin_counts`,
      );
    }
    expect((await detail(id)).statusCode).toBe(200);
  });

  it('F-02: repeated reads touch one indexed aggregate row with 40,000 matching check-ins', async () => {
    const target = await place();
    await visits(target, 5);
    const r = await room();
    const { stopId, memberId } = await stop(target, r);
    // Grow the history AT the queried place, not just unrelated places.
    await db.execute(sql`
      with stops as (
        insert into plan_stops (plan_id, place_id, position, duration_minutes)
        select plan_id, ${target}, n, 60
        from plan_stops, generate_series(1, 40000) n where id = ${stopId}
        returning id
      )
      insert into stop_checkins (plan_stop_id, member_id)
      select id, ${memberId} from stops
    `);
    // Make the aggregate itself large enough for a meaningful index choice.
    await pool.query(`with added as (
      insert into places(name, name_normalized, geom)
      select 'Empty fixture', 'empty fixture', ST_SetSRID(ST_MakePoint(106.7, 10.77),4326)
      from generate_series(1, 10000) returning id
    ) insert into place_checkin_counts(place_id, group_count) select id, 0 from added`);
    await db.execute(sql`analyze place_checkin_counts`);
    for (let i = 0; i < 5; i++) {
      const result = await db.execute(
        sql`explain (analyze, buffers, format json) ${checkedInGroupCountQuery(target)}`,
      );
      const plan = (result.rows[0] as { 'QUERY PLAN': { Plan: Record<string, unknown> }[] })[
        'QUERY PLAN'
      ][0]!.Plan;
      const text = JSON.stringify(plan);
      expect(text).toContain('place_checkin_counts_pkey');
      expect(text).not.toMatch(/plan_stops|stop_checkins|place_checkin_visits|place_checkin_rooms/);
      expect((plan['Plans'] as Record<string, unknown>[])[0]?.['Actual Rows']).toBe(1);
      expect(
        Number(plan['Shared Hit Blocks']) + Number(plan['Shared Read Blocks']),
      ).toBeLessThanOrEqual(4);
      expect((await db.execute(checkedInGroupCountQuery(target))).rows).toEqual([
        { group_count: 6 },
      ]);
    }
    expect((await detail(target)).json().checkedInGroupCount).toBe(6);
    await expectConsistentCounts();
  });

  it('keeps a room until its last member/stop/version check-in disappears', async () => {
    const id = await place();
    await visits(id, 4);
    const r = await room();
    const first = await stop(id, r);
    const second = await stop(id, r, 2);
    const extra = await member(r);
    await db.insert(schema.stopCheckins).values({ planStopId: first.stopId, memberId: extra.id });
    await db.delete(schema.roomMembers).where(eq(schema.roomMembers.id, first.memberId));
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
    await db.delete(schema.planStops).where(eq(schema.planStops.id, first.stopId));
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
    await db.delete(schema.planStops).where(eq(schema.planStops.id, second.stopId));
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
    await expectConsistentCounts();
  });

  it('moves check-in/stop/plan associations and rolls aggregate changes back with the writer', async () => {
    const source = await place();
    const destination = await place();
    await visits(source, 4);
    const fifth = await stop(source, await room());
    const destinationRoom = await room();
    const to = await stop(destination, destinationRoom, 3, false);
    await db
      .update(schema.stopCheckins)
      .set({ planStopId: to.stopId })
      .where(eq(schema.stopCheckins.planStopId, fifth.stopId));
    expect((await detail(source)).json().checkedInGroupCount).toBeNull();
    await expectConsistentCounts();
    // Reparent an entire stop, then a plan; merge into an already-counted room.
    await db.execute(sql`update plan_stops set plan_id = (
      select plan_id from plan_stops where id = ${fifth.stopId}
    ), position = 1 where id = ${to.stopId}`);
    await expectConsistentCounts();
    await db.execute(sql`update plans set room_id = ${destinationRoom} where id = (
      select plan_id from plan_stops where id = ${fifth.stopId})`);
    await expectConsistentCounts();
    await expect(
      db.transaction(async (tx) => {
        await tx.delete(schema.stopCheckins).where(eq(schema.stopCheckins.planStopId, to.stopId));
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    await expectConsistentCounts();
  });

  it('serializes concurrent first/last references without losing increments or retaining erased rooms', async () => {
    const id = await place();
    await visits(id, 4);
    const r = await room();
    const a = await stop(id, r, 1, false);
    const b = await stop(id, r, 2, false);
    await Promise.all(
      [a, b].map(({ stopId, memberId }) =>
        db.insert(schema.stopCheckins).values({ planStopId: stopId, memberId }),
      ),
    );
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
    await Promise.all(
      [a, b].map(({ stopId }) =>
        db.delete(schema.stopCheckins).where(eq(schema.stopCheckins.planStopId, stopId)),
      ),
    );
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
    // Distinct rooms contend on the same total row.
    const c = await stop(id, await room(), 1, false);
    const d = await stop(id, await room(), 1, false);
    await Promise.all(
      [c, d].map(({ stopId, memberId }) =>
        db.insert(schema.stopCheckins).values({ planStopId: stopId, memberId }),
      ),
    );
    expect((await detail(id)).json().checkedInGroupCount).toBe(6);
    await expectConsistentCounts();
  });

  it('does not remap a concurrently reparented check-in through a stale parent snapshot', async () => {
    const a = await stop(await place(), await room());
    const b = await stop(await place(), await room(), 2, false);
    const movedRoom = await room();
    const writer = await pool.connect();
    const parentWriter = await pool.connect();
    const observer = await pool.connect();
    let parentMove: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE stop_checkins SET plan_stop_id=$1 WHERE plan_stop_id=$2', [
        b.stopId,
        a.stopId,
      ]);
      const pid = (await parentWriter.query('select pg_backend_pid() as pid')).rows[0].pid;
      // This statement sees the old source association, then waits for its row.
      parentMove = parentWriter.query(
        `update plans set room_id=$1 where id=(
        select plan_id from plan_stops where id=$2)`,
        [movedRoom, a.stopId],
      );
      // Observe the lock instead of relying on a timing delay.
      await vi.waitFor(
        async () => {
          const state = await observer.query(
            'select wait_event_type from pg_stat_activity where pid=$1',
            [pid],
          );
          expect(state.rows[0]?.wait_event_type).toBe('Lock');
        },
        { timeout: 5000, interval: 10 },
      );
      await writer.query('COMMIT');
      await parentMove;
    } finally {
      try {
        await writer.query('ROLLBACK');
        await parentMove;
      } finally {
        writer.release();
        parentWriter.release();
        observer.release();
      }
    }
    await expectConsistentCounts();
  });

  it('keeps reads committed until the deleting transaction commits, across independent connections', async () => {
    const id = await place();
    await visits(id, 4);
    const fifth = await stop(id, await room());
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('delete from stop_checkins where plan_stop_id=$1', [fifth.stopId]);
      expect((await db.execute(checkedInGroupCountQuery(id))).rows).toEqual([{ group_count: 5 }]);
      await writer.query('COMMIT');
      expect((await detail(id)).json().checkedInGroupCount).toBeNull();
      expect(
        (
          await otherApp
            .getHttpAdapter()
            .getInstance()
            .inject({ method: 'GET', url: `/v1/places/${id}` })
        ).json().checkedInGroupCount,
      ).toBeNull();
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
    await expectConsistentCounts();
  });

  it('clears derived identities and totals for transactional truncate cascades', async () => {
    // Roll back so the rest of this suite retains its source fixtures.
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('TRUNCATE stop_checkins CASCADE');
      for (const table of ['place_checkin_visits', 'place_checkin_rooms', 'place_checkin_counts']) {
        expect((await writer.query(`select count(*)::int as n from ${table}`)).rows).toEqual([
          { n: 0 },
        ]);
      }
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
    await expectConsistentCounts();
  });

  it('forward-tests existing history, rollback and reapplication without altering source visits', async () => {
    const root = path.resolve(__dirname, '../../..');
    const rollback = readFileSync(
      path.join(root, 'scripts/rollback-0082-place-checkin-counts.sql'),
      'utf8',
    );
    const forward = readFileSync(
      path.join(root, 'migrations/0082_place-checkin-counts.sql'),
      'utf8',
    );
    const reapply = async () => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(forward);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    };
    const before = (await pool.query('select count(*)::int as n from stop_checkins')).rows;
    await pool.query(rollback);
    try {
      expect((await pool.query('select count(*)::int as n from stop_checkins')).rows).toEqual(
        before,
      );
      // The prior application query still works while the aggregate is absent.
      await pool.query(`select count(distinct p.room_id) from plan_stops s
        join plans p on p.id=s.plan_id where exists (
          select 1 from stop_checkins c where c.plan_stop_id=s.id)`);
      const id = await place();
      await visits(id, 5);
    } finally {
      await reapply();
    }
    await expectConsistentCounts();
  });
});
