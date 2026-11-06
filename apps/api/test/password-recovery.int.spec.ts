import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { eq } from 'drizzle-orm';
import { PasswordService } from '../../../libs/modules/identity/application/password.service';
import {
  COMPLETE,
  REQUEST,
  NEW_PASSWORD,
  OLD_PASSWORD,
  crypto,
  freshIp,
  me,
  post,
  recoveryFixture,
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

async function auditCount(userId: string) {
  const result = await f.pool.query(
    "select * from audit_logs where actor_id=$1 and action='password.recovered'",
    [userId],
  );
  return result.rows.length;
}
async function completionRecords(ip: string, keys: string[]) {
  return (
    await f.pool.query('select * from password_recovery_replays where key=any($1::text[])', [
      keys.map((key) => crypto.digest('replay-key', 'complete', ip, key)),
    ])
  ).rows;
}

describe('I-1 PostgreSQL recovery atomicity and contention', () => {
  it('distinct-key contending completions commit one reset, one audit and one completion replay', async () => {
    const user = await f.prepare();
    const ip = freshIp();
    const keys = ['completion-one', 'completion-two'];
    const [one, two] = await f.race(
      user.userId,
      () => post(f.a, COMPLETE, user.input, { ip, key: keys[0]! }),
      () => post(f.b, COMPLETE, user.input, { ip, key: keys[1]! }),
    );
    expect([one.statusCode, two.statusCode]).toEqual([204, 400]);
    expect(two.json()).toMatchObject({ code: 'RECOVERY_INVALID' });
    expect(await auditCount(user.userId)).toBe(1);
    expect(await completionRecords(ip, keys)).toHaveLength(1);
    const [stored] = await f.db.select().from(schema.users).where(eq(schema.users.id, user.userId));
    expect(await f.a.get(PasswordService).verifyOrBurn(stored!.passwordHash, NEW_PASSWORD)).toBe(
      true,
    );
    expect((await f.snapshot(user.userId, user.email)).challenge[0].consumed_at).toBeInstanceOf(
      Date,
    );
  });

  for (const other of ['resend', 'login', 'refresh'] as const) {
    it.each(['complete-first', 'other-first'] as const)(
      `${other} versus complete: %s establishes real lock contention and persists the ordered outcome`,
      async (ordering) => {
        const user = await f.prepare();
        if (other === 'resend') await f.allowResend(user.email);
        const ip = freshIp();
        const complete = (app: typeof f.a) =>
          post(app, COMPLETE, user.input, { ip, key: 'ordered-completion' });
        const operation = (app: typeof f.a) =>
          other === 'resend'
            ? post(app, REQUEST, { email: user.email }, { key: 'ordered-resend' })
            : other === 'login'
              ? post(app, '/v1/auth/login', { email: user.email, password: OLD_PASSWORD })
              : post(app, '/v1/auth/refresh', { refreshToken: user.refreshToken });
        const [first, second] = await f.race(
          user.userId,
          () => (ordering === 'complete-first' ? complete(f.a) : operation(f.a)),
          () => (ordering === 'complete-first' ? operation(f.b) : complete(f.b)),
        );
        const reset = ordering === 'complete-first' ? first : second;
        const competing = ordering === 'complete-first' ? second : first;
        const resetWins = !(other === 'resend' && ordering === 'other-first');
        expect(reset.statusCode, reset.body).toBe(resetWins ? 204 : 400);
        expect(competing.statusCode, competing.body).toBe(
          other === 'resend' ? 202 : ordering === 'complete-first' ? 401 : 201,
        );
        expect(await auditCount(user.userId)).toBe(resetWins ? 1 : 0);
        expect(await completionRecords(ip, ['ordered-completion'])).toHaveLength(resetWins ? 1 : 0);
        const persisted = await f.snapshot(user.userId, user.email);
        expect(persisted.sessions.length).toBeGreaterThan(0);
        expect(persisted.sessions.every((row) => row.revoked_at !== null)).toBe(resetWins);
        if (other === 'resend') {
          expect(persisted.challenge[0].id).toBe(
            competing.json<{ challengeId: string }>().challengeId,
          );
          expect(persisted.challenge[0].id).not.toBe(user.input.challengeId);
          expect(persisted.challenge[0].consumed_at).toBeNull();
        } else if (ordering === 'other-first') {
          // A session actually issued before reset commits must now be dead.
          const issued = competing.json<Grant>();
          expect((await me(f.b, issued.accessToken)).statusCode).toBe(401);
          expect(
            (await post(f.b, '/v1/auth/refresh', { refreshToken: issued.refreshToken })).statusCode,
          ).toBe(401);
          expect(persisted.sessions.length).toBe(2);
        }
        const login = await post(f.b, '/v1/auth/login', {
          email: user.email,
          password: resetWins ? NEW_PASSWORD : OLD_PASSWORD,
        });
        expect(login.statusCode, login.body).toBe(201);
        expect((await me(f.b, login.json<Grant>().accessToken)).statusCode).toBe(200);
        if (resetWins)
          expect(
            (await post(f.b, '/v1/auth/login', { email: user.email, password: OLD_PASSWORD }))
              .statusCode,
          ).toBe(401);
      },
    );
  }

  it('five wrong proofs across instances persist exhaustion and reject the correct proof', async () => {
    const user = await f.prepare();
    const wrong = user.input.code === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await post(attempt % 2 ? f.a : f.b, COMPLETE, {
        ...user.input,
        code: wrong,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'RECOVERY_INVALID' });
      expect((await f.snapshot(user.userId, user.email)).challenge[0].attempts).toBe(attempt);
    }
    expect((await post(f.b, COMPLETE, user.input)).statusCode).toBe(400);
    const persisted = await f.snapshot(user.userId, user.email);
    expect(persisted.challenge[0]).toMatchObject({ attempts: 5, consumed_at: null });
    expect(persisted.user[0].email_verified_at).toBeNull();
    expect(persisted.sessions.every((row) => row.revoked_at === null)).toBe(true);
    expect(await auditCount(user.userId)).toBe(0);
  });

  it.each(['audit', 'completion-replay'] as const)(
    '%s database write failure rolls back credentials, verification, proof, sessions, lockout and export triggers',
    async (failure) => {
      const user = await f.prepare();
      await f.seedExport(user.userId);
      await f.db.insert(schema.loginAttempts).values({
        identifierHash: createHash('sha256').update(user.email).digest('hex'),
        ipHash: 'fixture-ip',
        succeeded: false,
      });
      const ip = freshIp();
      const key = 'rollback-completion';
      const replayKey = crypto.digest('replay-key', 'complete', ip, key);
      const before = await f.snapshot(user.userId, user.email);
      const undo =
        failure === 'audit'
          ? await f.failWrite(
              'audit_logs',
              `NEW.action = 'password.recovered' AND NEW.actor_id = '${user.userId}'::uuid`,
            )
          : await f.failWrite('password_recovery_replays', `NEW.key = '${replayKey}'`);
      try {
        const response = await post(f.a, COMPLETE, user.input, { ip, key });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'RECOVERY_UNAVAILABLE', retryable: true });
        expect(await f.snapshot(user.userId, user.email)).toEqual(before);
        expect(await completionRecords(ip, [key])).toHaveLength(0);
      } finally {
        await undo();
      }
      // The rolled-back proof is usable; no injected fault survives this test.
      expect((await post(f.b, COMPLETE, user.input, { ip, key })).statusCode).toBe(204);
      expect(await auditCount(user.userId)).toBe(1);
      expect((await f.snapshot(user.userId, user.email)).attempts).toHaveLength(0);
    },
  );

  it('success revokes multiple families and rotated sessions, verifies email, clears lockout and export keys while preserving another user', async () => {
    const user = await f.prepare();
    const other = await f.register(f.b);
    const otherBefore = await f.snapshot(other.userId, other.email);
    const second = await post(f.b, '/v1/auth/login', { email: user.email, password: OLD_PASSWORD });
    expect(second.statusCode).toBe(201);
    const rotated = await post(f.b, '/v1/auth/refresh', { refreshToken: user.refreshToken });
    expect(rotated.statusCode).toBe(201);
    const artifact = await f.seedExport(user.userId);
    await f.db.insert(schema.loginAttempts).values({
      identifierHash: createHash('sha256').update(user.email).digest('hex'),
      ipHash: 'fixture-ip',
      succeeded: false,
    });
    const before = await f.snapshot(user.userId, user.email);
    expect(new Set(before.sessions.map((s) => s.family_id)).size).toBe(2);
    expect(before.sessions.some((s) => s.superseded_at !== null)).toBe(true);
    expect((await post(f.a, COMPLETE, user.input, { key: 'success-completion' })).statusCode).toBe(
      204,
    );
    const after = await f.snapshot(user.userId, user.email);
    expect(after.sessions).toHaveLength(3);
    expect(
      after.sessions.every((s) => s.revoked_at && s.revoke_reason === 'password_recovery'),
    ).toBe(true);
    expect(after.user[0].email_verified_at).toBeInstanceOf(Date);
    expect(after.user[0].export_epoch).toBe(before.user[0].export_epoch + 1);
    expect(after.attempts).toHaveLength(0);
    expect(after.exports[0]).toMatchObject({
      id: artifact.id,
      state: 'revoked',
      revoke_reason: 'password_changed',
      wrapped_key: null,
      wrap_nonce: null,
      wrap_tag: null,
    });
    expect(after.exports[0].revoked_at).toBeInstanceOf(Date);
    expect(after.exports[0].cleanup_due_at).toBeInstanceOf(Date);
    expect(after.audits.map((a) => a.action).sort()).toEqual([
      'password.recovered',
      'privacy_export.revoked',
    ]);
    for (const grant of [user, second.json<Grant>(), rotated.json<Grant>()]) {
      expect((await me(f.b, grant.accessToken)).statusCode).toBe(401);
      expect(
        (await post(f.b, '/v1/auth/refresh', { refreshToken: grant.refreshToken })).statusCode,
      ).toBe(401);
    }
    expect(await f.snapshot(other.userId, other.email)).toEqual(otherBefore);
    expect((await me(f.b, other.accessToken)).statusCode).toBe(200);
    const fresh = await post(f.b, '/v1/auth/login', { email: user.email, password: NEW_PASSWORD });
    expect(fresh.statusCode).toBe(201);
    expect((await me(f.b, fresh.json<Grant>().accessToken)).statusCode).toBe(200);
  });
});
