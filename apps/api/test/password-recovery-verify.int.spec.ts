import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPLETE,
  REQUEST,
  VERIFY,
  crypto,
  freshIp,
  post,
  recoveryFixture,
  type RecoveryFixture,
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

describe('I-6 non-consuming recovery verification (#845)', () => {
  it('verifies repeatedly across instances without changing credentials, sessions, proof or replay rows; complete stays single-use', async () => {
    const user = await f.prepare();
    const { password: _password, ...proof } = user.input;
    const context = { ip: freshIp(), key: 'verify-repeat-key' };
    const before = await f.snapshot(user.userId, user.email);
    const replays = await f.pool.query('select * from password_recovery_replays order by key');
    for (const app of [f.a, f.b]) {
      const response = await post(app, VERIFY, proof, context);
      expect(response.statusCode, response.body).toBe(204);
      expect(response.body).toBe('');
    }
    expect(await f.snapshot(user.userId, user.email)).toEqual(before);
    expect(
      (await f.pool.query('select * from password_recovery_replays order by key')).rows,
    ).toEqual(replays.rows);
    expect((await post(f.b, COMPLETE, user.input)).statusCode).toBe(204);
    const invalid = await post(f.a, VERIFY, proof, context);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'RECOVERY_INVALID', retryable: false });
    expect((await post(f.a, COMPLETE, user.input)).statusCode).toBe(400);
  });

  it.each([
    'wrong-code',
    'wrong-challenge',
    'wrong-email',
    'expired',
    'consumed',
    'resend',
    'ineligible',
  ] as const)('rejects %s using the same recovery error', async (kind) => {
    const user = await f.prepare();
    const { password: _password, ...proof } = user.input;
    if (kind === 'wrong-code') proof.code = proof.code === '000000' ? '111111' : '000000';
    if (kind === 'wrong-challenge') proof.challengeId = randomUUID();
    if (kind === 'wrong-email') proof.email = `missing-${randomUUID()}@example.test`;
    if (kind === 'expired')
      await f.pool.query(
        "update password_recovery_challenges set expires_at=now()-interval '1 second' where id=$1",
        [proof.challengeId],
      );
    if (kind === 'consumed') expect((await post(f.a, COMPLETE, user.input)).statusCode).toBe(204);
    if (kind === 'resend') {
      await f.allowResend(user.email);
      expect((await post(f.a, REQUEST, { email: user.email })).statusCode).toBe(202);
    }
    if (kind === 'ineligible')
      await f.pool.query("update users set status='suspended' where id=$1", [user.userId]);
    const response = await post(f.b, VERIFY, proof);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'RECOVERY_INVALID',
      field_errors: [],
      retryable: false,
    });
    const after = await f.snapshot(user.userId, user.email);
    expect(after.challenge[0].attempts).toBe(
      ['wrong-code', 'wrong-challenge', 'resend', 'ineligible'].includes(kind) ? 1 : 0,
    );
  });

  it('persists five mixed verify/complete failures across instances and rejects the correct code on both endpoints', async () => {
    const user = await f.prepare();
    const wrong = { ...user.input, code: user.input.code === '000000' ? '111111' : '000000' };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await post(attempt % 2 ? f.a : f.b, attempt % 2 ? VERIFY : COMPLETE, wrong, {
        key: 'same-invalid-key',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'RECOVERY_INVALID' });
      expect((await f.snapshot(user.userId, user.email)).challenge[0].attempts).toBe(attempt);
    }
    for (const endpoint of [VERIFY, COMPLETE])
      expect((await post(f.b, endpoint, user.input)).statusCode).toBe(400);
    const after = await f.snapshot(user.userId, user.email);
    expect(after.challenge[0]).toMatchObject({ attempts: 5, consumed_at: null });
    expect(after.user[0].email_verified_at).toBeNull();
    expect(after.sessions.every((session) => session.revoked_at === null)).toBe(true);
    expect(after.audits).toEqual([]);
  });

  it.each(['verify-first', 'complete-first'] as const)(
    'serializes valid verify versus complete under real PostgreSQL contention: %s',
    async (order) => {
      const user = await f.prepare();
      const verify = (app: typeof f.a) =>
        post(app, VERIFY, user.input, { key: 'contended-verify' });
      const complete = (app: typeof f.a) =>
        post(app, COMPLETE, user.input, { key: 'contended-complete' });
      const [one, two] = await f.race(
        user.userId,
        () => (order === 'verify-first' ? verify(f.a) : complete(f.a)),
        () => (order === 'verify-first' ? complete(f.b) : verify(f.b)),
      );
      expect([one.statusCode, two.statusCode]).toEqual(
        order === 'verify-first' ? [204, 204] : [204, 400],
      );
      const after = await f.snapshot(user.userId, user.email);
      expect(after.challenge[0].consumed_at).toBeInstanceOf(Date);
      expect(after.audits.filter((row) => row.action === 'password.recovered')).toHaveLength(1);
    },
  );

  it.each(['verify', 'complete'] as const)(
    'a fifth failed %s locks out the contending correct proof on the other endpoint',
    async (first) => {
      const user = await f.prepare();
      const wrong = { ...user.input, code: user.input.code === '000000' ? '111111' : '000000' };
      for (let i = 0; i < 4; i++) expect((await post(f.a, VERIFY, wrong)).statusCode).toBe(400);
      const [one, two] = await f.race(
        user.userId,
        () => post(f.a, first === 'verify' ? VERIFY : COMPLETE, wrong),
        () => post(f.b, first === 'verify' ? COMPLETE : VERIFY, user.input),
      );
      expect([one.statusCode, two.statusCode]).toEqual([400, 400]);
      const after = await f.snapshot(user.userId, user.email);
      expect(after.challenge[0]).toMatchObject({ attempts: 5, consumed_at: null });
      expect(after.audits).toEqual([]);
    },
  );

  it('does not lose concurrent failed increments across endpoints or exceed five', async () => {
    const user = await f.prepare();
    const wrong = { ...user.input, code: user.input.code === '000000' ? '111111' : '000000' };
    const [one, two] = await f.race(
      user.userId,
      () => post(f.a, VERIFY, wrong),
      () => post(f.b, COMPLETE, wrong),
    );
    expect([one.statusCode, two.statusCode]).toEqual([400, 400]);
    expect((await f.snapshot(user.userId, user.email)).challenge[0].attempts).toBe(2);
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        post(i % 2 ? f.a : f.b, i % 2 ? VERIFY : COMPLETE, wrong),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    expect((await f.snapshot(user.userId, user.email)).challenge[0].attempts).toBe(5);
  });

  it.each([
    ['email-quarter', 10],
    ['ip-quarter', 30],
  ] as const)(
    'shares complete %s limits through real Redis and returns Retry-After',
    async (dimension, max) => {
      const user = await f.prepare();
      const ip = freshIp();
      const identity =
        dimension === 'email-quarter'
          ? crypto.digest('email', user.email)
          : crypto.digest('ip', ip);
      const bucket = `rl:recovery|complete|${dimension}|${identity}`;
      expect((await post(f.a, VERIFY, user.input, { ip })).statusCode).toBe(204);
      expect(await f.redis.get(bucket)).toBe('1');
      expect(await f.redis.ttl(bucket)).toBeGreaterThan(0);
      expect(await f.redis.ttl(bucket)).toBeLessThanOrEqual(900);
      await f.redis.set(bucket, String(max - 1), 'KEEPTTL');
      expect(
        (await post(f.b, COMPLETE, user.input, { ip, key: 'quota-complete' })).statusCode,
      ).toBe(204);
      const refused = await post(f.a, VERIFY, user.input, { ip, key: 'quota-verify' });
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('900');
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
      expect(await f.redis.get(bucket)).toBe(String(max + 1));
    },
  );

  it('rolls back failed-attempt writes on infrastructure failure and permits retry', async () => {
    const user = await f.prepare();
    const before = await f.snapshot(user.userId, user.email);
    const wrong = { ...user.input, code: user.input.code === '000000' ? '111111' : '000000' };
    const undo = await f.failWrite(
      'password_recovery_challenges',
      `NEW.id = '${user.input.challengeId}'::uuid`,
    );
    try {
      const response = await post(f.a, VERIFY, wrong);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'RECOVERY_UNAVAILABLE', retryable: true });
      expect(await f.snapshot(user.userId, user.email)).toEqual(before);
    } finally {
      await undo();
    }
    expect((await post(f.b, VERIFY, wrong)).statusCode).toBe(400);
    expect((await f.snapshot(user.userId, user.email)).challenge[0].attempts).toBe(1);
    expect((await post(f.b, VERIFY, user.input)).statusCode).toBe(204);
  });
});
