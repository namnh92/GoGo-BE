import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import { PlansRepository } from '../../../libs/modules/plans/infrastructure/plans.repository';
import { SuggestionsRepository } from '../../../libs/modules/suggestions/infrastructure/suggestions.repository';
import { hostAuthority } from '../../../libs/modules/rooms/domain/host-authority';
import { RoomPolicy } from '../../../libs/modules/rooms/presentation/room-policy';
import { OutboxDispatcher } from '../../../libs/modules/notifications/application/outbox-dispatcher';
import { FakePush } from '@gogo/providers';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
const root = path.resolve(__dirname, '../../..');
let ipNo = 0;
const ip = () => `10.87.${Math.floor(++ipNo / 250)}.${(ipNo % 250) + 1}`;
const api = () => app.getHttpAdapter().getInstance();
const headers = (token: string, key: string = randomUUID()) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});
async function user() {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: {
      email: `${randomUUID()}@gogo.test`,
      displayName: 'Member',
      password: 'Sufficiently-long-pw1!',
    },
  });
  expect(res.statusCode).toBe(201);
  return { token: res.json().accessToken as string, id: res.json().userId as string };
}
async function fixture(
  type: 'group' | 'couple' = 'group',
  owner?: Awaited<ReturnType<typeof user>>,
) {
  const a = owner ?? (await user()),
    b = await user(),
    c = await user();
  const created = await api().inject({
    method: 'POST',
    url: '/v1/rooms',
    remoteAddress: ip(),
    headers: headers(a.token),
    payload: {
      type,
      decisionMode: 'host',
      participantCount: type === 'couple' ? 2 : 4,
      constraint: { budgetMode: 'total', budgetAmount: 500000, currency: 'VND' },
    },
  });
  expect(created.statusCode).toBe(201);
  const room = created.json();
  const members = await db
    .insert(schema.roomMembers)
    .values([
      {
        roomId: room.id,
        userId: b.id,
        role: 'member',
        displayName: 'B',
        selectionStatus: 'pending',
      },
      ...(type === 'group'
        ? [
            {
              roomId: room.id,
              userId: c.id,
              role: 'member' as const,
              displayName: 'C',
              selectionStatus: 'completed' as const,
            },
          ]
        : []),
    ])
    .returning();
  return {
    a,
    b,
    c,
    roomId: room.id as string,
    aMember: room.hostMemberId as string,
    bMember: members.find((m) => m.userId === b.id)!.id,
    cMember: members.find((m) => m.userId === c.id)?.id ?? '',
    room,
  };
}
function transfer(
  f: Awaited<ReturnType<typeof fixture>>,
  target = f.bMember,
  token = f.a.token,
  version = 1,
  key: string = randomUUID(),
) {
  return api().inject({
    method: 'POST',
    url: `/v1/rooms/${f.roomId}/host-transfer`,
    remoteAddress: ip(),
    headers: headers(token, key),
    payload: { memberId: target, expectedHostVersion: version },
  });
}
async function invariant(roomId: string, hostMemberId: string, version: number) {
  const result = await pool.query(
    `select r.host_version, r.host_user_id, m.id, m.user_id from rooms r
    join room_members m on m.room_id=r.id and m.role='host' and m.removed_at is null where r.id=$1`,
    [roomId],
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ id: hostMemberId, host_version: version });
  expect(result.rows[0].user_id).toBe(result.rows[0].host_user_id);
}
async function counts(roomId: string) {
  return (
    await pool.query(
      `select
    (select count(*)::int from outbox_events where resource_id=$1 and event_type='room.host_transferred') events,
    (select count(*)::int from audit_logs where resource_id=$1 and action='room.host_transferred') audits`,
      [roomId],
    )
  ).rows[0];
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A real PostgreSQL lock waiter is the barrier, not Promise.all timing. */
async function waitForRoomWaiter(excludedPid: number) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const waiters = await pool.query(
      `select 1 from pg_stat_activity where pid<>$1 and wait_event_type='Lock'
      and query ilike '%rooms%' and query ilike '%for update%'`,
      [excludedPid],
    );
    if (waiters.rows.length) return;
    await pause(10);
  }
  throw new Error('No room lock waiter reached the controlled barrier');
}
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_host_transfer')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.SHARE_LINK_BASE_URL = 'https://go.gogo.test';
  process.env.AUTH_JWT_SECRET = 'host-transfer-test'.padEnd(48, 'x');
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 12 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(root, 'migrations') });
  for (const statement of readFileSync(
    path.join(root, 'scripts/ops/index-room-active-host.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await pool.query(statement);
  await pool.query('update notification_category_rollout set recipient_keys_enabled=true');
  await pool.query(
    'alter table room_members validate constraint room_members_host_user; alter table rooms validate constraint rooms_host_version_positive',
  );
  await pool.query(
    `update room_host_transfer_rollout set enabled=true,api_guards_ready=true,workers_ready=true,clients_ready=true,preflight_passed=true`,
  );
  expect((await pool.query('select room_host_transfer_ready() ready')).rows[0].ready).toBe(true);
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('host transfer HTTP, identity, receipt and preservation (#879)', () => {
  it.each([
    { method: 'POST' as const, suffix: 'invites', payload: { maxUses: 3 } },
    { method: 'PATCH' as const, suffix: 'title', payload: { title: 'Same request' } },
  ])(
    'F-01 blocks cross-room $suffix replay by the same actor after transfer',
    async ({ method, suffix, payload }) => {
      const f = await fixture();
      const g = await fixture('group', f.a); // Same actor still hosts R2 after losing R1.
      const key = randomUUID();
      const send = (roomId: string, token = f.a.token, clientKey = key) =>
        api().inject({
          method,
          url: `/v1/rooms/${roomId}/${suffix}`,
          remoteAddress: ip(),
          headers: headers(token, clientKey),
          payload,
        });
      const first = await send(f.roomId);
      expect(first.statusCode).toBe(method === 'POST' ? 201 : 200);
      const retry = await send(f.roomId);
      expect(retry.json()).toEqual(first.json());
      expect(retry.headers['x-idempotent-replay']).toBe('true');
      expect((await transfer(f)).statusCode).toBe(200);
      expect((await send(f.roomId)).statusCode).toBe(403);
      const before = (await pool.query('select * from rooms where id=$1', [g.roomId])).rows[0];
      const cross = await send(g.roomId);
      expect(cross.statusCode).toBe(422);
      expect(cross.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(cross.headers['x-idempotent-replay']).toBeUndefined();
      expect(cross.body).not.toContain(first.json().code);
      expect(cross.json()).not.toHaveProperty('inviteId');
      expect((await pool.query('select * from rooms where id=$1', [g.roomId])).rows[0]).toEqual(
        before,
      );
      expect(
        (await pool.query('select count(*)::int n from room_invites where room_id=$1', [g.roomId]))
          .rows[0].n,
      ).toBe(0);
      // A new key still executes on R2; another actor never receives A's cached answer.
      const fresh = await send(g.roomId, f.a.token, randomUUID());
      expect(fresh.statusCode).toBe(first.statusCode);
      expect((await send(g.roomId, g.b.token)).statusCode).toBe(403);
      // The new host can use the same key on R1 without replaying A's credential.
      const newHost = await send(f.roomId, f.b.token);
      expect(newHost.statusCode).toBe(first.statusCode);
      if (suffix === 'invites') expect(newHost.json().code).not.toBe(first.json().code);
    },
  );
  it('F-01 never replays or purges a pre-change template/body-only credential record', async () => {
    const f = await fixture();
    const g = await fixture('group', f.a);
    const key = randomUUID();
    const payload = { maxUses: 3 };
    const send = (roomId: string) =>
      api().inject({
        method: 'POST',
        url: `/v1/rooms/${roomId}/invites`,
        remoteAddress: ip(),
        headers: headers(f.a.token, key),
        payload,
      });
    const invite = await send(f.roomId);
    expect(invite.statusCode).toBe(201);
    const endpoint = 'POST /v1/rooms/:id/invites';
    const storedKey = createHash('sha256')
      .update(`user:${f.a.id}|${endpoint}|${key}`)
      .digest('hex');
    const legacyHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await pool.query('update idempotency_keys set request_hash=$1 where key=$2', [
      legacyHash,
      storedKey,
    ]);
    expect((await transfer(f)).statusCode).toBe(200);
    for (const roomId of [g.roomId, f.roomId]) {
      const retry = await send(roomId);
      expect(retry.statusCode).toBe(422);
      expect(retry.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(retry.headers['x-idempotent-replay']).toBeUndefined();
      expect(retry.body).not.toContain(invite.json().code);
    }
    const retained = (
      await pool.query('select request_hash, response_body from idempotency_keys where key=$1', [
        storedKey,
      ])
    ).rows[0];
    expect(retained.request_hash).toBe(legacyHash);
    expect(retained.response_body).toEqual(invite.json());
    expect(
      (await pool.query('select count(*)::int n from room_invites where room_id=$1', [g.roomId]))
        .rows[0].n,
    ).toBe(0);
  });
  it.each(['group', 'couple'] as const)(
    'transfers %s without changing room inputs or historical creator',
    async (type) => {
      const f = await fixture(type);
      const before = (await pool.query('select * from rooms where id=$1', [f.roomId])).rows[0];
      const res = await transfer(f);
      expect(res.statusCode).toBe(200);
      const receipt = res.json();
      expect(Object.keys(receipt).sort()).toEqual([
        'hostMemberId',
        'hostVersion',
        'previousHostMemberId',
        'roomId',
        'transferId',
        'transferredAt',
      ]);
      expect(receipt).toMatchObject({
        roomId: f.roomId,
        previousHostMemberId: f.aMember,
        hostMemberId: f.bMember,
        hostVersion: 2,
      });
      expect(res.headers['cache-control']).toBe('no-store');
      await invariant(f.roomId, f.bMember, 2);
      expect(await counts(f.roomId)).toEqual({ events: 1, audits: 1 });
      const after = (await pool.query('select * from rooms where id=$1', [f.roomId])).rows[0];
      for (const field of [
        'status',
        'constraint_version',
        'created_by_user_id',
        'participant_count',
        'expires_at',
        'scheduled_date',
        'code',
        'invitation_epoch',
      ])
        expect(after[field]).toEqual(before[field]);
      const event = (
        await pool.query('select * from outbox_events where id=$1', [receipt.transferId])
      ).rows[0];
      expect(event.payload).toEqual({
        previousHostMemberId: f.aMember,
        newHostMemberId: f.bMember,
        hostVersion: 2,
      });
      expect(new Date(event.occurred_at).toISOString()).toBe(receipt.transferredAt);
      const snapshot = await api().inject({
        method: 'GET',
        url: `/v1/rooms/${f.roomId}`,
        headers: headers(f.a.token),
      });
      expect(snapshot.json()).toMatchObject({
        myRole: 'member',
        hostMemberId: f.bMember,
        hostVersion: 2,
      });
      expect(snapshot.json().code).toBeUndefined();
      const old = await api().inject({
        method: 'PATCH',
        url: `/v1/rooms/${f.roomId}/title`,
        headers: headers(f.a.token),
        payload: { title: 'No' },
      });
      expect(old.statusCode).toBe(403);
      const current = await api().inject({
        method: 'PATCH',
        url: `/v1/rooms/${f.roomId}/title`,
        headers: headers(f.b.token),
        payload: { title: 'New host' },
      });
      expect(current.statusCode).toBe(200);
    },
  );
  it.each(['draft', 'collecting', 'matching', 'ready'])(
    'allows %s before expiry',
    async (status) => {
      const f = await fixture();
      await pool.query('update rooms set status=$2 where id=$1', [f.roomId, status]);
      expect((await transfer(f)).statusCode).toBe(200);
    },
  );
  it.each(['active', 'completed', 'cancelled', 'expired'])(
    'host is blocked in %s; members cannot infer target/state',
    async (status) => {
      const f = await fixture();
      await pool.query('update rooms set status=$2 where id=$1', [f.roomId, status]);
      expect((await transfer(f)).json().code).toBe('ROOM_NOT_EDITABLE');
      const member = await transfer(f, randomUUID(), f.b.token);
      expect(member.statusCode).toBe(403);
      expect(member.json().code).toBe('HOST_ONLY');
    },
  );
  it('checks target identity/status, self, removal, wrong room and guest scopes', async () => {
    const f = await fixture(),
      other = await fixture();
    expect((await transfer(f, f.aMember)).json().code).toBe('CANNOT_TRANSFER_TO_SELF');
    for (const target of [randomUUID(), other.bMember])
      expect((await transfer(f, target)).json().code).toBe('MEMBER_NOT_FOUND');
    await pool.query('update room_members set removed_at=now() where id=$1', [f.cMember]);
    expect((await transfer(f, f.cMember)).json().code).toBe('MEMBER_NOT_FOUND');
    for (const status of ['banned', 'deleted']) {
      await pool.query('update users set status=$2 where id=$1', [f.b.id, status]);
      expect((await transfer(f)).json().code).toBe('HOST_TRANSFER_TARGET_INELIGIBLE');
    }
    const outsider = await user();
    expect((await transfer(f, f.bMember, outsider.token)).json().code).toBe('NOT_A_MEMBER');
  });
  it('rejects guest caller/target and cross-room scope, then permits the committed claim', async () => {
    const f = await fixture();
    const session = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: f.room.code, displayName: 'Guest' },
    });
    expect(session.statusCode).toBe(201);
    const guest = session.json();
    const target = (
      await pool.query('select id from room_members where guest_session_id=$1', [
        guest.guestSessionId,
      ])
    ).rows[0].id;
    expect((await transfer(f, target)).json().code).toBe('HOST_TRANSFER_TARGET_INELIGIBLE');
    expect((await transfer(f, f.bMember, guest.accessToken)).json().code).toBe('HOST_ONLY');
    const other = await fixture();
    expect((await transfer(other, other.bMember, guest.accessToken)).json().code).toBe(
      'ROOM_SCOPE_VIOLATION',
    );
    const claim = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: randomUUID() + '@gogo.test',
        password: 'Sufficiently-long-pw1!',
        displayName: 'Claimed',
        claimGuestToken: guest.guestToken,
      },
    });
    expect(claim.statusCode).toBe(201);
    expect((await transfer(f, target)).statusCode).toBe(200);
    await invariant(f.roomId, target, 2);
  });
  it('requires a key and rejects extra fields/invalid versions', async () => {
    const f = await fixture();
    for (const payload of [
      { memberId: f.bMember },
      { memberId: f.bMember, expectedHostVersion: 0 },
      { memberId: f.bMember, expectedHostVersion: 1, role: 'host' },
    ]) {
      const r = await api().inject({
        method: 'POST',
        url: `/v1/rooms/${f.roomId}/host-transfer`,
        headers: headers(f.a.token),
        payload,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('VALIDATION_ERROR');
    }
    const noKey = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${f.roomId}/host-transfer`,
      headers: { authorization: `Bearer ${f.a.token}` },
      payload: { memberId: f.bMember, expectedHostVersion: 1 },
    });
    expect(noKey.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await transfer(f, f.bMember, f.a.token, 1, 'short')).json().code).toBe(
      'INVALID_IDEMPOTENCY_KEY',
    );
  });
  it('replays the original receipt after A→B→C, expiry and demotion, exactly once', async () => {
    const f = await fixture(),
      key = randomUUID();
    const first = await transfer(f, f.bMember, f.a.token, 1, key);
    expect(first.statusCode).toBe(200);
    expect((await transfer(f, f.cMember, f.b.token, 2)).statusCode).toBe(200);
    await pool.query("update rooms set status='cancelled' where id=$1", [f.roomId]);
    const replay = await transfer(f, f.bMember, f.a.token, 1, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect((await transfer(f, f.cMember, f.a.token, 1, key)).statusCode).toBe(422);
    expect(await counts(f.roomId)).toEqual({ events: 2, audits: 2 });
  });
  it('does not replay across actors or rooms and rejects a previous A term', async () => {
    const f = await fixture(),
      g = await fixture(),
      key = randomUUID();
    expect((await transfer(f, f.bMember, f.a.token, 1, key)).statusCode).toBe(200);
    expect((await transfer(g, g.bMember, g.a.token, 1, key)).json().roomId).toBe(g.roomId);
    expect((await transfer(f, f.aMember, f.b.token, 2, key)).statusCode).toBe(200);
    expect((await transfer(f, f.cMember, f.a.token, 1)).json().code).toBe('HOST_VERSION_CONFLICT');
    await invariant(f.roomId, f.aMember, 3);
  });
  it('keeps old invite preview/join/revoke and rejects credential replay for the former host', async () => {
    const f = await fixture(),
      key = randomUUID();
    const invite = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${f.roomId}/invites`,
      headers: headers(f.a.token, key),
      payload: { maxUses: 3 },
    });
    expect(invite.statusCode).toBe(201);
    const value = invite.json();
    expect((await transfer(f)).statusCode).toBe(200);
    const replay = await api().inject({
      method: 'POST',
      url: `/v1/rooms/${f.roomId}/invites`,
      headers: headers(f.a.token, key),
      payload: { maxUses: 3 },
    });
    expect(replay.statusCode).toBe(403);
    const preview = await api().inject({
      method: 'POST',
      url: '/v1/rooms/invites/preview',
      remoteAddress: ip(),
      payload: { inviteCode: value.code },
    });
    expect(preview.statusCode).toBe(200);
    const joining = await user();
    expect(
      (
        await api().inject({
          method: 'POST',
          url: '/v1/rooms/join',
          remoteAddress: ip(),
          headers: headers(joining.token),
          payload: { inviteCode: value.code },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api().inject({
          method: 'DELETE',
          url: `/v1/rooms/${f.roomId}/invites/${value.inviteId}`,
          headers: headers(f.b.token),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('controlled PostgreSQL races and rollback (#879)', () => {
  it('serializes two transfers behind a real row-lock barrier', async () => {
    const f = await fixture();
    const blocker = await pool.connect();
    await blocker.query('begin');
    const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('select id from rooms where id=$1 for update', [f.roomId]);
    try {
      const first = transfer(f);
      await waitForRoomWaiter(pid);
      const second = transfer(f, f.cMember);
      await blocker.query('commit');
      const results = await Promise.all([first, second]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
      await invariant(f.roomId, f.bMember, 2);
      expect(await counts(f.roomId)).toEqual({ events: 1, audits: 1 });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
  it('same key waits for the first committed receipt', async () => {
    const f = await fixture(),
      key = randomUUID(),
      blocker = await pool.connect();
    await blocker.query('begin');
    const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('select id from rooms where id=$1 for update', [f.roomId]);
    try {
      const a = transfer(f, f.bMember, f.a.token, 1, key);
      await waitForRoomWaiter(pid);
      const b = transfer(f, f.bMember, f.a.token, 1, key);
      await blocker.query('commit');
      const [one, two] = await Promise.all([a, b]);
      expect(one.statusCode).toBe(200);
      expect(two.statusCode).toBe(200);
      expect(two.json()).toEqual(one.json());
      expect(two.headers['x-idempotent-replay']).toBe('true');
      expect(await counts(f.roomId)).toEqual({ events: 1, audits: 1 });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
  it('uses DB clock after waiting for the room lock', async () => {
    const f = await fixture(),
      blocker = await pool.connect();
    await blocker.query(
      "update rooms set expires_at=clock_timestamp()+interval '300 milliseconds' where id=$1",
      [f.roomId],
    );
    await blocker.query('begin');
    const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('select id from rooms where id=$1 for update', [f.roomId]);
    try {
      const pending = transfer(f);
      await waitForRoomWaiter(pid);
      await pause(350);
      await blocker.query('commit');
      expect((await pending).json().code).toBe('ROOM_EXPIRED');
      await invariant(f.roomId, f.aMember, 1);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
  it('rejects every old-host writer/computation reaching persistence after transfer', async () => {
    const f = await fixture();
    const policy = new RoomPolicy(db);
    const ctx = await policy.requireHost({ type: 'user', id: f.a.id, sessionId: 's' }, f.roomId);
    const authority = hostAuthority(
      { type: 'user', id: f.a.id, sessionId: 's' },
      ctx.room,
      ctx.member,
    );
    expect((await transfer(f)).statusCode).toBe(200);
    const rooms = new RoomsRepository(db),
      plans = new PlansRepository(db),
      suggestions = new SuggestionsRepository(db);
    const event = { eventType: 'test', resourceType: 'room', resourceId: f.roomId, payload: {} };
    const writes = [
      () => rooms.renameRoom(f.roomId, 'Stale', event, authority),
      () => rooms.updateStatus(f.roomId, 'cancelled', event, false, authority),
      () =>
        rooms.applyConstraintVersion({
          roomId: f.roomId,
          memberId: f.aMember,
          expectedVersion: 1,
          authority,
          constraint: { budgetMode: 'total', budgetAmount: 1 },
          event,
        }),
      () =>
        rooms.removeMember({
          roomId: f.roomId,
          memberId: f.bMember,
          removedByMemberId: f.aMember,
          authority,
          event,
        }),
      () =>
        rooms.createInvite(
          {
            roomId: f.roomId,
            codeHash: randomUUID(),
            createdByMemberId: f.aMember,
          },
          authority,
        ),
      () => rooms.revokeInvite(f.roomId, randomUUID(), authority),
      () =>
        plans.createPlanVersion({
          roomId: f.roomId,
          constraintVersion: 1,
          stops: [],
          totals: {} as never,
          events: [event],
          authority,
          claimRoom: { from: 'matching', to: 'ready' },
        }),
      () => plans.setStopLock(randomUUID(), f.roomId, randomUUID(), true, f.aMember, authority),
      () =>
        suggestions.persistScores(
          randomUUID(),
          f.roomId,
          [],
          event,
          { constraintVersion: 1 } as never,
          authority,
        ),
    ];
    for (const write of writes) await expect(write()).rejects.toMatchObject({ code: 'HOST_ONLY' });
    await invariant(f.roomId, f.bMember, 2);
    expect(await counts(f.roomId)).toEqual({ events: 1, audits: 1 });
  });
  it.each([
    ['room_members', "NEW.role='member'"],
    ['room_members', "NEW.role='host'"],
    ['rooms', 'NEW.host_version>1'],
    ['outbox_events', "NEW.event_type='room.host_transferred'"],
    ['audit_logs', "NEW.action='room.host_transferred'"],
    ['idempotency_keys', 'NEW.response_status IS NOT NULL'],
  ])(
    'rolls back mutation, outbox, audit and receipt on injected %s failure (%s)',
    async (table, predicate) => {
      const f = await fixture();
      await pool.query(`create function fail_host_transfer_test() returns trigger language plpgsql as $$begin if ${predicate} then raise exception 'injected';end if;return NEW;end$$;
      create trigger fail_host_transfer_test before insert or update on ${table} for each row execute function fail_host_transfer_test()`);
      try {
        expect((await transfer(f)).statusCode).toBe(500);
        await invariant(f.roomId, f.aMember, 1);
        expect(await counts(f.roomId)).toEqual({ events: 0, audits: 0 });
        expect(
          (
            await pool.query('select key from idempotency_keys where endpoint=$1', [
              `POST /v1/rooms/${f.roomId}/host-transfer`,
            ])
          ).rows,
        ).toHaveLength(0);
      } finally {
        await pool.query(
          `drop trigger fail_host_transfer_test on ${table};drop function fail_host_transfer_test()`,
        );
      }
    },
  );
});

describe('event recipient, retries and normal suppression (#879)', () => {
  it('delayed A→B→C fan-out keeps B as the first event recipient and dedupes retry', async () => {
    const f = await fixture();
    const first = (await transfer(f)).json();
    const second = (await transfer(f, f.cMember, f.b.token, 2)).json();
    const push = new FakePush();
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch(1000);
    await pool.query(
      'update outbox_events set published_at=null,next_attempt_at=null where id in ($1,$2)',
      [first.transferId, second.transferId],
    );
    await worker.dispatchBatch(1000);
    const inbox = (
      await pool.query(
        "select user_id,payload from notifications where kind='host_transferred' and payload->>'resourceId'=$1",
        [f.roomId],
      )
    ).rows;
    expect(inbox.map((r) => r.user_id).sort()).toEqual([f.b.id, f.c.id].sort());
    expect(push.sent.filter((r) => r.data?.roomId === f.roomId).map((r) => r.userIds)).toEqual([
      [f.b.id],
      [f.c.id],
    ]);
  });
  it('master-off suppresses push independently of inbox; removal suppresses delayed delivery', async () => {
    const f = await fixture();
    await pool.query(
      "insert into notification_settings(user_id,push_enabled,source) values($1,false,'explicit') on conflict(user_id) do update set push_enabled=false",
      [f.b.id],
    );
    await transfer(f);
    await transfer(f, f.cMember, f.b.token, 2);
    const push = new FakePush();
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch(1000);
    expect(
      (
        await pool.query(
          "select id from notifications where user_id=$1 and kind='host_transferred'",
          [f.b.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(push.sent.some((r) => r.userIds.includes(f.b.id))).toBe(false);
    const g = await fixture();
    await transfer(g);
    await transfer(g, g.cMember, g.b.token, 2);
    await pool.query('update room_members set removed_at=now() where id=$1', [g.bMember]);
    await worker.dispatchBatch(1000);
    expect(push.sent.some((r) => r.userIds.includes(g.b.id))).toBe(false);
    expect(
      (
        await pool.query(
          "select id from notifications where user_id=$1 and kind='host_transferred'",
          [g.b.id],
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe('ownership preserves inputs and issuer rights (#879)', () => {
  it('preserves seed attribution and invite epoch while moving seed management', async () => {
    const f = await fixture();
    const places = (
      await pool.query(
        "insert into places(name,name_normalized,geom,status) select 'Verified','verified',ST_SetSRID(ST_MakePoint(106.7,10.77),4326),'published' from generate_series(1,3) returning id",
      )
    ).rows.map((r) => r.id as string);
    for (const [i, creator] of [f.aMember, f.bMember, f.cMember].entries())
      await pool.query(
        'insert into room_seed_places(room_id,place_id,created_by_member_id,position) values($1,$2,$3,$4)',
        [f.roomId, places[i], creator, i],
      );
    await pool.query('update rooms set invitation_epoch=7 where id=$1', [f.roomId]);
    const aliases = (
      await pool.query('select id,host_share_id from users where id=ANY($1::uuid[]) order by id', [
        [f.a.id, f.b.id],
      ])
    ).rows;
    expect((await transfer(f)).statusCode).toBe(200);
    expect(
      (await pool.query('select invitation_epoch from rooms where id=$1', [f.roomId])).rows[0]
        .invitation_epoch,
    ).toBe('7');
    expect(
      (
        await pool.query(
          'select id,host_share_id from users where id=ANY($1::uuid[]) order by id',
          [[f.a.id, f.b.id]],
        )
      ).rows,
    ).toEqual(aliases);
    const seeds = await new RoomsRepository(db).listSeedPlaces(f.roomId);
    expect(seeds.map((s) => s.addedByMemberId)).toEqual([f.aMember, f.bMember, f.cMember]);
    const remove = (token: string, placeId: string) =>
      api().inject({
        method: 'DELETE',
        url: `/v1/rooms/${f.roomId}/seed-places/${placeId}`,
        remoteAddress: ip(),
        headers: headers(token),
      });
    const refused = await remove(f.a.token, places[2]!);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('SEED_PLACE_NOT_OWNED');
    expect((await remove(f.b.token, places[2]!)).statusCode).toBe(200);
    expect((await remove(f.a.token, places[0]!)).statusCode).toBe(200);
    expect(
      (await new RoomsRepository(db).listSeedPlaces(f.roomId)).map((s) => s.addedByMemberId),
    ).toEqual([f.bMember]);
  });

  it('preserves versions, stale flags, preferences, votes, seeds and locked optional stops byte-for-byte', async () => {
    const f = await fixture();
    const place = (
      await pool.query(
        "insert into places(name,name_normalized,geom,status) values('Verified','verified',ST_SetSRID(ST_MakePoint(106.7,10.77),4326),'published') returning id",
      )
    ).rows[0].id;
    await pool.query(
      'insert into preference_selections(room_id,member_id,selections,weights,version,is_draft) values($1,$2,\'{"mood":["chill"]}\',\'{"mood":2}\',7,false)',
      [f.roomId, f.bMember],
    );
    await pool.query(
      "insert into votes(room_id,member_id,target_place_id,value) values($1,$2,$3,'star')",
      [f.roomId, f.bMember, place],
    );
    await pool.query(
      'insert into room_seed_places(room_id,place_id,created_by_member_id) values($1,$2,$3)',
      [f.roomId, place, f.aMember],
    );
    const run = (
      await pool.query(
        "insert into suggestion_runs(room_id,constraint_version,engine_version,weights_version,input_snapshot) values($1,1,'test','test','{}') returning id",
        [f.roomId],
      )
    ).rows[0].id;
    await pool.query(
      "insert into candidate_scores(room_id,run_id,place_id,rank,score_micros,components,is_stale) values($1,$2,$3,1,500000,'{}',true)",
      [f.roomId, run, place],
    );
    const plan = (
      await pool.query(
        "insert into plans(room_id,version,constraint_version,totals,status,is_stale) values($1,8,1,'{}','current',true) returning id",
        [f.roomId],
      )
    ).rows[0].id;
    await pool.query(
      'insert into plan_stops(plan_id,place_id,position,duration_minutes,is_locked,is_optional,locked_by_member_id) values($1,$2,0,60,true,true,$3)',
      [plan, place, f.aMember],
    );
    const snapshot = async () => {
      const tables = [
        'room_constraints',
        'preference_selections',
        'votes',
        'room_seed_places',
        'candidate_scores',
        'plans',
      ];
      const result: Record<string, unknown> = {};
      for (const table of tables)
        result[table] = (
          await pool.query(`select to_jsonb(t) row from ${table} t where room_id=$1 order by id`, [
            f.roomId,
          ])
        ).rows;
      result.stops = (
        await pool.query('select to_jsonb(t) row from plan_stops t where plan_id=$1', [plan])
      ).rows;
      result.members = (
        await pool.query(
          "select to_jsonb(t)-'role' row from room_members t where room_id=$1 order by id",
          [f.roomId],
        )
      ).rows;
      return result;
    };
    const before = await snapshot();
    expect((await transfer(f)).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
    const creator = (
      await pool.query('select created_by_user_id from rooms where id=$1', [f.roomId])
    ).rows[0].created_by_user_id;
    expect(creator).toBe(f.a.id);
    await expect(
      pool.query('update rooms set created_by_user_id=$2 where id=$1', [f.roomId, f.b.id]),
    ).rejects.toThrow();
  });
  it('keeps canonical-link creator revocation while moving issuance and host management', async () => {
    const f = await fixture();
    const issued = await api().inject({
      method: 'POST',
      url: '/v1/share-links',
      headers: headers(f.a.token),
      payload: { type: 'ROOM_INVITE', entityId: f.roomId },
    });
    expect(issued.statusCode).toBe(201);
    const slug = new URL(issued.json().url).pathname.split('/').at(-1)!;
    expect((await transfer(f)).statusCode).toBe(200);
    const forbidden = await api().inject({
      method: 'POST',
      url: '/v1/share-links',
      headers: headers(f.a.token),
      payload: { type: 'ROOM_INVITE', entityId: f.roomId },
    });
    expect(forbidden.statusCode).toBe(403);
    const revoked = await api().inject({
      method: 'DELETE',
      url: `/v1/share-links/${slug}`,
      headers: headers(f.a.token),
    });
    expect(revoked.statusCode).toBe(200);
    const row = (
      await pool.query('select revoked_at from share_links where id=$1', [issued.json().id])
    ).rows[0];
    expect(row.revoked_at).not.toBeNull();
  });
});

async function waitForAdvisoryWaiter(excludedPid: number) {
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "select count(*)::int n from pg_stat_activity where pid<>$1 and wait_event_type='Lock' and query like '%pg_advisory_xact_lock%'",
            [excludedPid],
          )
        ).rows[0].n,
      { timeout: 2000, interval: 10 },
    )
    .toBeGreaterThan(0);
}
describe('identity changes under the account fence (#879)', () => {
  it('refuses an account erased after discovery without deadlocking', async () => {
    const f = await fixture(),
      blocker = await pool.connect();
    await blocker.query('begin');
    const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      'assistant:' + f.b.id,
    ]);
    try {
      const pending = transfer(f);
      await waitForAdvisoryWaiter(pid);
      await blocker.query("update users set status='deleted',deleted_at=now() where id=$1", [
        f.b.id,
      ]);
      await blocker.query('commit');
      expect((await pending).json().code).toBe('HOST_TRANSFER_TARGET_INELIGIBLE');
      await invariant(f.roomId, f.aMember, 1);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
  it('rolls back and rediscovers account locks when a guest is claimed after discovery', async () => {
    const f = await fixture();
    const joined = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: f.room.code, displayName: 'Guest' },
    });
    expect(joined.statusCode).toBe(201);
    const guest = joined.json();
    const target = (
      await pool.query('select id from room_members where guest_session_id=$1', [
        guest.guestSessionId,
      ])
    ).rows[0].id;
    const blocker = await pool.connect();
    await blocker.query('begin');
    const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      'assistant:' + f.a.id,
    ]);
    try {
      const pending = transfer(f, target);
      await waitForAdvisoryWaiter(pid);
      const claimed = await api().inject({
        method: 'POST',
        url: '/v1/auth/register',
        remoteAddress: ip(),
        payload: {
          email: randomUUID() + '@gogo.test',
          displayName: 'Claimed',
          password: 'Sufficiently-long-pw1!',
          claimGuestToken: guest.guestToken,
        },
      });
      expect(claimed.statusCode).toBe(201);
      await blocker.query('commit');
      expect((await pending).statusCode).toBe(200);
      await invariant(f.roomId, target, 2);
      expect(await counts(f.roomId)).toEqual({ events: 1, audits: 1 });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
});

describe('deferred host notification audience (#879)', () => {
  it.each(['eligible', 'removed', 'deleted', 'master_off'] as const)(
    'rechecks %s without redirecting the original event to C',
    async (outcome) => {
      const { mutateNotificationSettings } =
        await import('../../../libs/modules/notifications/application/category-preferences.js');
      const { quietHoursEnd } =
        await import('../../../libs/modules/notifications/domain/quiet-hours.js');
      const zone = Array.from(
        { length: 25 },
        (_, i) => `Etc/GMT${i < 12 ? '-' : '+'}${Math.abs(i - 12)}`,
      ).find((timezone) => quietHoursEnd(new Date(), { enabled: true, timezone }));
      expect(zone).toBeTruthy();
      const f = await fixture();
      await mutateNotificationSettings(db, f.b.id, {
        quietHours: { enabled: true, timezone: zone! },
      });
      const first = (await transfer(f)).json();
      const push = new FakePush(),
        worker = new OutboxDispatcher(db, push);
      await worker.dispatchBatch(1000);
      const read = async () =>
        (
          await pool.query(
            'select status from notification_push_deliveries where event_id=$1 and user_id=$2',
            [first.transferId, f.b.id],
          )
        ).rows[0]?.status;
      expect(await read()).toBe('deferred');
      expect((await transfer(f, f.cMember, f.b.token, 2)).statusCode).toBe(200);
      await mutateNotificationSettings(db, f.b.id, {
        quietHours: { enabled: false },
        ...(outcome === 'master_off' ? { pushEnabled: false } : {}),
      });
      if (outcome === 'removed')
        await pool.query('update room_members set removed_at=now() where id=$1', [f.bMember]);
      if (outcome === 'deleted')
        await pool.query("update users set status='deleted',deleted_at=now() where id=$1", [
          f.b.id,
        ]);
      await pool.query(
        'update notification_push_deliveries set deferred_until=now() where event_id=$1',
        [first.transferId],
      );
      await worker.dispatchDeferredBatch(1000);
      expect(await read()).toBe(outcome === 'eligible' ? 'sent' : 'suppressed');
      const sent = push.sent.filter((p) => p.data?.notificationId === first.transferId);
      expect(sent.map((p) => p.userIds)).toEqual(outcome === 'eligible' ? [[f.b.id]] : []);
      expect(sent.some((p) => p.userIds.includes(f.c.id))).toBe(false);
    },
  );
});

describe('receipt wait bounds and coherent snapshots (#879)', () => {
  it('rolls back a timed-out claim and later completes the same key', async () => {
    const f = await fixture(),
      blocker = await pool.connect(),
      key = randomUUID();
    await blocker.query('begin');
    await blocker.query('select id from rooms where id=$1 for update', [f.roomId]);
    try {
      const result = await transfer(f, f.bMember, f.a.token, 1, key);
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        code: 'IDEMPOTENT_REQUEST_IN_FLIGHT',
        retryable: true,
      });
      expect(result.headers['retry-after']).toBe('1');
      await blocker.query('commit');
      const retry = await transfer(f, f.bMember, f.a.token, 1, key);
      expect(retry.statusCode).toBe(200);
      await invariant(f.roomId, f.bMember, 2);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
  it('reads ownership/member facts from one snapshot even when transfer commits between reads', async () => {
    const f = await fixture(),
      repo = new RoomsRepository(db);
    let started!: () => void, release!: () => void;
    const readStarted = new Promise<void>((r) => {
        started = r;
      }),
      continueRead = new Promise<void>((r) => {
        release = r;
      });
    const reading = repo.readSummary(async (snapshot, policy) => {
      const ctx = await policy.requireMember(
        { type: 'user', id: f.a.id, sessionId: 's' },
        f.roomId,
      );
      started();
      await continueRead;
      return { ctx, members: await snapshot.listMembers(f.roomId) };
    });
    try {
      await readStarted;
      expect((await transfer(f)).statusCode).toBe(200);
      release();
      const read = await reading;
      expect(read.ctx.room.hostVersion).toBe(1);
      expect(read.ctx.member.role).toBe('host');
      expect(read.members.filter((m) => m.role === 'host').map((m) => m.id)).toEqual([f.aMember]);
      await invariant(f.roomId, f.bMember, 2);
    } finally {
      release();
      await reading;
    }
  });
});
