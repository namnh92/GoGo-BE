import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { TokenService } from '../../../libs/modules/identity/application/token.service';
import {
  SessionRevocationService,
  CachedRevocationStore,
  REVOCATION_STORE,
} from '../../../libs/modules/identity/application/session-revocation.service';
import { PasswordService } from '../../../libs/modules/identity/application/password.service';
import {
  COMPLETE,
  NEW_PASSWORD,
  auth,
  api,
  me,
  post,
  recoveryFixture,
  revocationRedis,
  type RecoveryFixture,
  type Grant,
} from './support/password-recovery-fixture';

let f: RecoveryFixture;
beforeAll(async () => {
  f = await recoveryFixture();
});
beforeEach(async () => {
  await f.clearLimits();
});
afterAll(async () => {
  await f?.close();
});

describe('I-3 authoritative consumer session lookup', () => {
  it('reset on A immediately rejects B while B still returns its primed negative cache entry', async () => {
    const user = await f.prepare();
    const sid = f.a.get(TokenService).verifyAccessToken(user.accessToken).sid;
    const store = f.b.get(REVOCATION_STORE);
    expect(store).toBeInstanceOf(CachedRevocationStore);
    expect(f.a.get(REVOCATION_STORE)).not.toBe(store);
    // Hold only this cache's injected clock stable. No global timers, Redis
    // expiry or database clock is changed; the stale negative must stay live.
    const clock = store as { now: () => number; clearedUntil: Map<string, number> };
    const originalClock = clock.now;
    const now = Date.now();
    clock.now = () => now;
    const redis = revocationRedis(f.b);
    const reads = vi.spyOn(redis, 'get');
    try {
      expect((await me(f.b, user.accessToken)).statusCode).toBe(200);
      expect(clock.clearedUntil.get(sid)).toBeGreaterThan(now);
      expect(reads).toHaveBeenCalledWith(`revoked:${sid}`);
      reads.mockClear();
      expect((await post(f.a, COMPLETE, user.input)).statusCode).toBe(204);
      expect(await f.redis.get(`revoked:${sid}`)).toBe('1');
      expect(await f.b.get(SessionRevocationService).isRevoked(sid)).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      for (const url of ['/v1/me', '/v1/me/saved', '/v1/me/export']) {
        const response = await api(f.b).inject({
          method: 'GET',
          url,
          headers: auth(user.accessToken),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ code: 'SESSION_REVOKED' });
      }
      expect(reads).not.toHaveBeenCalled();
      const login = await post(f.b, '/v1/auth/login', {
        email: user.email,
        password: NEW_PASSWORD,
      });
      expect(login.statusCode).toBe(201);
      expect((await me(f.b, login.json<Grant>().accessToken)).statusCode).toBe(200);
    } finally {
      clock.now = originalClock;
      reads.mockRestore();
    }
  });

  it('real Redis client unavailability falls back while the database still rejects reset sessions and accepts active sessions', async () => {
    const c = await f.startApp();
    const user = await f.prepare();
    const active = await f.register();
    const client = revocationRedis(c);
    // Force an actual closed connection, keeping the production fallback chain.
    client.disconnect();
    await expect(client.get('outage-control')).rejects.toThrow();
    expect((await me(c, active.accessToken)).statusCode).toBe(200);
    expect((await post(f.a, COMPLETE, user.input)).statusCode).toBe(204);
    expect((await me(c, user.accessToken)).statusCode).toBe(401);
    expect((await me(c, active.accessToken)).statusCode).toBe(200);
  });

  it('missing, wrong-owner and revoked sessions reject; superseded-only access remains accepted', async () => {
    const user = await f.register();
    const other = await f.register();
    const tokens = f.a.get(TokenService);
    const sid = tokens.verifyAccessToken(user.accessToken).sid;
    const missing = tokens.issueAccessToken({
      actorType: 'user',
      actorId: user.userId,
      sessionId: randomUUID(),
    });
    const wrongOwner = tokens.issueAccessToken({
      actorType: 'user',
      actorId: other.userId,
      sessionId: sid,
    });
    for (const token of [missing, wrongOwner]) {
      const response = await me(f.b, token);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'SESSION_REVOKED' });
    }
    await f.db
      .update(schema.authSessions)
      .set({ supersededAt: new Date() })
      .where(eq(schema.authSessions.id, sid));
    expect((await me(f.b, user.accessToken)).statusCode).toBe(200);
    await f.db
      .update(schema.authSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.authSessions.id, sid));
    expect((await me(f.b, user.accessToken)).statusCode).toBe(401);
  });

  it('an actual PostgreSQL lookup timeout returns sanitized retryable 503; guest/CMS controls and post-outage access work', async () => {
    const c = await f.startApp({ statementTimeout: 1000 });
    const user = await f.register(c);
    const guest = await f.guest(c);
    const email = `cms-${randomUUID()}@example.test`;
    await f.db.insert(schema.adminUsers).values({
      email,
      passwordHash: await f.a.get(PasswordService).hash('Cms-Recovery-8!'),
      displayName: 'CMS control',
      role: 'ops_admin',
    });
    const cms = await post(c, '/v1/cms/auth/login', { email, password: 'Cms-Recovery-8!' });
    expect(cms.statusCode, cms.body).toBe(201);
    const cmsToken = cms.json<Grant>().accessToken;
    const cmsRead = () =>
      api(c).inject({ method: 'GET', url: '/v1/cms/users', headers: auth(cmsToken) });
    expect((await cmsRead()).statusCode).toBe(200);
    // Prime a negative cache before failure: it must never authorize a user
    // when the authoritative read cannot finish.
    expect((await me(c, user.accessToken)).statusCode).toBe(200);
    const coordinator = await f.pool.connect();
    let pending: ReturnType<typeof me> | undefined;
    try {
      await coordinator.query('begin');
      await coordinator.query('lock table auth_sessions in access exclusive mode');
      const pid = (await coordinator.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!.pid;
      pending = me(c, user.accessToken);
      await f.waitBlocked(c, [pid]);
      const response = await pending;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        retryable: true,
        field_errors: [],
      });
      expect(Object.keys(response.json()).sort()).toEqual([
        'code',
        'field_errors',
        'message',
        'request_id',
        'retryable',
      ]);
      expect(response.body).not.toMatch(/select|params|timeout|auth_sessions|cause/i);
      expect((await me(c, guest.accessToken)).statusCode).toBe(200);
      expect((await cmsRead()).statusCode).toBe(200);
    } finally {
      await coordinator.query('rollback');
      coordinator.release();
      if (pending) await pending;
    }
    expect((await me(c, user.accessToken)).statusCode).toBe(200);
    const proof = await f.request(user.email, c);
    expect(
      (
        await post(c, COMPLETE, {
          email: user.email,
          challengeId: proof.body.challengeId,
          code: proof.proof!.code,
          password: NEW_PASSWORD,
        })
      ).statusCode,
    ).toBe(204);
    expect((await me(c, user.accessToken)).statusCode).toBe(401);
    expect((await me(c, guest.accessToken)).statusCode).toBe(200);
    expect((await cmsRead()).statusCode).toBe(200);
  });
});
