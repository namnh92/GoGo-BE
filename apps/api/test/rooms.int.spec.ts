import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

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
    const { token } = await registerUser('host1@gogo.vn', 'Chủ Kèo');
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

  it('rejects couple rooms with vote mode or wrong participant count', async () => {
    const { token } = await registerUser('host2@gogo.vn');
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
    const { token } = await registerUser('host3@gogo.vn');
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
    const { token } = await registerUser('host4@gogo.vn');
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
    const { token: hostToken } = await registerUser('host5@gogo.vn');
    const { token: otherToken } = await registerUser('other5@gogo.vn');
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
    const { token: hostToken } = await registerUser('host6@gogo.vn');
    const { token: memberToken } = await registerUser('member6@gogo.vn');
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
    const { token: hostToken } = await registerUser('host7@gogo.vn');
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
    const { token: hostToken } = await registerUser('host8@gogo.vn');
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
  it('host edit bumps version and marks plans/scores stale; version conflict is 409', async () => {
    const { token } = await registerUser('host9@gogo.vn');
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
    const { token } = await registerUser('host10@gogo.vn');
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
    const { token } = await registerUser('host11@gogo.vn');
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

  it('host can remove a member; removed guest session is revoked', async () => {
    const { token } = await registerUser('host12@gogo.vn');
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
    const { token: hostToken } = await registerUser('host13@gogo.vn');
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
    expect(hostDone.json().roomReadyForMatching).toBe(false);
    const guestDone = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${room.id}/preferences/complete`,
      remoteAddress: ip(),
      headers: auth(guestToken),
    });
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
    const { token: hostToken } = await registerUser('host14@gogo.vn');
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
