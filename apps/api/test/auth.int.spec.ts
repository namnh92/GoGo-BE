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
 * BE-BFF-002 security acceptance: revocation/expiry/abuse tests against the
 * real HTTP surface + real PostgreSQL (SRS §15.7 hand-crafted request rule).
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let hostUserId: string;
let roomCode: string;
let roomId: string;

function api() {
  return app.getHttpAdapter().getInstance();
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_auth_test')
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

  const [host] = await db
    .insert(schema.users)
    .values({ displayName: 'Host', email: 'host@gogo.id.vn' })
    .returning();
  hostUserId = host!.id;
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: 'ROOMCODE42',
      type: 'group',
      status: 'collecting',
      decisionMode: 'vote',
      hostUserId,
      participantCount: 4,
    })
    .returning();
  roomCode = room!.code;
  roomId = room!.id;

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

describe('register / login', () => {
  it('registers, returns tokens, sets HttpOnly cookies', async () => {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: { email: 'an@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'An' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    const cookies = res.headers['set-cookie'] as string[];
    const at = cookies.find((c) => c.startsWith('gogo_at='));
    expect(at).toContain('HttpOnly');
    expect(at).toContain('SameSite=Lax');
    const rt = cookies.find((c) => c.startsWith('gogo_rt='));
    expect(rt).toContain('Path=/v1/auth/refresh');
  });

  it('does not reveal whether an email exists (register conflict vs login failure)', async () => {
    const dup = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: { email: 'an@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'An2' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('REGISTRATION_FAILED');

    const wrongPw = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { email: 'an@gogo.id.vn', password: 'wrong-password-123' },
    });
    const noAccount = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { email: 'nobody@gogo.id.vn', password: 'wrong-password-123' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(noAccount.statusCode).toBe(401);
    expect(wrongPw.json().code).toBe(noAccount.json().code);
  });

  it('locks out after repeated failures for the same account (FR-AUTH-005)', async () => {
    await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: { email: 'lock@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'L' },
    });
    for (let i = 0; i < 5; i++) {
      await api().inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: freshIp(), // distinct IPs — lockout keys on the account
        payload: { email: 'lock@gogo.id.vn', password: `wrong-${i}-xxxxxxx` },
      });
    }
    const blocked = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { email: 'lock@gogo.id.vn', password: 'sufficiently-long-pw' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().retryable).toBe(true);
  });

  it('rate-limits login attempts per IP', async () => {
    const ip = freshIp();
    let last: number = 0;
    for (let i = 0; i < 6; i++) {
      const res = await api().inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: ip,
        payload: { email: `probe${i}@gogo.id.vn`, password: 'whatever-long-pw' },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('refresh rotation + revoke chain (ADR-0003)', () => {
  async function registerUser(email: string) {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: { email, password: 'sufficiently-long-pw', displayName: 'R' },
    });
    return res.json() as { accessToken: string; refreshToken: string };
  }

  it('rotates refresh tokens; old token still marked, new one works', async () => {
    const t0 = await registerUser('rot@gogo.id.vn');
    const r1 = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { refreshToken: t0.refreshToken },
    });
    expect(r1.statusCode).toBe(201);
    const t1 = r1.json();
    expect(t1.refreshToken).not.toBe(t0.refreshToken);
  });

  it('reusing a superseded refresh token revokes the entire family', async () => {
    const t0 = await registerUser('theft@gogo.id.vn');
    const r1 = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { refreshToken: t0.refreshToken },
    });
    const t1 = r1.json();

    // Attacker replays the old token.
    const replay = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { refreshToken: t0.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // Legitimate holder's newer token is now dead too — family revoked.
    const afterTheft = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { refreshToken: t1.refreshToken },
    });
    expect(afterTheft.statusCode).toBe(401);
    expect(afterTheft.json().code).toBe('SESSION_REVOKED');
  });

  it('logout revokes the session and cookies are cleared', async () => {
    const t0 = await registerUser('bye@gogo.id.vn');
    const res = await api().inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      remoteAddress: freshIp(),
      headers: { authorization: `Bearer ${t0.accessToken}` },
      payload: { allDevices: true },
    });
    expect(res.statusCode).toBe(200);
    const refreshAfter = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { refreshToken: t0.refreshToken },
    });
    expect(refreshAfter.statusCode).toBe(401);
  });
});

describe('guest sessions (FR-AUTH-002/003)', () => {
  it('guest joins with display name; token is scoped to the room', async () => {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: freshIp(),
      payload: { roomCode, displayName: 'Khách Vui' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.roomId).toBe(roomId);
    expect(body.guestToken).toBeTruthy();

    const me = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      actorType: 'guest',
      roomId: roomId,
      displayName: 'Khách Vui',
    });

    const member = await db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.guestSessionId, body.guestSessionId));
    expect(member).toHaveLength(1);
    expect(member[0]!.role).toBe('member');
  });

  it('rejects guest join for unknown or non-joinable rooms', async () => {
    const unknown = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: freshIp(),
      payload: { roomCode: 'NOPE-404-CODE', displayName: 'X' },
    });
    expect(unknown.statusCode).toBe(404);

    await db.update(schema.rooms).set({ status: 'completed' }).where(eq(schema.rooms.id, roomId));
    const done = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: freshIp(),
      payload: { roomCode, displayName: 'X' },
    });
    expect(done.statusCode).toBe(410);
    await db.update(schema.rooms).set({ status: 'collecting' }).where(eq(schema.rooms.id, roomId));
  });

  it('guest can claim history on registration (FR-AUTH-003)', async () => {
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: freshIp(),
      payload: { roomCode, displayName: 'Sẽ Đăng Ký' },
    });
    const guestBody = guest.json();

    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: {
        email: 'claimed@gogo.id.vn',
        password: 'sufficiently-long-pw',
        displayName: 'Đã Đăng Ký',
        claimGuestToken: guestBody.guestToken,
      },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().claimedRoomId).toBe(roomId);

    const member = await db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.userId, reg.json().userId));
    expect(member).toHaveLength(1);
    expect(member[0]!.roomId).toBe(roomId);
    expect(member[0]!.guestSessionId).toBeNull();

    // Guest session is closed after claim.
    const reuse = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { guestToken: guestBody.guestToken },
    });
    expect(reuse.statusCode).toBe(401);
  });
});

describe('session revocation closes the access-token window', () => {
  it('logout-all kills the outstanding access token immediately, not at expiry', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: { email: 'revoke1@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'R' },
    });
    const token = reg.json().accessToken as string;
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);

    await api().inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      remoteAddress: freshIp(),
      headers: { authorization: `Bearer ${token}` },
      payload: { allDevices: true },
    });

    // Same token, every surface — including the PII export — must be dead now.
    for (const url of ['/v1/me', '/v1/me/saved', '/v1/me/export']) {
      const res = await api().inject({
        method: 'GET',
        url,
        remoteAddress: freshIp(),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().code).toBe('SESSION_REVOKED');
    }
  });

  it('refresh-token reuse also kills access tokens across the family', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: { email: 'revoke2@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'R' },
    });
    const first = reg.json();
    const rotated = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { refreshToken: first.refreshToken },
    });
    const fresh = rotated.json();

    // Attacker replays the superseded refresh token.
    await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: freshIp(),
      payload: { refreshToken: first.refreshToken },
    });

    const res = await api().inject({
      method: 'GET',
      url: '/v1/me',
      remoteAddress: freshIp(),
      headers: { authorization: `Bearer ${fresh.accessToken}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('authorization surface', () => {
  it('denies protected routes without credentials (deny-by-default)', async () => {
    const res = await api().inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().request_id).toBeTruthy();
  });

  it('cookie-authenticated mutations require the CSRF double-submit header', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: freshIp(),
      payload: { email: 'csrf@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'C' },
    });
    const cookies = reg.headers['set-cookie'] as string[];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

    const noCsrf = await api().inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      headers: { cookie: cookieHeader },
      payload: { allDevices: false },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('CSRF_FAILED');

    const csrf = cookies
      .find((c) => c.startsWith('gogo_csrf='))!
      .split(';')[0]!
      .split('=')[1]!;
    const withCsrf = await api().inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      headers: { cookie: cookieHeader, 'x-gogo-csrf': csrf },
      payload: { allDevices: false },
    });
    expect(withCsrf.statusCode).toBe(200);
  });
});
