import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { IdentityRepository } from '../../../libs/modules/identity/infrastructure/identity.repository';
import {
  RoomsService,
  type ConstraintInput,
} from '../../../libs/modules/rooms/application/rooms.service';
import { RoomPolicy } from '../../../libs/modules/rooms/presentation/room-policy';
import { PreferencesService } from '../../../libs/modules/preferences/application/preferences.service';
import {
  ROOM_EVENT_BUS,
  type RoomEventBus,
} from '../../../libs/modules/realtime/application/room-event-bus';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import { hostAuthority } from '../../../libs/modules/rooms/domain/host-authority';
import { mutateSeedPlaces } from '../../../libs/modules/rooms/infrastructure/seed-mutation';
import { SuggestionsRepository } from '../../../libs/modules/suggestions/infrastructure/suggestions.repository';
import { seedScopes } from '../../../libs/modules/rooms/infrastructure/seed-idempotency';
import type { Actor } from '../../../libs/modules/identity/domain/actor';
import { CmsCatalogService } from '../../../libs/modules/cms/application/cms-catalog.service';
import { PlaceDedupService } from '../../../libs/modules/ingestion/application/place-dedup.service';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let racePool: Pool;
let otherPool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: string[];
type Account = { token: string; actor: Actor };
let accounts: Account[];
let ipc = 0;
const api = () => app.getHttpAdapter().getInstance();
const ip = () => `10.78.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
function send(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
  token: string | null,
  url: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  return api().inject({
    method,
    url,
    remoteAddress: ip(),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}
async function fixture(
  type: 'couple' | 'group' = 'group',
  constraint: Partial<ConstraintInput> = {},
  seeds: string[] = [],
) {
  const [host, member, other] = accounts;
  // Exercise real creation/admission services without consuming unrelated per-actor
  // HTTP room-creation/invite rate limits across this focused seed matrix.
  const room = await app.get(RoomsService).createRoom(host!.actor, {
    type,
    decisionMode: type === 'couple' ? 'match' : 'vote',
    participantCount: type === 'couple' ? 2 : 4,
    constraint: {
      budgetMode: type === 'couple' ? 'total' : 'per_person',
      budgetAmount: 300000,
      ...constraint,
    },
    seedPlaceIds: seeds,
  });
  const invite = await app.get(RoomsService).createInvite(host!.actor, room.id);
  for (const a of type === 'couple' ? [member!] : [member!, other!]) {
    const joined = await send('POST', a.token, '/v1/rooms/join', {
      inviteCode: invite.code,
    });
    expect(joined.statusCode, joined.body).toBe(201);
  }
  const members = await db
    .select()
    .from(schema.roomMembers)
    .where(eq(schema.roomMembers.roomId, room.id));
  return {
    roomId: room.id as string,
    host: host!,
    member: member!,
    other: other!,
    members,
    invite: invite.code as string,
    authority: hostAuthority(
      host!.actor,
      room,
      members.find((m) => m.userId === host!.actor.id)!,
    ),
    hostId: members.find((m) => m.userId === host!.actor.id)!.id,
    memberId: members.find((m) => m.userId === member!.actor.id)!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const add = (f: Fixture, a: Account, ids: string[], key?: string) =>
  send('POST', a.token, `/v1/rooms/${f.roomId}/seed-places`, { placeIds: ids }, key);
const remove = (f: Fixture, a: Account, id: string, key?: string) =>
  send('DELETE', a.token, `/v1/rooms/${f.roomId}/seed-places/${id}`, undefined, key);
async function summary(f: Fixture) {
  return (await send('GET', f.host.token, `/v1/rooms/${f.roomId}`)).json();
}
async function effects(f: Fixture) {
  return {
    version: (await summary(f)).constraintVersion,
    seeds: await db
      .select()
      .from(schema.roomSeedPlaces)
      .where(eq(schema.roomSeedPlaces.roomId, f.roomId)),
    events: await db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.resourceId, f.roomId),
          eq(schema.outboxEvents.eventType, 'room.seed_places_changed'),
        ),
      ),
    audits: await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, f.roomId)),
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('seed_places_878')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  racePool = new Pool({
    connectionString: container.getConnectionUri(),
    max: 1,
    application_name: 'seed-878-race',
  });
  otherPool = new Pool({
    connectionString: container.getConnectionUri(),
    max: 2,
    application_name: 'seed-878-other',
  });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  places = (
    await db
      .insert(schema.places)
      .values(
        Array.from({ length: 14 }, (_, i) => ({
          name: `Seed ${i}`,
          nameNormalized: `seed ${i}`,
          status: 'published' as const,
          geom: { x: 106.7, y: 10.776 },
        })),
      )
      .returning()
  ).map((p) => p.id);
  await db.insert(schema.taxonomies).values({ kind: 'mood', key: 'chill' });
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  accounts = [];
  for (let i = 0; i < 4; i++) {
    const r = await send('POST', null, '/v1/auth/register', {
      email: `seed878-${i}@gogo.test`,
      password: 'Sufficiently-long-pw1!',
      displayName: `Member ${i}`,
    });
    expect(r.statusCode, r.body).toBe(201);
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, `seed878-${i}@gogo.test`));
    accounts.push({
      token: r.json().accessToken,
      actor: { type: 'user', id: user!.id, sessionId: 'unused-direct-repository' },
    });
  }
}, 180000);
afterAll(async () => {
  await app?.close();
  await racePool?.end();
  await otherPool?.end();
  await pool?.end();
  await container?.stop();
});

describe('#878 HTTP policy, ownership and compatibility', () => {
  it.each(['couple', 'group'] as const)(
    '%s: member contributes, host manages all; DTO attribution is membership-only',
    async (type) => {
      const f = await fixture(type, {}, [places[0]!]);
      const posted = await add(f, f.member, [places[1]!]);
      expect(posted.statusCode, posted.body).toBe(200);
      expect(posted.json().constraintVersion).toBe(2);
      const list = posted.json().seedPlaces;
      expect(list[0]).toEqual({
        placeId: places[0],
        name: 'Seed 0',
        position: 0,
        addedByMemberId: f.hostId,
      });
      expect(list[1].addedByMemberId).toBe(f.memberId);
      expect((await summary(f)).seedPlaces).toEqual(list);
      expect(JSON.stringify(list)).not.toMatch(/userId|guestSessionId|email|token|origin/i);
      expect((await remove(f, f.member, places[0]!)).json().code).toBe('SEED_PLACE_NOT_OWNED');
      expect((await remove(f, f.member, places[1]!)).statusCode).toBe(200);
      expect((await remove(f, f.host, places[0]!)).statusCode).toBe(200);
    },
  );
  it.each(['matching', 'ready', 'active', 'completed', 'cancelled', 'expired', 'overdue'])(
    '%s refuses both endpoints for account roles, before ownership/replay',
    async (status) => {
      const f = await fixture();
      await add(f, f.host, [places[0]!], `state-${status}-1234`);
      await db
        .update(schema.rooms)
        .set(status === 'overdue' ? { expiresAt: new Date(0) } : { status: status as 'matching' })
        .where(eq(schema.rooms.id, f.roomId));
      for (const a of [f.host, f.member, f.other])
        for (const res of [
          await add(f, a, [places[0]!], `state-${status}-1234`),
          await remove(f, a, places[0]!),
        ]) {
          expect(res.statusCode).toBe(409);
          expect(res.json().code).toBe('ROOM_NOT_EDITABLE');
        }
    },
  );
  it('guest is forbidden in collecting/matching, and cross-room scope wins', async () => {
    const f = await fixture();
    const joined = await send('POST', null, '/v1/rooms/join/guest', {
      inviteCode: f.invite,
      displayName: 'Guest',
    });
    expect(joined.statusCode, joined.body).toBe(201);
    const token = joined.json().accessToken;
    // 0105's room_members_host_user CHECK and single-host triggers make a
    // guest host unreachable. Exercise the valid guest membership in both states.
    for (const status of ['collecting', 'matching'] as const) {
      await db.update(schema.rooms).set({ status }).where(eq(schema.rooms.id, f.roomId));
      for (const method of ['POST', 'DELETE'] as const) {
        const res = await send(
          method,
          token,
          `/v1/rooms/${f.roomId}/seed-places${method === 'DELETE' ? `/${places[0]}` : ''}`,
          method === 'POST' ? { placeIds: [places[0]] } : undefined,
        );
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('SEED_PLACES_FORBIDDEN');
      }
    }
    const other = await fixture();
    expect(
      (
        await send('POST', token, `/v1/rooms/${other.roomId}/seed-places`, {
          placeIds: [places[0]],
        })
      ).json().code,
    ).toBe('ROOM_SCOPE_VIOLATION');
  });
  it('outsider, removed member, and invalid session cannot mutate or replay', async () => {
    const f = await fixture();
    expect((await add(f, accounts[3]!, [places[0]!])).json().code).toBe('NOT_A_MEMBER');
    await add(f, f.member, [places[0]!], 'removed-replay-123');
    await db
      .update(schema.roomMembers)
      .set({ removedAt: new Date() })
      .where(eq(schema.roomMembers.id, f.memberId));
    expect((await add(f, f.member, [places[0]!], 'removed-replay-123')).json().code).toBe(
      'NOT_A_MEMBER',
    );
    expect(
      (await send('POST', null, `/v1/rooms/${f.roomId}/seed-places`, { placeIds: [places[0]] }))
        .statusCode,
    ).toBe(401);
    expect((await remove(f, f.host, places[0]!)).statusCode).toBe(200);
    await db.insert(schema.roomMembers).values({
      roomId: f.roomId,
      userId: f.member.actor.id,
      displayName: 'Rejoined',
      role: 'member',
    });
    await add(f, f.host, [places[1]!]);
    expect((await remove(f, f.member, places[1]!)).json().code).toBe('SEED_PLACE_NOT_OWNED');
  });
  it('normalizes duplicates and ignores spoofed attribution; invalid batch rolls back', async () => {
    const f = await fixture();
    expect(
      (
        await send('POST', f.member.token, `/v1/rooms/${f.roomId}/seed-places`, {
          placeIds: [places[0]!.toUpperCase(), places[0]],
          addedByMemberId: f.hostId,
        })
      ).statusCode,
    ).toBe(200);
    expect((await summary(f)).seedPlaces[0].addedByMemberId).toBe(f.memberId);
    const before = await effects(f);
    expect((await add(f, f.host, [places[0]!, places[0]!])).json().constraintVersion).toBe(2);
    expect(await effects(f)).toEqual(before);
    const invalid = await add(f, f.member, [places[1]!, randomUUID()]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_SEED_PLACE');
    expect(await effects(f)).toEqual(before);
    for (const ids of [[], Array(11).fill(places[0]), ['bad-uuid']])
      expect((await add(f, f.host, ids)).statusCode).toBe(400);
  });
  it('enforces 10 across all contributors and retains legacy over-quota rows', async () => {
    const f = await fixture();
    expect((await add(f, f.host, places.slice(0, 9))).statusCode).toBe(200);
    expect((await add(f, f.member, places.slice(8, 10))).statusCode).toBe(200);
    expect((await add(f, f.other, places.slice(10, 12))).json().code).toBe(
      'SEED_PLACE_LIMIT_REACHED',
    );
    await db.insert(schema.roomSeedPlaces).values({
      roomId: f.roomId,
      placeId: places[10]!,
      position: 10,
      createdByMemberId: f.hostId,
    });
    expect((await add(f, f.member, [places[0]!])).statusCode).toBe(200);
    expect((await add(f, f.member, [places[11]!])).json().code).toBe('SEED_PLACE_LIMIT_REACHED');
    expect((await remove(f, f.host, places[10]!)).statusCode).toBe(200);
    expect((await add(f, f.member, [places[11]!])).json().code).toBe('SEED_PLACE_LIMIT_REACHED');
    await remove(f, f.host, places[9]!);
    expect((await add(f, f.member, [places[11]!])).statusCode).toBe(200);
  });
  it('same key replays normalized body; changed body/resource is 422; DELETE replay preserves re-add', async () => {
    const f = await fixture();
    const first = await add(f, f.member, [places[1]!, places[0]!], 'normalized-key-123');
    expect(first.statusCode).toBe(200);
    const snapshot = await effects(f);
    const replay = await add(
      f,
      f.member,
      [places[0]!.toUpperCase(), places[1]!, places[1]!],
      'normalized-key-123',
    );
    expect(replay.json()).toEqual(first.json());
    expect(await effects(f)).toEqual(snapshot);
    expect((await add(f, f.member, [places[2]!], 'normalized-key-123')).statusCode).toBe(422);
    const other = await fixture();
    expect((await add(other, other.member, [places[0]!], 'normalized-key-123')).statusCode).toBe(
      422,
    );
    const deleted = await remove(f, f.member, places[0]!, 'delete-key-123');
    await add(f, f.other, [places[0]!]);
    const prior = await effects(f);
    expect((await remove(f, f.member, places[0]!, 'delete-key-123')).json()).toEqual(
      deleted.json(),
    );
    expect(await effects(f)).toEqual(prior);
    expect((await remove(f, f.member, places[1]!, 'delete-key-123')).statusCode).toBe(422);
    expect((await add(f, f.member, [places[3]!], 'bad key')).json().code).toBe(
      'INVALID_IDEMPOTENCY_KEY',
    );
  });
  it('refuses unbound legacy replay without purging or mutating', async () => {
    const f = await fixture();
    const scope = seedScopes({
      actor: f.host.actor,
      key: 'legacy-seed-key',
      operation: 'remove',
      roomId: f.roomId,
      placeIds: [places[0]!],
    }).legacy;
    await db.insert(schema.idempotencyKeys).values({
      key: scope.storedKey,
      actorId: scope.actorScope,
      endpoint: scope.endpoint,
      requestHash: 'old-body-hash',
      responseStatus: 200,
      responseBody: { seedPlaces: [] },
      expiresAt: new Date(Date.now() + 86400000),
    });
    expect((await remove(f, f.host, places[0]!, 'legacy-seed-key')).json().code).toBe(
      'IDEMPOTENCY_CONTEXT_CHANGED',
    );
    expect(
      await db
        .select()
        .from(schema.idempotencyKeys)
        .where(eq(schema.idempotencyKeys.key, scope.storedKey)),
    ).toHaveLength(1);
    expect((await effects(f)).version).toBe(1);
  });
  it('delete does not depend on place publication or area and missing seed is no-op', async () => {
    const f = await fixture();
    await add(f, f.member, [places[0]!]);
    await db.update(schema.places).set({ status: 'draft' }).where(eq(schema.places.id, places[0]!));
    try {
      expect((await remove(f, f.member, places[0]!)).statusCode).toBe(200);
      const before = await effects(f);
      expect((await remove(f, f.member, places[0]!)).statusCode).toBe(200);
      expect(await effects(f)).toEqual(before);
      expect((await add(f, f.host, [places[0]!])).json().code).toBe('INVALID_SEED_PLACE');
    } finally {
      await db
        .update(schema.places)
        .set({ status: 'published' })
        .where(eq(schema.places.id, places[0]!));
    }
  });
});

/** Wait for a real PostgreSQL lock wait, never an elapsed-time assumption. */
async function waitBlocked(applicationName = 'seed-878-race') {
  for (let i = 0; i < 1000; i++) {
    const r = await pool.query(
      'select 1 from pg_stat_activity where application_name=$1 and cardinality(pg_blocking_pids(pid)) > 0',
      [applicationName],
    );
    if (r.rowCount) return;
  }
  throw new Error('Expected PostgreSQL lock barrier was not reached');
}
async function roomBarrier(
  f: Fixture,
  run: () => Promise<unknown>,
  first: (c: PoolClient) => Promise<void>,
) {
  const c = await pool.connect();
  await c.query('begin');
  await c.query('select id from rooms where id=$1 for update', [f.roomId]);
  const pending = run();
  try {
    await waitBlocked();
    await first(c);
    await c.query('commit');
    return await pending;
  } catch (e) {
    await c.query('rollback');
    await pending.catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const racedb = () => drizzle(racePool, { schema });
const mutate = (
  f: Fixture,
  a = f.member,
  ids = [places[0]!],
  operation: 'add' | 'remove' = 'add',
  key?: string,
) =>
  mutateSeedPlaces(racedb(), { actor: a.actor, roomId: f.roomId, operation, placeIds: ids, key });

describe('#878 transaction, invalidation and PostgreSQL races', () => {
  it('two members adding the same place or competing for the last slot serialize', async () => {
    const f = await fixture();
    await writerBarrier(
      'room_seed_places',
      'seed-878-race',
      () => mutate(f),
      'seed-878-other',
      () =>
        mutateSeedPlaces(otherdb(), {
          actor: f.other.actor,
          roomId: f.roomId,
          operation: 'add',
          placeIds: [places[0]!],
        }),
    );
    const state = await effects(f);
    expect(state.seeds).toHaveLength(1);
    expect(state.seeds[0]!.createdByMemberId).toBe(f.memberId);
    expect(state.version).toBe(2);
    expect(state.events).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    await add(f, f.host, places.slice(1, 9));
    const attempts = await writerBarrier(
      'room_seed_places',
      'seed-878-race',
      () => mutate(f, f.member, [places[9]!]),
      'seed-878-other',
      () =>
        mutateSeedPlaces(otherdb(), {
          actor: f.other.actor,
          roomId: f.roomId,
          operation: 'add',
          placeIds: [places[10]!],
        }).catch((e: Error & { code: string }) => e),
    );
    expect(attempts[1]).toMatchObject({ code: 'SEED_PLACE_LIMIT_REACHED' });
    expect((await effects(f)).seeds).toHaveLength(10);
  });
  it.each(['matching', 'kick', 'constraint'] as const)(
    '%s wins the room lock; seed sees current authority/scope',
    async (winner) => {
      const f = await fixture();
      const result = await roomBarrier(
        f,
        () => mutate(f).catch((e: Error & { code: string }) => e),
        async (c) => {
          if (winner === 'matching')
            await c.query("update rooms set status='matching' where id=$1", [f.roomId]);
          if (winner === 'kick')
            await c.query('update room_members set removed_at=now() where id=$1', [f.memberId]);
          if (winner === 'constraint')
            await c.query(
              "update room_constraints set area_key='legacy-unresolved' where room_id=$1 and version=1",
              [f.roomId],
            );
        },
      );
      expect(result).toMatchObject({
        code:
          winner === 'matching'
            ? 'ROOM_NOT_EDITABLE'
            : winner === 'kick'
              ? 'NOT_A_MEMBER'
              : 'ROOM_AREA_UNRESOLVED',
      });
      expect((await effects(f)).seeds).toHaveLength(0);
    },
  );
  it('same key concurrent requests produce one event/version and exact committed replay', async () => {
    const f = await fixture();
    const [one, two] = await writerBarrier(
      'room_seed_places',
      'seed-878-race',
      () => mutate(f, f.member, [places[0]!], 'add', 'race-replay-123'),
      'seed-878-other',
      () =>
        mutateSeedPlaces(otherdb(), {
          actor: f.member.actor,
          roomId: f.roomId,
          operation: 'add',
          placeIds: [places[0]!],
          key: 'race-replay-123',
        }),
    );
    expect(one.body).toEqual(two.body);
    expect([one.outcome, two.outcome].sort()).toEqual(['changed', 'replay']);
    const state = await effects(f);
    expect(state.version).toBe(2);
    expect(state.events).toHaveLength(1);
  });
  it.each([
    'room_seed_places',
    'candidate_scores',
    'audit_logs',
    'outbox_events',
    'idempotency_keys',
  ] as const)('fault in %s rolls back seeds, revision, audit, outbox and replay', async (table) => {
    const f = await fixture();
    // Statement triggers fire even when stale marking matches zero rows.
    await pool.query(
      "create or replace function seed878_fail() returns trigger language plpgsql as $$ begin raise exception 'seed878 injected failure'; end $$",
    );
    const operation =
      table === 'candidate_scores' || table === 'idempotency_keys' ? 'update' : 'insert';
    await pool.query(
      `create trigger seed878_fail before ${operation} on ${table} for each statement execute function seed878_fail()`,
    );
    try {
      expect((await add(f, f.member, [places[0]!], `atomic-${table}-123`)).statusCode).toBe(500);
    } finally {
      await pool.query(`drop trigger seed878_fail on ${table}`);
    }
    const state = await effects(f);
    expect(state.version).toBe(1);
    expect(state.seeds).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.roomConstraints)
        .where(eq(schema.roomConstraints.roomId, f.roomId)),
    ).toHaveLength(1);
    expect((await add(f, f.member, [places[0]!], `atomic-${table}-123`)).statusCode).toBe(200);
  });
});

describe('#878 geographic and derived data invariants', () => {
  it('accepts the inclusive PostGIS boundary, refuses outside, and fails unresolved legacy scopes', async () => {
    const f = await fixture('group', { originLat: 10.776, originLng: 106.7, radiusM: 100 });
    // Direct/inverse geodesic round trips can land on either side of 100 m.
    // Pick a projected boundary that PostGIS itself includes, as required by
    // shape §2.5; verify its measured distance and the just-inside exclusion.
    // Never widen the production radius to compensate for fixture rounding.
    const result = await pool.query(`with origin as (
      select ST_SetSRID(ST_MakePoint(106.7,10.776),4326)::geography as geom
    ), boundary as (
      select projected.geom from origin
      cross join generate_series(0,15) as bearing(i)
      cross join lateral (select ST_Project(origin.geom,100,bearing.i*pi()/8) as geom) projected
      where ST_DWithin(projected.geom,origin.geom,100)
      order by bearing.i limit 1
    ) insert into places(name,name_normalized,status,geom)
      select 'Boundary','boundary','published'::place_status,geom::geometry from boundary
      union all
      select 'Outside','outside','published'::place_status,ST_Project(geom,101,0)::geometry from origin
      returning id,name`);
    expect(result.rows).toHaveLength(2);
    const boundaryId = result.rows.find((p) => p.name === 'Boundary')!.id;
    const outsideId = result.rows.find((p) => p.name === 'Outside')!.id;
    const geometry = await pool.query(
      `select
      ST_Distance(geom::geography,ST_SetSRID(ST_MakePoint(106.7,10.776),4326)::geography) as distance,
      ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint(106.7,10.776),4326)::geography,99.999999) as strictly_inside
      from places where id=$1`,
      [boundaryId],
    );
    expect(geometry.rows[0].distance).toBe(100);
    expect(geometry.rows[0].strictly_inside).toBe(false);
    const accepted = await add(f, f.member, [boundaryId]);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await add(f, f.member, [outsideId])).json().code).toBe('SEED_PLACE_OUT_OF_AREA');
    for (const constraint of [{ areaKey: 'legacy' }, { radiusM: 100 }]) {
      const legacy = await fixture('group', constraint);
      expect((await add(legacy, legacy.member, [places[0]!])).json().code).toBe(
        'ROOM_AREA_UNRESOLVED',
      );
    }
  });
  it('copies the privacy-erased current revision, stales scores/plans, preserves stops/votes/preferences and fences an old ranking', async () => {
    const f = await fixture('group', { originLat: 10.776, originLng: 106.7, radiusM: 1000 });
    const [pref] = await db
      .insert(schema.preferenceSelections)
      .values({ roomId: f.roomId, memberId: f.memberId, selections: { mood: ['chill'] } })
      .returning();
    const suggestions = new SuggestionsRepository(db);
    const snapshot = await suggestions.buildSnapshot(f.roomId);
    const run = await suggestions.createRun({
      roomId: f.roomId,
      constraintVersion: 1,
      engineVersion: 'test',
      weightsVersion: 'test',
      inputSnapshot: snapshot,
    });
    await db.insert(schema.candidateScores).values({
      roomId: f.roomId,
      runId: run.id,
      placeId: places[0]!,
      rank: 1,
      scoreMicros: 1,
      components: {},
    });
    const [plan] = await db
      .insert(schema.plans)
      .values({
        roomId: f.roomId,
        version: 1,
        status: 'current',
        constraintVersion: 1,
        totals: {
          costMin: 0,
          costMax: 0,
          currency: 'VND',
          durationMinutes: 60,
          travelDistanceM: 0,
          overBudget: false,
          uncertain: false,
        },
      })
      .returning();
    const [stop] = await db
      .insert(schema.planStops)
      .values({
        planId: plan!.id,
        placeId: places[0]!,
        position: 0,
        durationMinutes: 60,
        isLocked: true,
      })
      .returning();
    const [vote] = await db
      .insert(schema.votes)
      .values({ roomId: f.roomId, memberId: f.memberId, targetPlaceId: places[0]!, value: 'yes' })
      .returning();
    // The privacy job uses the same room lock; represent its already-committed clearing.
    await db
      .update(schema.roomConstraints)
      .set({ originLat: null, originLng: null, originText: null, radiusM: null })
      .where(eq(schema.roomConstraints.roomId, f.roomId));
    expect((await add(f, f.member, [places[1]!])).statusCode).toBe(200);
    const [current] = await db
      .select()
      .from(schema.roomConstraints)
      .where(
        and(eq(schema.roomConstraints.roomId, f.roomId), eq(schema.roomConstraints.version, 2)),
      );
    expect(current).toMatchObject({
      originLat: null,
      originLng: null,
      originText: null,
      createdByMemberId: f.memberId,
    });
    expect(
      (
        await db
          .select()
          .from(schema.candidateScores)
          .where(eq(schema.candidateScores.runId, run.id))
      )[0]!.isStale,
    ).toBe(true);
    expect(
      (await db.select().from(schema.plans).where(eq(schema.plans.id, plan!.id)))[0]!.isStale,
    ).toBe(true);
    expect(
      (await db.select().from(schema.planStops).where(eq(schema.planStops.id, stop!.id)))[0],
    ).toEqual(stop);
    expect((await db.select().from(schema.votes).where(eq(schema.votes.id, vote!.id)))[0]).toEqual(
      vote,
    );
    expect(
      (
        await db
          .select()
          .from(schema.preferenceSelections)
          .where(eq(schema.preferenceSelections.id, pref!.id))
      )[0],
    ).toEqual(pref);
    await expect(
      suggestions.persistScores(
        run.id,
        f.roomId,
        [],
        {
          eventType: 'suggestions.generated',
          resourceType: 'room',
          resourceId: f.roomId,
          payload: {},
        },
        snapshot,
        f.authority,
      ),
    ).rejects.toMatchObject({ code: 'STALE_SUGGESTIONS' });
    const state = await effects(f);
    expect(state.events[0]).toMatchObject({
      actorId: f.memberId,
      eventVersion: 1,
      payloadSchemaVersion: 1,
      payload: {
        operation: 'add',
        addedPlaceIds: [places[1]],
        removedPlaceIds: [],
        constraintVersion: 2,
      },
    });
    expect(state.audits[0]).toMatchObject({
      actorId: f.memberId,
      ipAddress: null,
      action: 'room.seed_places_added',
    });
    expect(JSON.stringify(state.events[0]!.payload)).not.toMatch(
      /email|token|origin|userId|guestSessionId/,
    );
  });
});

/** Hold a transaction inside the actual writer while a competing production
 * writer reaches its room lock. Both waits are observed in pg_blocking_pids. */
async function writerBarrier<A, B>(
  table:
    'room_seed_places' | 'preference_selections' | 'room_constraints' | 'room_members' | 'places',
  firstApp: string,
  first: () => Promise<A>,
  secondApp: string,
  second: () => Promise<B>,
) {
  const c = await pool.connect();
  await c.query('select pg_advisory_lock(878123)');
  const op = ['preference_selections', 'room_members', 'places'].includes(table)
    ? 'update'
    : 'insert';
  await c.query(
    `create or replace function seed878_pause() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(878123); return new; end $$`,
  );
  await c.query(
    `create trigger seed878_pause before ${op} on ${table} for each row execute function seed878_pause()`,
  );
  let one: Promise<A> | undefined;
  let two: Promise<B> | undefined;
  try {
    one = first();
    // Keep early failures attached while the controller observes the lock
    // waits; Promise.all below still propagates the original failure.
    void one.catch(() => undefined);
    await waitBlocked(firstApp);
    two = second();
    void two.catch(() => undefined);
    await waitBlocked(secondApp);
    await c.query('select pg_advisory_unlock(878123)');
    return await Promise.all([one, two]);
  } finally {
    await c.query('select pg_advisory_unlock(878123)');
    await Promise.allSettled([one, two]);
    await c.query(`drop trigger seed878_pause on ${table}`);
    c.release();
  }
}
const otherdb = () => drizzle(otherPool, { schema });
function preferences() {
  const d = otherdb();
  return new PreferencesService(d, new RoomPolicy(d), app.get<RoomEventBus>(ROOM_EVENT_BUS));
}
async function prepareLastPreference(f: Fixture) {
  for (const m of f.members) {
    await db.insert(schema.preferenceSelections).values({
      roomId: f.roomId,
      memberId: m.id,
      selections: { mood: ['chill'] },
      isDraft: m.id === f.memberId,
    });
    await db
      .update(schema.roomMembers)
      .set({ selectionStatus: m.id === f.memberId ? 'pending' : 'completed' })
      .where(eq(schema.roomMembers.id, m.id));
  }
}
describe('#878 F-01 CMS merge versus seed mutation', () => {
  it.each(['add', 'remove'] as const)(
    'merge holds catalog locks before %s: returns current seeds with no mutation effects',
    async (operation) => {
      // Use isolated places: merge archives D permanently. C sorts before D so
      // the POST waits specifically on C, reproducing Astra's stale-set race.
      const [canonicalId, duplicateId] = [randomUUID(), randomUUID()].sort() as [string, string];
      await db.insert(schema.places).values(
        [canonicalId, duplicateId].map((id) => ({
          id,
          name: id === canonicalId ? 'Canonical F-01' : 'Duplicate F-01',
          nameNormalized: 'f01',
          status: 'published' as const,
          geom: { x: 106.7, y: 10.776 },
        })),
      );
      const f = await fixture('group', {}, [duplicateId]);
      const before = await effects(f);
      const [original] = before.seeds;
      const revisions = await db
        .select()
        .from(schema.roomConstraints)
        .where(eq(schema.roomConstraints.roomId, f.roomId));
      const publish = vi.fn().mockResolvedValue(undefined);
      const d = racedb();
      const service = new RoomsService(
        new RoomsRepository(d),
        new RoomPolicy(d),
        {} as never,
        {} as never,
        {} as never,
        { publish } as never,
      );
      const mergeDb = otherdb();
      const cms = new CmsCatalogService(mergeDb, new PlaceDedupService(mergeDb), {} as never);
      // Fail even an UPDATE matching zero rows: no-op must never enter score
      // invalidation (and consequently plan/reminder invalidation).
      await pool.query(
        "create or replace function seed878_no_invalidation() returns trigger language plpgsql as $$ begin raise exception 'F-01 phantom invalidation'; end $$",
      );
      await pool.query(
        'create trigger seed878_no_invalidation before update on candidate_scores for each statement execute function seed878_no_invalidation()',
      );
      try {
        const [, body] = await writerBarrier(
          'places',
          'seed-878-other',
          () => cms.mergePlaces(randomUUID(), canonicalId, duplicateId),
          'seed-878-race',
          () =>
            operation === 'add'
              ? service.addSeedPlaces(
                  f.member.actor,
                  f.roomId,
                  [canonicalId],
                  `f01-merge-${operation}`,
                )
              : service.removeSeedPlace(
                  f.host.actor,
                  f.roomId,
                  duplicateId,
                  `f01-merge-${operation}`,
                ),
        );
        expect(body).toEqual({
          seedPlaces: [
            {
              placeId: canonicalId,
              name: 'Canonical F-01',
              position: original!.position,
              addedByMemberId: original!.createdByMemberId,
            },
          ],
          constraintVersion: before.version,
        });
        const after = await effects(f);
        expect(after.seeds).toEqual([{ ...original, placeId: canonicalId }]);
        expect(after.version).toBe(before.version);
        expect(after.events).toEqual(before.events);
        expect(after.audits).toEqual(before.audits);
        expect(
          await db
            .select()
            .from(schema.roomConstraints)
            .where(eq(schema.roomConstraints.roomId, f.roomId)),
        ).toEqual(revisions);
        expect(publish).not.toHaveBeenCalled();
        // No-op replay retains the same committed answer and emits nothing.
        const replay =
          operation === 'add'
            ? await service.addSeedPlaces(
                f.member.actor,
                f.roomId,
                [canonicalId],
                `f01-merge-${operation}`,
              )
            : await service.removeSeedPlace(
                f.host.actor,
                f.roomId,
                duplicateId,
                `f01-merge-${operation}`,
              );
        expect(replay).toEqual(body);
        expect(publish).not.toHaveBeenCalled();
      } finally {
        await pool.query('drop trigger seed878_no_invalidation on candidate_scores');
        await pool.query('drop function seed878_no_invalidation()');
      }
    },
  );
});

describe('#878 competing production writers under database barriers', () => {
  it('seed commits first, then host matching sees its version and seed', async () => {
    const f = await fixture();
    // ADR-0024 still requires two completions when the host acknowledges the
    // remaining incomplete member. Seed mutation must not bypass that quorum.
    await prepareLastPreference(f);
    await writerBarrier(
      'room_seed_places',
      'seed-878-race',
      () => mutate(f),
      'seed-878-other',
      () =>
        new RoomsRepository(otherdb()).updateStatus(
          f.roomId,
          'matching',
          {
            eventType: 'room.status_changed',
            resourceType: 'room',
            resourceId: f.roomId,
            payload: {},
          },
          true,
          f.authority,
        ),
    );
    const room = await summary(f);
    expect(room.status).toBe('matching');
    expect(room.constraintVersion).toBe(2);
    expect(room.seedPlaces).toHaveLength(1);
    const snapshot = await new SuggestionsRepository(db).buildSnapshot(f.roomId);
    expect(snapshot.constraintVersion).toBe(2);
    expect(snapshot.seedPlaceIds).toEqual([places[0]]);
  });
  it.each(['seed', 'preferences'] as const)(
    '%s commits first against last preference completion',
    async (winner) => {
      const f = await fixture();
      await prepareLastPreference(f);
      const complete = () => preferences().completeMine(f.member.actor, f.roomId);
      const seed = () => mutate(f).catch((e: Error & { code: string }) => e);
      const result =
        winner === 'seed'
          ? await writerBarrier(
              'room_seed_places',
              'seed-878-race',
              seed,
              'seed-878-other',
              complete,
            )
          : await writerBarrier(
              'preference_selections',
              'seed-878-other',
              complete,
              'seed-878-race',
              seed,
            );
      const state = await effects(f);
      expect((await summary(f)).status).toBe('matching');
      if (winner === 'seed') {
        expect(state.version).toBe(2);
        expect(state.seeds).toHaveLength(1);
      } else {
        expect(result[1]).toMatchObject({ code: 'ROOM_NOT_EDITABLE' });
        expect(state.version).toBe(1);
        expect(state.seeds).toEqual([]);
      }
    },
  );
  it('seed first, then kick preserves creator; rejoining never recovers old ownership', async () => {
    const f = await fixture();
    await writerBarrier(
      'room_seed_places',
      'seed-878-race',
      () => mutate(f),
      'seed-878-other',
      () =>
        new RoomsRepository(otherdb()).removeMember({
          memberId: f.memberId,
          removedByMemberId: f.hostId,
          roomId: f.roomId,
          authority: f.authority,
          event: {
            eventType: 'member.removed',
            resourceType: 'room',
            resourceId: f.roomId,
            payload: {},
          },
        }),
    );
    expect((await summary(f)).seedPlaces[0].addedByMemberId).toBe(f.memberId);
    await db.insert(schema.roomMembers).values({
      roomId: f.roomId,
      userId: f.member.actor.id,
      displayName: 'Rejoined',
      role: 'member',
    });
    expect((await remove(f, f.member, places[0]!)).json().code).toBe('SEED_PLACE_NOT_OWNED');
    expect((await remove(f, f.host, places[0]!)).statusCode).toBe(200);
  });
  it('add first, then remove has one attribution; re-add gets a new creator', async () => {
    const f = await fixture();
    await writerBarrier(
      'room_seed_places',
      'seed-878-race',
      () => mutate(f),
      'seed-878-other',
      () =>
        mutateSeedPlaces(otherdb(), {
          actor: f.host.actor,
          roomId: f.roomId,
          operation: 'remove',
          placeIds: [places[0]!],
        }),
    );
    expect((await effects(f)).seeds).toEqual([]);
    await add(f, f.other, [places[0]!]);
    expect((await summary(f)).seedPlaces[0].addedByMemberId).toBe(
      f.members.find((m) => m.userId === f.other.actor.id)!.id,
    );
  });
});

describe('#878 constraint and claim boundaries', () => {
  it.each(['seed', 'constraint'] as const)(
    '%s wins without lost revision or stale area validation',
    async (winner) => {
      const f = await fixture();
      const edit = () =>
        new RoomsRepository(otherdb()).applyConstraintVersion({
          roomId: f.roomId,
          expectedVersion: 1,
          authority: f.authority,
          memberId: f.hostId,
          constraint: {
            budgetMode: 'per_person',
            budgetAmount: 300000,
            originLat: 0,
            originLng: 0,
            radiusM: 100,
          },
          event: {
            eventType: 'room.constraints_changed',
            resourceType: 'room',
            resourceId: f.roomId,
            payload: {},
          },
        });
      const seed = () => mutate(f).catch((e: Error & { code: string }) => e);
      const result =
        winner === 'seed'
          ? await writerBarrier('room_seed_places', 'seed-878-race', seed, 'seed-878-other', edit)
          : await writerBarrier('room_constraints', 'seed-878-other', edit, 'seed-878-race', seed);
      expect((await summary(f)).constraintVersion).toBe(2);
      if (winner === 'seed') {
        expect(result[1]).toBe(-1);
        expect((await effects(f)).seeds).toHaveLength(1);
      } else {
        expect(result[1]).toMatchObject({ code: 'SEED_PLACE_OUT_OF_AREA' });
        expect((await effects(f)).seeds).toEqual([]);
      }
    },
  );
  it('claim grants only an active user session contribution authority; the old guest token is never upgraded', async () => {
    const f = await fixture();
    const joined = await send('POST', null, '/v1/rooms/join/guest', {
      inviteCode: f.invite,
      displayName: 'Claimed',
    });
    expect(joined.statusCode).toBe(201);
    const guest: Actor = {
      type: 'guest',
      id: joined.json().guestSessionId,
      sessionId: joined.json().guestSessionId,
      roomId: f.roomId,
    };
    const scopedUrl = `/v1/rooms/${f.roomId}/seed-places`;
    expect(
      (await send('POST', joined.json().accessToken, scopedUrl, { placeIds: [places[0]] }))
        .statusCode,
    ).toBe(403);
    await new IdentityRepository(db).claimGuestSession(guest.id, accounts[3]!.actor.id);
    await expect(
      mutateSeedPlaces(db, {
        actor: guest,
        roomId: f.roomId,
        operation: 'add',
        placeIds: [places[0]!],
      }),
    ).rejects.toMatchObject({ code: 'SEED_PLACES_FORBIDDEN' });
    // A repository claim reparents membership; it never upgrades the signed
    // guest actor to a user. Shape §2.2 / seed contract: guests receive 403.
    const oldGuest = await send('POST', joined.json().accessToken, scopedUrl, {
      placeIds: [places[0]],
    });
    expect(oldGuest.statusCode).toBe(403);
    expect(oldGuest.json().code).toBe('SEED_PLACES_FORBIDDEN');
    expect((await add(f, accounts[3]!, [places[0]!])).statusCode).toBe(200);
    expect((await summary(f)).seedPlaces[0].addedByMemberId).toBe(
      (
        await db
          .select()
          .from(schema.roomMembers)
          .where(
            and(
              eq(schema.roomMembers.roomId, f.roomId),
              eq(schema.roomMembers.userId, accounts[3]!.actor.id),
            ),
          )
      )[0]!.id,
    );
  });
});

describe('#878 claim commit race', () => {
  it('user contribution waits for claim commit and uses the claimed membership; guest credentials stay forbidden', async () => {
    const f = await fixture();
    const joined = await send('POST', null, '/v1/rooms/join/guest', {
      inviteCode: f.invite,
      displayName: 'Claim race',
    });
    expect(joined.statusCode).toBe(201);
    await writerBarrier(
      'room_members',
      'seed-878-other',
      () =>
        new IdentityRepository(otherdb()).claimGuestSession(
          joined.json().guestSessionId,
          accounts[3]!.actor.id,
        ),
      'seed-878-race',
      () => mutate(f, accounts[3]!),
    );
    const member = (
      await db
        .select()
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.roomId, f.roomId),
            eq(schema.roomMembers.userId, accounts[3]!.actor.id),
          ),
        )
    )[0]!;
    expect((await summary(f)).seedPlaces[0].addedByMemberId).toBe(member.id);
    await expect(
      mutateSeedPlaces(db, {
        actor: {
          type: 'guest',
          id: joined.json().guestSessionId,
          sessionId: joined.json().guestSessionId,
          roomId: f.roomId,
        },
        roomId: f.roomId,
        operation: 'add',
        placeIds: [places[1]!],
      }),
    ).rejects.toMatchObject({ code: 'SEED_PLACES_FORBIDDEN' });
  });
});

describe('#878 catalog validation locks', () => {
  it('catalog unpublish commits first; validation sees the new status and writes nothing', async () => {
    const f = await fixture();
    const c = await pool.connect();
    await c.query('begin');
    await c.query('select id from places where id=$1 for update', [places[0]]);
    const pending = mutate(f).catch((e: Error & { code: string }) => e);
    try {
      await waitBlocked();
      await c.query("update places set status='draft' where id=$1", [places[0]]);
      await c.query('commit');
      expect(await pending).toMatchObject({ code: 'INVALID_SEED_PLACE' });
      expect((await effects(f)).version).toBe(1);
      expect((await effects(f)).seeds).toEqual([]);
    } finally {
      await c.query('rollback');
      c.release();
      await db
        .update(schema.places)
        .set({ status: 'published' })
        .where(eq(schema.places.id, places[0]!));
    }
  });
  it('seed validation locks catalog until its attribution and revision commit', async () => {
    const f = await fixture();
    try {
      await writerBarrier(
        'room_seed_places',
        'seed-878-race',
        () => mutate(f),
        'seed-878-other',
        async () => {
          await otherdb()
            .update(schema.places)
            .set({ status: 'draft' })
            .where(eq(schema.places.id, places[0]!));
        },
      );
      expect((await summary(f)).seedPlaces[0].addedByMemberId).toBe(f.memberId);
      expect((await remove(f, f.member, places[0]!)).statusCode).toBe(200);
    } finally {
      await db
        .update(schema.places)
        .set({ status: 'published' })
        .where(eq(schema.places.id, places[0]!));
    }
  });
});

describe('#878 replay TTL boundary', () => {
  it('completes a reclaimed binding when the concrete response has not expired', async () => {
    const f = await fixture();
    const key = 'ttl-boundary-123';
    const first = await add(f, f.member, [places[0]!], key);
    const scopes = seedScopes({
      actor: f.member.actor,
      key,
      operation: 'add',
      roomId: f.roomId,
      placeIds: [places[0]!],
    });
    await db
      .update(schema.idempotencyKeys)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.idempotencyKeys.key, scopes.legacy.storedKey));
    const replay = await add(f, f.member, [places[0]!], key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(
      (
        await db
          .select()
          .from(schema.idempotencyKeys)
          .where(eq(schema.idempotencyKeys.key, scopes.legacy.storedKey))
      )[0]!.responseStatus,
    ).toBe(200);
    expect((await add(f, f.member, [places[0]!], key)).statusCode).toBe(200);
    expect((await effects(f)).version).toBe(2);
  });
});
