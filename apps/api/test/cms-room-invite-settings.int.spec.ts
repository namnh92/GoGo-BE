import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, schema } from '@gogo/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
import { TokenService } from '../../../libs/modules/identity/application/token.service';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import { hostedRoom, fixtureHostAuthority } from './support/hosted-room';
import { cmsAccessHeaders } from './support/cms-access';

type Role = 'super_admin' | 'ops_admin' | 'moderator' | 'editor';
const url = '/v1/cms/settings/room-invites';
const email = 'invite-ttl-super@gogo.local';
const metrics = new NoopMetrics();
let container: StartedPostgreSqlContainer;
let instance: ReturnType<typeof createDb>;
let app: NestFastifyApplication;
let boss: string;
let bossId: string;
const staff: Partial<Record<Role, string>> = {};
const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.96.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (token = boss) => ({ authorization: `Bearer ${token}` });
const get = (token = boss) =>
  api().inject({ method: 'GET', url, headers: auth(token), remoteAddress: ip() });
const put = (ttlSeconds: unknown, etag?: string, key: string = randomUUID(), token = boss) =>
  api().inject({
    method: 'PUT',
    url,
    headers: {
      ...auth(token),
      'idempotency-key': key,
      ...(etag === undefined ? {} : { 'if-match': etag }),
    },
    payload: { ttlSeconds },
    remoteAddress: ip(),
  });
const current = async () => {
  const response = await get();
  expect(response.statusCode).toBe(200);
  return response.json();
};
const audits = async () =>
  instance.db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.action, 'room_invite_ttl.updated'));
async function reset() {
  const row = await current();
  const response = await put(86400, row.etag);
  expect(response.statusCode).toBe(200);
}
async function fixture() {
  const [user] = await instance.db
    .insert(schema.users)
    .values({ displayName: 'TTL host' })
    .returning();
  const [room] = await hostedRoom(instance.db, {
    code: randomUUID(),
    hostUserId: user!.id,
    type: 'group',
    decisionMode: 'host',
    status: 'collecting',
  });
  const authority = await fixtureHostAuthority(instance.db, room.id);
  return { room, authority };
}
function issue(
  f: Awaited<ReturnType<typeof fixture>>,
  tx?: Parameters<RoomsRepository['createInvite']>[2],
) {
  return new RoomsRepository(instance.db, metrics).createInvite(
    {
      roomId: f.room.id,
      createdByMemberId: f.authority.memberId,
      codeHash: randomBytes(32).toString('hex'),
    },
    f.authority,
    tx,
  );
}
async function session(adminId: string, authMethod: 'password' | 'access_sso' | null) {
  const [row] = await instance.db
    .insert(schema.adminSessions)
    .values({
      adminId,
      authMethod,
      refreshTokenHash: randomUUID(),
      familyId: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
    })
    .returning();
  return {
    row: row!,
    token: app
      .get(TokenService)
      .issueAccessToken({ actorType: 'admin', actorId: adminId, sessionId: row!.id }),
  };
}
async function waitForWaiters(count: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await instance.pool.query(
      `select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query ilike '%room_invite_settings%'`,
    );
    if (result.rows[0].n >= count) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('expected synchronized settings lock waiters');
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  instance = createDb(container.getConnectionUri(), { max: 8 });
  await migrate(instance.db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'ttl-settings-test-secret'.padEnd(48, 'x');
  process.env.LOG_LEVEL = 'error';
  process.env.CORS_ORIGINS = 'https://cms.gogo.test';
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  const [admin] = await instance.db
    .insert(schema.adminUsers)
    .values({ email, displayName: 'TTL super', role: 'super_admin' })
    .returning();
  bossId = admin!.id;
  const response = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/access-exchange',
    headers: cmsAccessHeaders(email),
    remoteAddress: ip(),
  });
  expect(response.statusCode).toBe(201);
  boss = response.json().accessToken;
  for (const role of ['ops_admin', 'moderator', 'editor'] as const) {
    const [admin] = await instance.db
      .insert(schema.adminUsers)
      .values({ email: `ttl-${role}@gogo.local`, displayName: role, role })
      .returning();
    staff[role] = (await session(admin!.id, 'password')).token;
  }
}, 240000);
afterAll(async () => {
  await app?.close();
  await instance?.pool.end();
  await container?.stop();
});

describe('#906 BE-B CMS room invite lifetime', () => {
  it('GET returns lossless metadata and identical ETag in header/body without conditional caching', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ttlSeconds: 86400,
      version: '1',
      updatedByAdminId: null,
      minTtlSeconds: 1,
      maxTtlSeconds: 2147483647,
      codeMaxTtlSeconds: 172800,
    });
    expect(response.headers.etag).toBe(response.json().etag);
    expect(response.headers['cache-control']).toBe('private, no-store, no-transform');
    const conditional = await api().inject({
      method: 'GET',
      url,
      headers: { ...auth(), 'if-none-match': response.json().etag },
      remoteAddress: ip(),
    });
    expect(conditional.statusCode).toBe(200);
  });
  it.each(['ops_admin', 'moderator', 'editor'] as const)(
    'rejects %s GET/PUT and hides all TTL audit rows with filters and pagination',
    async (role) => {
      const token = staff[role]!;
      expect((await get(token)).statusCode).toBe(403);
      expect((await put(300, '"stale"', randomUUID(), token)).statusCode).toBe(403);
      for (const filter of [
        '',
        '&resourceType=room_invite_ttl',
        '&action=room_invite_ttl.initialized',
        `&actorId=${bossId}`,
        '&resourceId=global',
      ]) {
        const response = await api().inject({
          method: 'GET',
          url: `/v1/cms/audit?limit=1${filter}`,
          headers: auth(token),
          remoteAddress: ip(),
        });
        expect(response.statusCode).toBe(200);
        expect(
          response
            .json()
            .items.every(
              (entry: { resourceType: string }) => entry.resourceType !== 'room_invite_ttl',
            ),
        ).toBe(true);
        if (response.json().nextCursor) {
          const page = await api().inject({
            method: 'GET',
            url: `/v1/cms/audit?limit=1${filter}&cursor=${response.json().nextCursor}`,
            headers: auth(token),
            remoteAddress: ip(),
          });
          expect(
            page
              .json()
              .items.every(
                (entry: { resourceType: string }) => entry.resourceType !== 'room_invite_ttl',
              ),
          ).toBe(true);
        }
      }
    },
  );
  it.each(['password', null] as const)(
    'rejects super_admin auth_method=%s and excludes restricted audit history',
    async (method) => {
      const { token } = await session(bossId, method);
      expect((await get(token)).json().code).toBe('SUPER_ADMIN_SSO_ONLY');
      expect((await put(300, '"stale"', randomUUID(), token)).json().code).toBe(
        'SUPER_ADMIN_SSO_ONLY',
      );
      const history = await api().inject({
        method: 'GET',
        url: '/v1/cms/audit?resourceType=room_invite_ttl',
        headers: auth(token),
        remoteAddress: ip(),
      });
      expect(history.json().items).toEqual([]);
    },
  );
  it('refuses revoked and demoted admin on GET and replay', async () => {
    const before = await current(),
      key = randomUUID();
    const saved = await put(before.ttlSeconds, before.etag, key);
    expect(saved.statusCode).toBe(200);
    const { row, token } = await session(bossId, 'access_sso');
    await instance.db
      .update(schema.adminSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.adminSessions.id, row.id));
    expect((await get(token)).statusCode).toBe(401);
    await instance.db
      .update(schema.adminUsers)
      .set({ role: 'ops_admin' })
      .where(eq(schema.adminUsers.id, bossId));
    try {
      expect((await get()).statusCode).toBe(403);
      expect((await put(before.ttlSeconds, before.etag, key)).statusCode).toBe(403);
    } finally {
      await instance.db
        .update(schema.adminUsers)
        .set({ role: 'super_admin' })
        .where(eq(schema.adminUsers.id, bossId));
    }
  });
  it('requires authentication, rejects consumer tokens, and keeps cookie CSRF protection', async () => {
    expect((await api().inject({ method: 'GET', url, remoteAddress: ip() })).statusCode).toBe(401);
    const registered = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'ttl-user@gogo.local',
        password: 'Sufficiently-long-pw1!',
        displayName: 'TTL user',
      },
      remoteAddress: ip(),
    });
    expect(registered.statusCode).toBe(201);
    expect((await get(registered.json().accessToken)).statusCode).toBe(403);
    expect((await put(300, '"tag"', randomUUID(), registered.json().accessToken)).statusCode).toBe(
      403,
    );
    const before = await current();
    const response = await api().inject({
      method: 'PUT',
      url,
      headers: {
        cookie: `gogo_at=${boss}`,
        'if-match': before.etag,
        'idempotency-key': randomUUID(),
      },
      payload: { ttlSeconds: 300 },
      remoteAddress: ip(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('CSRF_FAILED');
  });
  it('validates If-Match/key and strict numeric DTO using the standard envelope', async () => {
    const before = await current();
    for (const [response, status, code] of [
      [await put(300), 428, 'PRECONDITION_REQUIRED'],
      [await put(300, '"stale"'), 412, 'PRECONDITION_FAILED'],
      [await put(300, '*'), 400, 'INVALID_IF_MATCH'],
      [await put(300, 'W/"tag"'), 400, 'INVALID_IF_MATCH'],
      [await put(300, '"a", "b"'), 400, 'INVALID_IF_MATCH'],
      [await put(300, before.etag, 'bad'), 400, 'INVALID_IDEMPOTENCY_KEY'],
    ] as const) {
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        code,
        retryable: false,
        field_errors: expect.any(Array),
        request_id: expect.any(String),
      });
    }
    const missing = await api().inject({
      method: 'PUT',
      url,
      headers: { ...auth(), 'if-match': before.etag },
      payload: { ttlSeconds: 300 },
      remoteAddress: ip(),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const ttl of ['300', 0, -1, 1.5, 2147483648, null]) {
      const response = await put(ttl, before.etag);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_FAILED');
      expect(response.json().field_errors[0].field).toBe('ttlSeconds');
    }
    const extra = await api().inject({
      method: 'PUT',
      url,
      headers: { ...auth(), 'if-match': before.etag, 'idempotency-key': randomUUID() },
      payload: { ttlSeconds: 300, version: 'injected' },
      remoteAddress: ip(),
    });
    expect(extra.statusCode).toBe(400);
  });
  it('PUT 300 audits once, applies +5 minutes only to new invites, then PUT restores 86400', async () => {
    const f = await fixture(),
      old = await issue(f),
      before = await current(),
      count = (await audits()).length;
    const response = await put(300, before.etag);
    try {
      expect(response.statusCode).toBe(200);
      const saved = response.json();
      expect(saved).toMatchObject({
        ttlSeconds: 300,
        version: String(BigInt(before.version) + 1n),
        updatedByAdminId: bossId,
      });
      expect(response.headers.etag).toBe(saved.etag);
      // Shared audit table: assert only this action and identify this revision.
      const own = (await audits()).filter(
        (a) => (a.diff as { after: { version: string } }).after.version === saved.version,
      );
      expect(await audits()).toHaveLength(count + 1);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({
        actorId: bossId,
        resourceType: 'room_invite_ttl',
        resourceId: 'global',
        diff: {
          before: { ttlSeconds: 86400, version: before.version },
          after: { ttlSeconds: 300, version: saved.version },
        },
      });
      expect(own[0]!.createdAt.toISOString()).toBe(saved.updatedAt);
      const next = await issue(f);
      expect(next.expiresAt.getTime() - next.createdAt.getTime()).toBe(300000);
      const stored = (await new RoomsRepository(instance.db, metrics).listInvites(f.room.id)).find(
        (i) => i.id === old.id,
      )!;
      expect(stored.expiresAt).toEqual(old.expiresAt);
      const history = await api().inject({
        method: 'GET',
        url: '/v1/cms/audit?resourceType=room_invite_ttl',
        headers: auth(),
        remoteAddress: ip(),
      });
      expect(
        history
          .json()
          .items.some((a: { action: string }) => a.action === 'room_invite_ttl.updated'),
      ).toBe(true);
    } finally {
      await reset();
    }
    expect((await current()).ttlSeconds).toBe(86400);
  });
  it('no-op preserves metadata and audit count, but still rejects stale ETag', async () => {
    const before = await current(),
      count = (await audits()).length;
    const response = await put(before.ttlSeconds, before.etag);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(before);
    expect(await audits()).toHaveLength(count);
    expect((await put(before.ttlSeconds, '"stale"')).statusCode).toBe(412);
  });
  it('replays lost response before current revision comparison, binds body AND If-Match, never writes back old value', async () => {
    const before = await current(),
      key = randomUUID(),
      count = (await audits()).length;
    const first = await put(300, before.etag, key);
    expect(first.statusCode).toBe(200);
    try {
      const replay = await put(300, before.etag, key);
      expect(replay.json()).toEqual(first.json());
      expect(replay.headers.etag).toBe(first.headers.etag);
      expect(replay.headers['x-idempotent-replay']).toBe('true');
      expect(await audits()).toHaveLength(count + 1);
      expect((await put(301, before.etag, key)).statusCode).toBe(422);
      expect((await put(300, first.json().etag, key)).statusCode).toBe(422);
      await reset();
      const later = await current();
      expect((await put(300, before.etag, key)).json()).toEqual(first.json());
      expect(await current()).toEqual(later);
    } finally {
      await reset();
    }
  });
  it('serializes two PUTs with the same ETag: one change, one 412, one audit', async () => {
    const before = await current(),
      count = (await audits()).length;
    const blocker = await instance.pool.connect();
    await blocker.query('begin');
    await blocker.query('select id from room_invite_settings where id=1 for update');
    const requests = [put(300, before.etag), put(600, before.etag)];
    try {
      await waitForWaiters(2);
      await blocker.query('commit');
      const results = await Promise.all(requests);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
      expect(await audits()).toHaveLength(count + 1);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.allSettled(requests);
      await reset();
    }
  });
  it('returns retryable 409 for a duplicate in-flight key and then replays the winner', async () => {
    const before = await current(),
      key = randomUUID(),
      count = (await audits()).length;
    const blocker = await instance.pool.connect();
    await blocker.query('begin');
    await blocker.query('select id from room_invite_settings where id=1 for update');
    const original = put(300, before.etag, key);
    try {
      await waitForWaiters(1);
      const duplicate = await put(300, before.etag, key);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        code: 'IDEMPOTENT_REQUEST_IN_FLIGHT',
        retryable: true,
      });
      await blocker.query('commit');
      const first = await original;
      expect(first.statusCode).toBe(200);
      expect((await put(300, before.etag, key)).json()).toEqual(first.json());
      expect(await audits()).toHaveLength(count + 1);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await original;
      await reset();
    }
  });
  it('CMS UPDATE blocks issuance until commit, then issuance reads the new TTL and post-wait clock', async () => {
    const before = await current(),
      f = await fixture();
    const blocker = await instance.pool.connect();
    await blocker.query('select pg_advisory_lock(906906)');
    await instance.pool.query(
      `CREATE FUNCTION hold_ttl_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='room_invite_ttl.updated' THEN PERFORM pg_advisory_xact_lock(906906); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_ttl_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION hold_ttl_audit()`,
    );
    const updating = put(300, before.etag);
    let issuing: ReturnType<typeof issue> | undefined;
    try {
      const deadline = Date.now() + 10000;
      let held = false;
      while (Date.now() < deadline) {
        const rows = await instance.pool.query(
          "select 1 from pg_stat_activity where wait_event='advisory' and query ilike '%audit_logs%'",
        );
        if (rows.rowCount) {
          held = true;
          break;
        }
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(held).toBe(true);
      issuing = issue(f);
      await waitForWaiters(1);
      const boundary = new Date(
        (await blocker.query('select clock_timestamp() as now')).rows[0].now,
      );
      await blocker.query('select pg_advisory_unlock(906906)');
      expect((await updating).statusCode).toBe(200);
      const invite = await issuing;
      expect(invite.createdAt.getTime()).toBeGreaterThanOrEqual(boundary.getTime());
      expect(invite.expiresAt.getTime() - invite.createdAt.getTime()).toBe(300000);
    } finally {
      await blocker.query('select pg_advisory_unlock(906906)');
      blocker.release();
      await updating;
      await issuing;
      await instance.pool.query(
        'DROP TRIGGER hold_ttl_audit ON audit_logs; DROP FUNCTION hold_ttl_audit()',
      );
      await reset();
    }
  });
  it('issuer SHARE blocks CMS PUT until commit; subsequent issuer uses new TTL', async () => {
    const before = await current(),
      f = await fixture(),
      held = barrier(),
      release = barrier();
    const issuing = instance.db.transaction(async (tx) => {
      const invite = await issue(f, tx);
      held.release();
      await release.promise;
      return invite;
    });
    await held.promise;
    const updating = put(300, before.etag);
    try {
      await waitForWaiters(1);
      release.release();
      const invite = await issuing;
      expect(invite.expiresAt.getTime() - invite.createdAt.getTime()).toBe(
        before.ttlSeconds * 1000,
      );
      expect((await updating).statusCode).toBe(200);
      const next = await issue(f);
      expect(next.expiresAt.getTime() - next.createdAt.getTime()).toBe(300000);
    } finally {
      release.release();
      await issuing;
      await updating;
      await reset();
    }
  });
  it.each(['audit', 'completion'] as const)(
    '%s failure rolls back setting/audit/replay together and releases own key for retry',
    async (fault) => {
      const before = await current(),
        key = randomUUID(),
        count = (await audits()).length;
      const table = fault === 'audit' ? 'audit_logs' : 'idempotency_keys';
      const condition =
        fault === 'audit'
          ? "NEW.action='room_invite_ttl.updated'"
          : "NEW.endpoint='PUT /v1/cms/settings/room-invites' AND NEW.response_status IS NOT NULL";
      await instance.db.execute(
        sql.raw(
          `CREATE FUNCTION fail_ttl_${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'test storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_ttl_${fault} BEFORE ${fault === 'audit' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_ttl_${fault}()`,
        ),
      );
      try {
        const response = await put(300, before.etag, key);
        expect(response.statusCode).toBe(500);
        expect(await current()).toEqual(before);
        expect(await audits()).toHaveLength(count);
      } finally {
        await instance.db.execute(
          sql.raw(`DROP TRIGGER fail_ttl_${fault} ON ${table}; DROP FUNCTION fail_ttl_${fault}()`),
        );
      }
      const retry = await put(300, before.etag, key);
      try {
        expect(retry.statusCode).toBe(200);
        expect(await audits()).toHaveLength(count + 1);
      } finally {
        await reset();
      }
    },
  );
  it('permits If-Match in CMS-origin CORS preflight', async () => {
    const response = await api().inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: 'https://cms.gogo.test',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,if-match,idempotency-key,x-gogo-csrf',
      },
      remoteAddress: ip(),
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://cms.gogo.test');
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'if-match',
    );
  });
});
