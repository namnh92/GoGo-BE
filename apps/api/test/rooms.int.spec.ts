import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { JOINABLE_ROOM_STATUSES } from '../../../libs/modules/rooms/domain/invite-join';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';

/**
 * BE-BFF-003/004/005 + BE-BFF-015 acceptance: lifecycle, host/member/guest
 * permission matrix (SRS §15.7), constraint staleness, invites, preferences.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let placeIds: string[] = [];

function api() {
  return app.getHttpAdapter().getInstance();
}

let ipCounter = 0;
const ip = () => `10.9.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function registerUser(email: string, displayName = 'User') {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName },
  });
  const body = res.json();
  return { token: body.accessToken as string, userId: body.userId as string };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const baseConstraint = {
  budgetMode: 'per_person',
  budgetAmount: 300_000,
  currency: 'VND',
  radiusM: 5000,
  areaKey: 'hcm_q1',
};

async function createGroupRoom(token: string, participantCount = 4) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/rooms',
    remoteAddress: ip(),
    headers: auth(token),
    payload: {
      type: 'group',
      decisionMode: 'vote',
      participantCount,
      constraint: baseConstraint,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_rooms_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  // Minimal taxonomy + published places for seeds/preferences.
  const [mood] = await db
    .insert(schema.taxonomies)
    .values({ kind: 'mood', key: 'chill' })
    .returning();
  await db.insert(schema.taxonomies).values({ kind: 'category', key: 'cafe' });
  void mood;
  const inserted = await db
    .insert(schema.places)
    .values([
      { name: 'Seed A', nameNormalized: 'x', geom: { x: 106.7, y: 10.77 }, status: 'published' },
      { name: 'Seed B', nameNormalized: 'x', geom: { x: 106.71, y: 10.78 }, status: 'published' },
      { name: 'Draft C', nameNormalized: 'x', geom: { x: 106.72, y: 10.79 }, status: 'draft' },
    ])
    .returning({ id: schema.places.id });
  placeIds = inserted.map((r) => r.id);

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('room lifecycle (BE-BFF-003)', () => {
  it('creates a group room with constraint v1 and host membership', async () => {
    const { token } = await registerUser('host1@gogo.id.vn', 'Chủ Kèo');
    const room = await createGroupRoom(token);
    expect(room.type).toBe('group');
    // #155: a room exists to be joined, so it starts open to joining rather
    // than in a `draft` state nothing moved it out of.
    expect(room.status).toBe('collecting');
    expect(room.constraintVersion).toBe(1);
    expect(room.myRole).toBe('host');
    expect(room.code).toBeTruthy(); // host sees the share code
    expect(room.constraints.budgetMode).toBe('per_person');
    expect(room.members).toHaveLength(1);
  });

  /**
   * GoGo-BE#559 — a couple's budget is a total for two. Enforced on the server
   * because a rule only the client keeps is a rule the next client forgets
   * (RULE-CORE-005); MobileApp#189 stored per-person amounts for months and
   * the per-person ceiling read back as double the intent.
   */
  it('refuses a per-person budget on a couple room, and takes a total', async () => {
    const { token } = await registerUser('couple-budget@gogo.id.vn');
    const refused = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        type: 'couple',
        decisionMode: 'match',
        participantCount: 2,
        constraint: { ...baseConstraint, budgetMode: 'per_person' },
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('INVALID_BUDGET_MODE');
    expect(refused.json().field_errors?.[0]?.field).toBe('constraint.budgetMode');

    const accepted = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        type: 'couple',
        decisionMode: 'match',
        participantCount: 2,
        constraint: { ...baseConstraint, budgetMode: 'total', budgetAmount: 800_000 },
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().constraints).toMatchObject({
      budgetMode: 'total',
      budgetAmount: 800_000,
    });
  });

  it('leaves a group host either unit', async () => {
    const { token } = await registerUser('group-budget@gogo.id.vn');
    for (const budgetMode of ['per_person', 'total'] as const) {
      const res = await api().inject({
        method: 'POST',
        url: '/v1/rooms',
        remoteAddress: ip(),
        headers: auth(token),
        payload: {
          type: 'group',
          decisionMode: 'vote',
          participantCount: 4,
          constraint: { ...baseConstraint, budgetMode },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().constraints.budgetMode).toBe(budgetMode);
    }
  });

  it('rejects couple rooms with vote mode or wrong participant count', async () => {
    const { token } = await registerUser('host2@gogo.id.vn');
    const badMode = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        type: 'couple',
        decisionMode: 'vote',
        participantCount: 2,
        constraint: baseConstraint,
      },
    });
    expect(badMode.statusCode).toBe(400);
    expect(badMode.json().code).toBe('INVALID_DECISION_MODE');

    const badCount = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        type: 'couple',
        decisionMode: 'match',
        participantCount: 3,
        constraint: baseConstraint,
      },
    });
    expect(badCount.statusCode).toBe(400);
  });

  it('rejects unpublished seed places (FR-ROOM-010)', async () => {
    const { token } = await registerUser('host3@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        type: 'group',
        decisionMode: 'vote',
        participantCount: 4,
        constraint: baseConstraint,
        seedPlaceIds: [placeIds[2]], // draft place
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_SEED_PLACE');
  });

  it('validates status transitions', async () => {
    const { token } = await registerUser('host4@gogo.id.vn');
    const room = await createGroupRoom(token);
    const bad = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { status: 'active' },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().code).toBe('INVALID_ROOM_TRANSITION');

    const ok = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { status: 'collecting' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('collecting');
  });
});

describe('permission matrix (SRS §15.7 — hand-crafted requests)', () => {
  it('non-members cannot read a room', async () => {
    const { token: hostToken } = await registerUser('host5@gogo.id.vn');
    const { token: otherToken } = await registerUser('other5@gogo.id.vn');
    const room = await createGroupRoom(hostToken);
    const res = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      headers: auth(otherToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_A_MEMBER');
  });

  it('members cannot edit constraints, transition, invite or remove members', async () => {
    const { token: hostToken } = await registerUser('host6@gogo.id.vn');
    const { token: memberToken } = await registerUser('member6@gogo.id.vn');
    const room = await createGroupRoom(hostToken);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: { status: 'collecting' },
    });
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: {},
    });
    const code = invite.json().code;
    const join = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { inviteCode: code },
    });
    expect(join.statusCode).toBe(201);

    for (const attempt of [
      api().inject({
        method: 'PATCH',
        url: `/v1/rooms/${room.id}/constraints`,
        remoteAddress: ip(),
        headers: auth(memberToken),
        payload: { ...baseConstraint, expectedConstraintVersion: 1 },
      }),
      api().inject({
        method: 'PATCH',
        url: `/v1/rooms/${room.id}/status`,
        remoteAddress: ip(),
        headers: auth(memberToken),
        payload: { status: 'matching' },
      }),
      api().inject({
        method: 'POST',
        url: `/v1/rooms/${room.id}/invites`,
        remoteAddress: ip(),
        headers: auth(memberToken),
        payload: {},
      }),
      api().inject({
        method: 'POST',
        url: `/v1/rooms/${room.id}/seed-places`,
        remoteAddress: ip(),
        headers: auth(memberToken),
        payload: { placeIds: [placeIds[0]] },
      }),
    ]) {
      const res = await attempt;
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('HOST_ONLY');
    }
  });

  it('a guest token from another room cannot touch this room', async () => {
    const { token: hostToken } = await registerUser('host7@gogo.id.vn');
    const roomA = await createGroupRoom(hostToken);
    const roomB = await createGroupRoom(hostToken);
    // guest joins room B via share code
    const [rowB] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomB.id));
    await db
      .update(schema.rooms)
      .set({ status: 'collecting' })
      .where(eq(schema.rooms.id, roomB.id));
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: rowB!.code, displayName: 'Khách B' },
    });
    const guestToken = guest.json().accessToken;

    const res = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${roomA.id}`,
      headers: auth(guestToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ROOM_SCOPE_VIOLATION');
  });

  it('guests cannot create rooms', async () => {
    const { token: hostToken } = await registerUser('host8@gogo.id.vn');
    const room = await createGroupRoom(hostToken);
    const [row] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, room.id));
    await db.update(schema.rooms).set({ status: 'collecting' }).where(eq(schema.rooms.id, room.id));
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: row!.code, displayName: 'Khách' },
    });
    const res = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(guest.json().accessToken),
      payload: {
        type: 'group',
        decisionMode: 'vote',
        participantCount: 4,
        constraint: baseConstraint,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('constraints + staleness (core rule #6)', () => {
  /**
   * GoGo-BE#559 — the rule applies to an explicit constraint edit too, and a
   * room stored before it keeps its value: nothing is converted behind the
   * host's back, but the next edit has to name the right unit.
   */
  it('keeps a legacy per-person couple room readable, and makes its next edit state the unit', async () => {
    const { token } = await registerUser('legacy-couple@gogo.id.vn');
    const created = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        type: 'couple',
        decisionMode: 'match',
        participantCount: 2,
        constraint: { ...baseConstraint, budgetMode: 'total', budgetAmount: 600_000 },
      },
    });
    const room = created.json();

    // A row written before the rule existed. Reached through the database
    // rather than the API, because the API is exactly what now refuses it.
    await db
      .update(schema.roomConstraints)
      .set({ budgetMode: 'per_person', budgetAmount: 300_000 })
      .where(eq(schema.roomConstraints.roomId, room.id));

    const read = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().constraints).toMatchObject({
      budgetMode: 'per_person',
      budgetAmount: 300_000,
    });

    const refused = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/constraints`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        ...baseConstraint,
        budgetMode: 'per_person',
        expectedConstraintVersion: read.json().constraintVersion,
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('INVALID_BUDGET_MODE');

    // The refusal changed nothing.
    const unchanged = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(unchanged.json().constraints.budgetMode).toBe('per_person');

    const fixed = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/constraints`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        ...baseConstraint,
        budgetMode: 'total',
        budgetAmount: 600_000,
        expectedConstraintVersion: unchanged.json().constraintVersion,
      },
    });
    expect(fixed.statusCode).toBe(200);
  });

  it('host edit bumps version and marks plans/scores stale; version conflict is 409', async () => {
    const { token } = await registerUser('host9@gogo.id.vn');
    const room = await createGroupRoom(token);

    // Fabricate a run + score + current plan directly.
    const [run] = await db
      .insert(schema.suggestionRuns)
      .values({
        roomId: room.id,
        status: 'succeeded',
        constraintVersion: 1,
        engineVersion: 'test',
        weightsVersion: 'test',
        inputSnapshot: {},
      })
      .returning();
    await db.insert(schema.candidateScores).values({
      runId: run!.id,
      roomId: room.id,
      placeId: placeIds[0]!,
      rank: 1,
      scoreMicros: 900_000,
      components: {},
    });
    await db.insert(schema.plans).values({
      roomId: room.id,
      version: 1,
      status: 'current',
      totals: {
        costMin: 0,
        costMax: 0,
        currency: 'VND',
        durationMinutes: 0,
        travelDistanceM: 0,
        overBudget: false,
        uncertain: false,
      },
      constraintVersion: 1,
    });

    const edit = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/constraints`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { ...baseConstraint, budgetAmount: 200_000, expectedConstraintVersion: 1 },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().constraintVersion).toBe(2);
    expect(edit.json().constraints.budgetAmount).toBe(200_000);

    const [score] = await db
      .select()
      .from(schema.candidateScores)
      .where(eq(schema.candidateScores.roomId, room.id));
    expect(score!.isStale).toBe(true);
    const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.roomId, room.id));
    expect(plan!.isStale).toBe(true);

    const conflict = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/constraints`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { ...baseConstraint, expectedConstraintVersion: 1 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('CONSTRAINT_VERSION_CONFLICT');
  });
});

describe('invites (BE-BFF-004, FR-ROOM-009)', () => {
  it('revoked invites stop working; guest join via invite works', async () => {
    const { token } = await registerUser('host10@gogo.id.vn');
    const room = await createGroupRoom(token);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { status: 'collecting' },
    });
    const created = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    const { inviteId, code } = created.json();
    expect(code.length).toBeGreaterThanOrEqual(20);

    const guestJoin = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: code, displayName: 'Khách Mời' },
    });
    expect(guestJoin.statusCode).toBe(201);
    expect(guestJoin.json().roomId).toBe(room.id);

    await api().inject({
      method: 'DELETE',
      url: `/v1/rooms/${room.id}/invites/${inviteId}`,
      remoteAddress: ip(),
      headers: auth(token),
    });
    const afterRevoke = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: code, displayName: 'Khách Trễ' },
    });
    expect(afterRevoke.statusCode).toBe(410);
  });

  it('maxUses is enforced atomically', async () => {
    const { token } = await registerUser('host11@gogo.id.vn');
    const room = await createGroupRoom(token);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { status: 'collecting' },
    });
    const created = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { maxUses: 1 },
    });
    const code = created.json().code;
    const first = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: code, displayName: 'Một' },
    });
    expect(first.statusCode).toBe(201);
    const second = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: code, displayName: 'Hai' },
    });
    expect(second.statusCode).toBe(410);
  });

  it('a refused join spends no use of the invite, for a user or a guest (GoGo-BE#592)', async () => {
    const { token } = await registerUser('host592@gogo.id.vn');
    const room = await createGroupRoom(token);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { status: 'collecting' },
    });
    const created = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { maxUses: 3 },
    });
    const { inviteId, code } = created.json();
    const useCount = async () =>
      (await db.select().from(schema.roomInvites).where(eq(schema.roomInvites.id, inviteId)))[0]!
        .useCount;

    const joined = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: code, displayName: 'Vào Kịp' },
    });
    expect(joined.statusCode).toBe(201);
    expect(await useCount()).toBe(1);

    // The room moves past collecting: the regression's `ready` room.
    await db.update(schema.rooms).set({ status: 'ready' }).where(eq(schema.rooms.id, room.id));

    const outsider = await registerUser('late592@gogo.id.vn');
    const userJoin = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(outsider.token),
      payload: { inviteCode: code },
    });
    expect(userJoin.statusCode).toBe(410);
    expect(userJoin.json().code).toBe('ROOM_NOT_JOINABLE');
    expect(await useCount()).toBe(1);

    for (const displayName of ['Trễ Một', 'Trễ Hai', 'Trễ Ba']) {
      const guestJoin = await api().inject({
        method: 'POST',
        url: '/v1/rooms/join/guest',
        remoteAddress: ip(),
        payload: { inviteCode: code, displayName },
      });
      expect(guestJoin.statusCode).toBe(410);
      expect(guestJoin.json().code).toBe('ROOM_NOT_JOINABLE');
    }
    // Three refused guests would have spent the last two uses of a maxUses-3 invite.
    expect(await useCount()).toBe(1);

    // A revoked invite still says so, and still spends nothing.
    await api().inject({
      method: 'DELETE',
      url: `/v1/rooms/${room.id}/invites/${inviteId}`,
      remoteAddress: ip(),
      headers: auth(token),
    });
    const revoked = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: code, displayName: 'Thu Hồi' },
    });
    expect(revoked.statusCode).toBe(410);
    expect(revoked.json().code).toBe('INVITE_NOT_USABLE');
    expect(await useCount()).toBe(1);
  });

  it('an existing member who reopens the invite after the room is finalised goes back in (GoGo-BE#597)', async () => {
    const host = await registerUser('host597@gogo.id.vn');
    const member = await registerUser('member597@gogo.id.vn');
    const outsider = await registerUser('outsider597@gogo.id.vn');
    const room = await createGroupRoom(host.token);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(host.token),
      payload: { status: 'collecting' },
    });
    const invite = async () =>
      (
        await api().inject({
          method: 'POST',
          url: `/v1/rooms/${room.id}/invites`,
          remoteAddress: ip(),
          headers: auth(host.token),
          payload: { maxUses: 5 },
        })
      ).json() as { inviteId: string; code: string };
    const shared = await invite();
    const expiring = await invite();
    const useCount = async (inviteId: string) =>
      (await db.select().from(schema.roomInvites).where(eq(schema.roomInvites.id, inviteId)))[0]!
        .useCount;
    const join = (token: string, inviteCode: string) =>
      api().inject({
        method: 'POST',
        url: '/v1/rooms/join',
        remoteAddress: ip(),
        headers: auth(token),
        payload: { inviteCode },
      });

    const first = await join(member.token, shared.code);
    expect(first.statusCode).toBe(201);
    expect(await useCount(shared.inviteId)).toBe(1);

    // The regression's shape: the plan is ready, and the member opens the link again.
    await db.update(schema.rooms).set({ status: 'ready' }).where(eq(schema.rooms.id, room.id));

    const again = await join(member.token, shared.code);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(again.json().roomId).toBe(room.id);
    expect(await useCount(shared.inviteId)).toBe(1);

    const hostAgain = await join(host.token, shared.code);
    expect(hostAgain.statusCode).toBe(201);
    expect(hostAgain.json()).toMatchObject({ roomId: room.id, role: 'host' });
    expect(await useCount(shared.inviteId)).toBe(1);

    // Someone who is not in the room is still refused, and still spends nothing.
    const refused = await join(outsider.token, shared.code);
    expect(refused.statusCode).toBe(410);
    expect(refused.json().code).toBe('ROOM_NOT_JOINABLE');
    expect(await useCount(shared.inviteId)).toBe(1);

    // A revoked or expired invite still says so to a non-member …
    await api().inject({
      method: 'DELETE',
      url: `/v1/rooms/${room.id}/invites/${shared.inviteId}`,
      remoteAddress: ip(),
      headers: auth(host.token),
    });
    await db
      .update(schema.roomInvites)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.roomInvites.id, expiring.inviteId));
    for (const code of [shared.code, expiring.code]) {
      const gone = await join(outsider.token, code);
      expect(gone.statusCode).toBe(410);
      expect(gone.json().code).toBe('INVITE_NOT_USABLE');
    }
    // … while the member still gets back into their own room through either.
    for (const code of [shared.code, expiring.code]) {
      const back = await join(member.token, code);
      expect(back.statusCode).toBe(201);
      expect(back.json().memberId).toBe(first.json().memberId);
    }
    expect(await useCount(shared.inviteId)).toBe(1);
    expect(await useCount(expiring.inviteId)).toBe(0);

    // Exactly one membership row for the member: nothing was added again.
    const rows = await db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.roomId, room.id));
    expect(rows.filter((row) => row.userId === member.userId)).toHaveLength(1);
  });

  it('a member the host removed is refused when reopening the invite, spending nothing (GoGo-BE#597)', async () => {
    const host = await registerUser('host597rm@gogo.id.vn');
    const member = await registerUser('member597rm@gogo.id.vn');
    const room = await createGroupRoom(host.token);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(host.token),
      payload: { status: 'collecting' },
    });
    const { inviteId, code } = (
      await api().inject({
        method: 'POST',
        url: `/v1/rooms/${room.id}/invites`,
        remoteAddress: ip(),
        headers: auth(host.token),
        payload: { maxUses: 5 },
      })
    ).json();
    const useCount = async () =>
      (await db.select().from(schema.roomInvites).where(eq(schema.roomInvites.id, inviteId)))[0]!
        .useCount;
    const join = () =>
      api().inject({
        method: 'POST',
        url: '/v1/rooms/join',
        remoteAddress: ip(),
        headers: auth(member.token),
        payload: { inviteCode: code },
      });

    const joined = await join();
    expect(joined.statusCode).toBe(201);
    expect(await useCount()).toBe(1);

    const removed = await api().inject({
      method: 'DELETE',
      url: `/v1/rooms/${room.id}/members/${joined.json().memberId}`,
      remoteAddress: ip(),
      headers: auth(host.token),
    });
    expect(removed.statusCode).toBe(200);
    await db.update(schema.rooms).set({ status: 'ready' }).where(eq(schema.rooms.id, room.id));

    const again = await join();
    expect(again.statusCode).toBe(410);
    expect(again.json().code).toBe('ROOM_NOT_JOINABLE');
    expect(await useCount()).toBe(1);
    const active = (
      await db.select().from(schema.roomMembers).where(eq(schema.roomMembers.roomId, room.id))
    ).filter((row) => row.userId === member.userId && row.removedAt === null);
    expect(active).toHaveLength(0);
  });

  it('host can remove a member; removed guest session is revoked', async () => {
    const { token } = await registerUser('host12@gogo.id.vn');
    const room = await createGroupRoom(token);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { status: 'collecting' },
    });
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: invite.json().code, displayName: 'Sắp Bị Xóa' },
    });
    const guestSessionId = guest.json().guestSessionId;
    const guestToken = guest.json().accessToken;

    const members = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}/members`,
      headers: auth(token),
    });
    const target = members.json().find((m: { isGuest: boolean }) => m.isGuest);
    const removed = await api().inject({
      method: 'DELETE',
      url: `/v1/rooms/${room.id}/members/${target.id}`,
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(removed.statusCode).toBe(200);

    const [session] = await db
      .select()
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.id, guestSessionId));
    expect(session!.revokedAt).not.toBeNull();

    // Removal revokes the guest session, so the outstanding access token is
    // rejected outright — stronger than the membership check alone.
    const denied = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      headers: auth(guestToken),
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().code).toBe('SESSION_REVOKED');
  });
});

describe('preferences (BE-BFF-005, FR-PREF-003/005)', () => {
  it('autosave with optimistic concurrency; complete moves room to matching', async () => {
    const { token: hostToken } = await registerUser('host13@gogo.id.vn');
    const room = await createGroupRoom(hostToken, 2);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: { status: 'collecting' },
    });
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: {},
    });
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: invite.json().code, displayName: 'Khách' },
    });
    const guestToken = guest.json().accessToken;

    // Unknown taxonomy key rejected.
    const badSave = await api().inject({
      method: 'PUT',
      url: `/v1/rooms/${room.id}/preferences/me`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: { selections: { mood: ['nonexistent'] }, expectedVersion: 0 },
    });
    expect(badSave.statusCode).toBe(400);
    expect(badSave.json().code).toBe('INVALID_TAXONOMY_KEYS');

    const save1 = await api().inject({
      method: 'PUT',
      url: `/v1/rooms/${room.id}/preferences/me`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: { selections: { mood: ['chill'] }, expectedVersion: 0 },
    });
    expect(save1.statusCode).toBe(200);
    expect(save1.json().version).toBe(1);

    const stale = await api().inject({
      method: 'PUT',
      url: `/v1/rooms/${room.id}/preferences/me`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: { selections: { mood: ['chill'] }, expectedVersion: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('PREFERENCE_VERSION_CONFLICT');

    // Guest saves + both complete → room auto-moves to matching.
    await api().inject({
      method: 'PUT',
      url: `/v1/rooms/${room.id}/preferences/me`,
      remoteAddress: ip(),
      headers: auth(guestToken),
      payload: { selections: { category: ['cafe'] }, expectedVersion: 0 },
    });
    const hostDone = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/preferences/complete`,
      remoteAddress: ip(),
      headers: auth(hostToken),
    });
    // The status code is contract, not detail: the generated clients type the
    // response off the declared 200 (GoGo-BE#448).
    expect(hostDone.statusCode).toBe(200);
    expect(hostDone.json().roomReadyForMatching).toBe(false);
    const guestDone = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/preferences/complete`,
      remoteAddress: ip(),
      headers: auth(guestToken),
    });
    expect(guestDone.statusCode).toBe(200);
    expect(guestDone.json().roomReadyForMatching).toBe(true);

    const after = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      headers: auth(hostToken),
    });
    expect(after.json().status).toBe('matching');
    const memberStates = after
      .json()
      .members.map((m: { selectionStatus: string }) => m.selectionStatus);
    expect(memberStates).toEqual(['completed', 'completed']);
  });

  it("host never sees another member's selections (FR-PREF-005)", async () => {
    const { token: hostToken } = await registerUser('host14@gogo.id.vn');
    const room = await createGroupRoom(hostToken);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: { status: 'collecting' },
    });
    const members = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}/members`,
      headers: auth(hostToken),
    });
    for (const m of members.json()) {
      expect(m).not.toHaveProperty('selections');
      expect(m).not.toHaveProperty('weights');
    }
    // /preferences/me returns only the caller's own data by construction.
    const mine = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}/preferences/me`,
      headers: auth(hostToken),
    });
    expect(mine.statusCode).toBe(200);
  });
});

describe('taxonomy endpoint (FR-PREF-002)', () => {
  it('serves stable keys with labels, filterable by kind', async () => {
    const res = await api().inject({ method: 'GET', url: '/v1/taxonomies?kinds=mood' });
    expect(res.statusCode).toBe(200);
    const kinds = res.json().kinds;
    expect(Object.keys(kinds)).toEqual(['mood']);
    expect(kinds.mood.map((t: { key: string }) => t.key)).toContain('chill');
  });
});

describe('GET /rooms — the actor can find their rooms again (#152)', () => {
  it('lists rooms the caller belongs to, newest activity first', async () => {
    const { token } = await registerUser(`list${Date.now()}@g.vn`);
    const first = await createGroupRoom(token);
    const second = await createGroupRoom(token);

    const res = await api().inject({
      method: 'GET',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((r: { id: string }) => r.id);
    // Before this endpoint a client that lost the id lost the room for good.
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids[0]).toBe(second.id); // most recently touched first
  });

  it('carries enough progress to draw a row without a call per room', async () => {
    const { token } = await registerUser(`prog${Date.now()}@g.vn`);
    const room = await createGroupRoom(token);
    const body = (
      await api().inject({
        method: 'GET',
        url: '/v1/rooms',
        remoteAddress: ip(),
        headers: auth(token),
      })
    ).json();
    const row = body.items.find((r: { id: string }) => r.id === room.id);
    expect(row.myRole).toBe('host');
    expect(row.memberCount).toBeGreaterThan(0);
    expect(row).toHaveProperty('completedCount');
    // A list screen has no reason to hand out an invite code.
    expect(row).not.toHaveProperty('code');
    expect(row).not.toHaveProperty('inviteCode');
  });

  it('never shows a room the caller is not in', async () => {
    const { token: mine } = await registerUser(`mine${Date.now()}@g.vn`);
    const { token: stranger } = await registerUser(`other${Date.now()}@g.vn`);
    const room = await createGroupRoom(mine);

    const body = (
      await api().inject({
        method: 'GET',
        url: '/v1/rooms',
        remoteAddress: ip(),
        headers: auth(stranger),
      })
    ).json();
    expect(body.items.map((r: { id: string }) => r.id)).not.toContain(room.id);
  });

  it('filters by status and pages by cursor', async () => {
    const { token } = await registerUser(`page${Date.now()}@g.vn`);
    for (let i = 0; i < 3; i++) await createGroupRoom(token);

    const page = (
      await api().inject({
        method: 'GET',
        url: '/v1/rooms?limit=2',
        remoteAddress: ip(),
        headers: auth(token),
      })
    ).json();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const next = (
      await api().inject({
        method: 'GET',
        url: `/v1/rooms?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        remoteAddress: ip(),
        headers: auth(token),
      })
    ).json();
    const seen = new Set([
      ...page.items.map((r: { id: string }) => r.id),
      ...next.items.map((r: { id: string }) => r.id),
    ]);
    expect(seen.size).toBe(3);

    const filtered = (
      await api().inject({
        method: 'GET',
        url: '/v1/rooms?status=completed',
        remoteAddress: ip(),
        headers: auth(token),
      })
    ).json();
    expect(filtered.items).toHaveLength(0);
  });
});

/**
 * #154 — the SSE stream. `inject` buffers a whole response, which never
 * arrives for a stream, so these tests speak to a real socket.
 */
describe('room realtime stream (BE-BFF-013, #154)', () => {
  let baseUrl: string;

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  /** Reads frames until `want` events have arrived or the deadline passes. */
  async function readEvents(
    response: Response,
    want: number,
    timeoutMs = 5_000,
  ): Promise<{ type: string; id: string | null; data: unknown }[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: { type: string; id: string | null; data: unknown }[] = [];
    let buffer = '';
    const deadline = Date.now() + timeoutMs;

    while (events.length < want && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const type = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
        const id = /^id: (.*)$/m.exec(frame)?.[1] ?? null;
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (type === 'heartbeat') continue;
        events.push({ type, id, data: data ? JSON.parse(data) : null });
      }
    }
    await reader.cancel();
    return events;
  }

  it('a second member joining reaches the host without a poll', async () => {
    const hostToken = (await registerUser('sse-host@gogo.local')).token;
    const memberToken = (await registerUser('sse-member@gogo.local')).token;
    const room = await createGroupRoom(hostToken);
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: {},
    });

    const stream = await fetch(`${baseUrl}/v1/rooms/${room.id}/events`, {
      headers: { ...auth(hostToken), accept: 'text/event-stream' },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const events = readEvents(stream, 1);
    await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { inviteCode: invite.json().code },
    });

    const [joined] = await events;
    expect(joined!.type).toBe('participant.joined');
    expect(joined!.id).toBe('1');
    expect((joined!.data as { event_type: string }).event_type).toBe('participant.joined');
    // The room-scoped member id, not the account id.
    expect((joined!.data as { actor_id: string }).actor_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a non-member cannot open the stream, hand-crafted request included', async () => {
    const hostToken = (await registerUser('sse-owner@gogo.local')).token;
    const outsiderToken = (await registerUser('sse-outsider@gogo.local')).token;
    const room = await createGroupRoom(hostToken);

    const res = await fetch(`${baseUrl}/v1/rooms/${room.id}/events`, {
      headers: { ...auth(outsiderToken), accept: 'text/event-stream' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_A_MEMBER');
  });

  it('rejects an unauthenticated stream rather than opening one', async () => {
    const hostToken = (await registerUser('sse-anon-host@gogo.local')).token;
    const room = await createGroupRoom(hostToken);

    const res = await fetch(`${baseUrl}/v1/rooms/${room.id}/events`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
  });

  it('resumes from Last-Event-ID instead of dropping the gap', async () => {
    const hostToken = (await registerUser('sse-resume-host@gogo.local')).token;
    const first = (await registerUser('sse-resume-a@gogo.local')).token;
    const second = (await registerUser('sse-resume-b@gogo.local')).token;
    const room = await createGroupRoom(hostToken);
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: { maxUses: 5 },
    });
    const code = invite.json().code;

    // Connect, see the first join, then drop the connection mid-room.
    const initial = await fetch(`${baseUrl}/v1/rooms/${room.id}/events`, {
      headers: { ...auth(hostToken), accept: 'text/event-stream' },
    });
    const seen = readEvents(initial, 1);
    await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(first),
      payload: { inviteCode: code },
    });
    const [firstJoin] = await seen;
    const lastEventId = firstJoin!.id!;

    // The second join happens while nobody is connected — exactly the tunnel
    // case. Without resume the host would never learn about it.
    await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(second),
      payload: { inviteCode: code },
    });

    const resumed = await fetch(`${baseUrl}/v1/rooms/${room.id}/events`, {
      headers: {
        ...auth(hostToken),
        accept: 'text/event-stream',
        'last-event-id': lastEventId,
      },
    });
    const replayed = await readEvents(resumed, 1);
    expect(replayed[0]!.type).toBe('participant.joined');
    expect(Number(replayed[0]!.id)).toBeGreaterThan(Number(lastEventId));
  });

  it('never puts another member’s selections on the wire', async () => {
    const hostToken = (await registerUser('sse-priv-host@gogo.local')).token;
    const memberToken = (await registerUser('sse-priv-member@gogo.local')).token;
    const room = await createGroupRoom(hostToken, 2);
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(hostToken),
      payload: {},
    });
    await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { inviteCode: invite.json().code },
    });

    const stream = await fetch(`${baseUrl}/v1/rooms/${room.id}/events`, {
      headers: { ...auth(hostToken), accept: 'text/event-stream' },
    });
    const events = readEvents(stream, 1);
    await api().inject({
      method: 'PUT',
      url: `/v1/rooms/${room.id}/preferences/me`,
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { selections: { mood: ['chill'] }, expectedVersion: 0 },
    });

    const [changed] = await events;
    expect(changed!.type).toBe('participant.selection_changed');
    const payload = (changed!.data as { payload: Record<string, unknown> }).payload;
    expect(payload['selectionStatus']).toBe('in_progress');
    // Progress, not content: FR-PREF-005 is not suspended by the transport.
    expect(JSON.stringify(changed!.data)).not.toContain('chill');
  });
});

describe('BE-BFF-020 current schedule in room summaries', () => {
  it('lists constraint-only schedules and reflects a newer constraint version', async () => {
    const user = await registerUser('schedule-current@example.com');
    const startAt = '2026-09-10T12:00:00.000Z';
    const created = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(user.token),
      payload: {
        type: 'group',
        decisionMode: 'vote',
        participantCount: 4,
        constraint: { ...baseConstraint, startAt },
      },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json();
    expect(room.scheduledDate).toBe(startAt);
    const read = async () =>
      (
        await api().inject({
          method: 'GET',
          url: '/v1/rooms',
          remoteAddress: ip(),
          headers: auth(user.token),
        })
      ).json();
    expect(
      (await read()).items.find((item: { id: string }) => item.id === room.id).scheduledDate,
    ).toBe(startAt);
    const next = '2026-09-12T12:00:00.000Z';
    const updated = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/constraints`,
      remoteAddress: ip(),
      headers: auth(user.token),
      payload: {
        ...baseConstraint,
        startAt: next,
        expectedConstraintVersion: room.constraintVersion,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().scheduledDate).toBe(next);
    expect(
      (await read()).items.find((item: { id: string }) => item.id === room.id).scheduledDate,
    ).toBe(next);
  });

  it('keeps a legacy scheduledDate when the constraint has no start time', async () => {
    const user = await registerUser('schedule-legacy@example.com');
    const scheduledDate = '2026-09-10T12:00:00.000Z';
    const res = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(user.token),
      payload: {
        type: 'group',
        decisionMode: 'vote',
        participantCount: 4,
        scheduledDate,
        constraint: baseConstraint,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().scheduledDate).toBe(scheduledDate);
    const list = await api().inject({
      method: 'GET',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(user.token),
    });
    expect(list.json().items[0].scheduledDate).toBe(scheduledDate);
  });
});

describe('BE-BFF-017 partial preference matching', () => {
  it('requires quorum and host acknowledgement, keeps membership/budget and accepts late completion', async () => {
    const host = await registerUser('partial-host@gogo.test');
    const room = await createGroupRoom(host.token, 3);
    const inviteResponse = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(host.token),
      payload: { maxUses: 10 },
    });
    const inviteCode = inviteResponse.json().code;
    const guests: string[] = [];
    for (const displayName of ['Complete', 'Late']) {
      const join = await api().inject({
        method: 'POST',
        url: '/v1/rooms/join/guest',
        remoteAddress: ip(),
        payload: { inviteCode, displayName },
      });
      expect(join.statusCode).toBe(201);
      guests.push(join.json().accessToken);
    }
    async function complete(token: string) {
      const save = await api().inject({
        method: 'PUT',
        url: `/v1/rooms/${room.id}/preferences/me`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: { expectedVersion: 0, selections: { mood: ['chill'] } },
      });
      expect(save.statusCode).toBe(200);
      const done = await api().inject({
        method: 'POST',
        url: `/v1/rooms/${room.id}/preferences/complete`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: {},
      });
      expect(done.statusCode).toBe(200);
    }
    const transition = (token: string, allowIncompletePreferences = false) =>
      api().inject({
        method: 'PATCH',
        url: `/v1/rooms/${room.id}/status`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: { status: 'matching', allowIncompletePreferences },
      });
    await complete(host.token);
    expect((await transition(host.token, true)).json().code).toBe('MATCHING_QUORUM_REQUIRED');
    await complete(guests[0]!);
    expect((await transition(host.token)).json().code).toBe('PREFERENCES_INCOMPLETE');
    expect((await transition(guests[0]!, true)).statusCode).toBe(403);
    const before = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      headers: auth(host.token),
    });
    expect(before.json().matching).toMatchObject({
      canStartWithIncomplete: true,
      pendingCount: 1,
      completedCount: 2,
    });
    const started = await transition(host.token, true);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      status: 'matching',
      participantCount: 3,
      constraints: baseConstraint,
    });
    expect(started.json().members).toHaveLength(3);
    const generation = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/suggestions`,
      remoteAddress: ip(),
      headers: auth(host.token),
      payload: {},
    });
    expect(generation.statusCode).toBe(201);
    const runId = generation.json().run.id;
    const [run] = await db
      .select()
      .from(schema.suggestionRuns)
      .where(eq(schema.suggestionRuns.id, runId));
    const snapshot = run!.inputSnapshot as {
      participantCount: number;
      completedMemberCount: number;
      memberPreferences: { selections: Record<string, string[]> }[];
    };
    expect(snapshot.participantCount).toBe(3);
    expect(snapshot.completedMemberCount).toBe(2);
    expect(snapshot.memberPreferences).toHaveLength(3);
    expect(
      snapshot.memberPreferences.filter((m) => Object.keys(m.selections).length === 0),
    ).toHaveLength(1);
    const { SuggestionsRepository } =
      await import('../../../libs/modules/suggestions/infrastructure/suggestions.repository.js');
    const repository = app.get(SuggestionsRepository);
    const beforeLateCompletion = await repository.buildSnapshot(room.id);
    await complete(guests[1]!);
    await expect(
      repository.persistScores(
        runId,
        room.id,
        [],
        {
          eventType: 'suggestion.generated',
          resourceType: 'room',
          resourceId: room.id,
          payload: {},
        },
        beforeLateCompletion,
      ),
    ).rejects.toThrow('Room inputs changed');
    const current = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}/suggestions/current`,
      headers: auth(host.token),
    });
    expect(current.json().candidates.length).toBeGreaterThan(0);
    {
      expect(current.json().run.stale).toBe(true);
      const finalize = await api().inject({
        method: 'POST',
        url: `/v1/rooms/${room.id}/votes/finalize`,
        remoteAddress: ip(),
        headers: auth(host.token),
        payload: { placeId: current.json().candidates[0].placeId },
      });
      expect(finalize.json().code).toBe('STALE_SUGGESTIONS');
    }
  });

  it('stops counting a member as complete while they hold a new draft', async () => {
    const host = await registerUser('partial-redraft@gogo.test');
    const room = await createGroupRoom(host.token, 3);
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(host.token),
      payload: { maxUses: 10 },
    });
    const join = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: invite.json().code, displayName: 'Editor' },
    });
    expect(join.statusCode).toBe(201);
    const guest: string = join.json().accessToken;
    const save = (token: string, expectedVersion: number) =>
      api().inject({
        method: 'PUT',
        url: `/v1/rooms/${room.id}/preferences/me`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: { expectedVersion, selections: { mood: ['chill'] } },
      });
    const complete = (token: string) =>
      api().inject({
        method: 'POST',
        url: `/v1/rooms/${room.id}/preferences/complete`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: {},
      });
    const readiness = async () =>
      (
        await api().inject({
          method: 'GET',
          url: `/v1/rooms/${room.id}`,
          headers: auth(host.token),
        })
      ).json();
    for (const token of [host.token, guest]) {
      expect((await save(token, 0)).statusCode).toBe(200);
      expect((await complete(token)).statusCode).toBe(200);
    }
    expect((await readiness()).matching).toMatchObject({
      completedCount: 2,
      pendingCount: 0,
      canStart: true,
    });

    // Re-saving turns the completed response back into a draft: the member row
    // must follow, or the lobby offers a start the ranking would refuse.
    expect((await save(guest, 1)).statusCode).toBe(200);
    const editing = await readiness();
    expect(editing.matching).toMatchObject({
      completedCount: 1,
      pendingCount: 1,
      canStart: false,
      canStartWithIncomplete: false,
      blockedReason: 'MATCHING_QUORUM_REQUIRED',
    });
    expect(
      editing.members.find((m: { displayName: string }) => m.displayName === 'Editor')
        .selectionStatus,
    ).toBe('in_progress');

    expect((await complete(guest)).statusCode).toBe(200);
    expect((await readiness()).matching).toMatchObject({
      completedCount: 2,
      pendingCount: 0,
      canStart: true,
    });
  });
});

describe('BE-BFF-022 rename a room (#579)', () => {
  it('lets only the host rename or clear a room while it is being planned', async () => {
    const host = await registerUser('rename-host@gogo.test');
    const member = await registerUser('rename-member@gogo.test');
    const room = await createGroupRoom(host.token);
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(host.token),
      payload: { maxUses: 10 },
    });
    const inviteCode = invite.json().code;
    const joined = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(member.token),
      payload: { inviteCode },
    });
    expect(joined.statusCode).toBe(201);
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode, displayName: 'Khách' },
    });
    expect(guest.statusCode).toBe(201);
    const rename = (token: string, payload: Record<string, unknown>) =>
      api().inject({
        method: 'PATCH',
        url: `/v1/rooms/${room.id}/title`,
        remoteAddress: ip(),
        headers: auth(token),
        payload,
      });

    const renamed = await rename(host.token, { title: '  Cà phê cuối tuần  ' });
    expect(renamed.statusCode).toBe(200);
    // Trimmed, and a name is not a constraint: no new constraint version.
    expect(renamed.json()).toMatchObject({
      title: 'Cà phê cuối tuần',
      constraintVersion: room.constraintVersion,
    });
    const list = await api().inject({ method: 'GET', url: '/v1/rooms', headers: auth(host.token) });
    expect(list.json().items.find((item: { id: string }) => item.id === room.id).title).toBe(
      'Cà phê cuối tuần',
    );

    // Server-enforced, whatever the client hides.
    const byMember = await rename(member.token, { title: 'Không phải host' });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().code).toBe('HOST_ONLY');
    expect((await rename(guest.json().accessToken, { title: 'Khách đổi tên' })).statusCode).toBe(
      403,
    );
    expect((await rename(host.token, { title: 'a'.repeat(81) })).statusCode).toBe(400);
    // An empty body must not read as "clear the name".
    expect((await rename(host.token, {})).statusCode).toBe(400);
    const unchanged = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      headers: auth(host.token),
    });
    expect(unchanged.json().title).toBe('Cà phê cuối tuần');

    const blank = await rename(host.token, { title: '   ' });
    expect(blank.statusCode).toBe(200);
    expect(blank.json().title).toBeUndefined();
    expect((await rename(host.token, { title: 'Lần nữa' })).json().title).toBe('Lần nữa');
    const cleared = await rename(host.token, { title: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().title).toBeUndefined();

    // One outbox record per accepted rename, none for refusals, never the text.
    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.resourceId, room.id));
    const renames = events.filter((event) => event.eventType === 'room.renamed');
    expect(renames).toHaveLength(4);
    expect(JSON.stringify(renames.map((event) => event.payload))).not.toContain('Cà phê');

    const cancel = await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(host.token),
      payload: { status: 'cancelled' },
    });
    expect(cancel.statusCode).toBe(200);
    const refused = await rename(host.token, { title: 'Quá muộn' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('ROOM_NOT_EDITABLE');
  });
});

describe('invite consumption (GoGo-BE#592)', () => {
  async function collectingRoomWithInvite(email: string, payload: Record<string, unknown> = {}) {
    const { token } = await registerUser(email);
    const room = await createGroupRoom(token);
    await api().inject({
      method: 'PATCH',
      url: `/v1/rooms/${room.id}/status`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { status: 'collecting' },
    });
    const created = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/invites`,
      remoteAddress: ip(),
      headers: auth(token),
      payload,
    });
    const { inviteId, code } = created.json();
    return { roomId: room.id as string, inviteId: inviteId as string, code: code as string };
  }
  const useCount = async (inviteId: string) =>
    (await db.select().from(schema.roomInvites).where(eq(schema.roomInvites.id, inviteId)))[0]!
      .useCount;
  const guestJoin = (inviteCode: string, displayName: string) =>
    api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode, displayName },
    });

  it('a guest refused for a room past its expiry spends no use', async () => {
    const { roomId, inviteId, code } = await collectingRoomWithInvite('host592exp@gogo.id.vn');
    await db
      .update(schema.rooms)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.rooms.id, roomId));

    for (const displayName of ['Hết Hạn Một', 'Hết Hạn Hai']) {
      const res = await guestJoin(code, displayName);
      expect(res.statusCode).toBe(410);
      expect(res.json().code).toBe('ROOM_EXPIRED');
    }
    expect(await useCount(inviteId)).toBe(0);
  });

  it('the guarded consume itself spends nothing on a room that moved on or expired', async () => {
    const repo = app.get(RoomsRepository);
    const { roomId, inviteId } = await collectingRoomWithInvite('host592guard@gogo.id.vn');

    await db.update(schema.rooms).set({ status: 'ready' }).where(eq(schema.rooms.id, roomId));
    expect(await repo.consumeInvite(inviteId, { joinableStatuses: JOINABLE_ROOM_STATUSES })).toBe(
      false,
    );
    expect(await useCount(inviteId)).toBe(0);

    await db
      .update(schema.rooms)
      .set({ status: 'collecting', expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.rooms.id, roomId));
    expect(
      await repo.consumeInvite(inviteId, {
        joinableStatuses: JOINABLE_ROOM_STATUSES,
        enforceRoomExpiry: true,
      }),
    ).toBe(false);
    expect(await useCount(inviteId)).toBe(0);

    // The expiry guard applies only where it is asked for.
    expect(await repo.consumeInvite(inviteId, { joinableStatuses: JOINABLE_ROOM_STATUSES })).toBe(
      true,
    );
    expect(await useCount(inviteId)).toBe(1);
  });

  it('two joins racing for the last use: one gets in, the other is told the invite is spent', async () => {
    const { inviteId, code } = await collectingRoomWithInvite('host592race@gogo.id.vn', {
      maxUses: 1,
    });

    const results = await Promise.all([guestJoin(code, 'Nhanh Tay'), guestJoin(code, 'Chậm Chân')]);
    const statuses = results.map((res) => res.statusCode).sort();
    expect(statuses).toEqual([201, 410]);
    expect(results.find((res) => res.statusCode === 410)!.json().code).toBe('INVITE_NOT_USABLE');
    expect(await useCount(inviteId)).toBe(1);
  });
});
