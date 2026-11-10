import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { PasswordService } from '../../../libs/modules/identity/application/password.service';
import {
  COMPLETE,
  REQUEST,
  VERIFY,
  NEW_PASSWORD,
  OLD_PASSWORD,
  crypto,
  me,
  post,
  recoveryFixture,
  type RecoveryFixture,
  type Grant,
} from './support/password-recovery-fixture';

let f: RecoveryFixture;
let legacyUser: typeof schema.users.$inferSelect;
let legacySession: typeof schema.authSessions.$inferSelect;
beforeAll(async () => {
  f = await recoveryFixture({
    before0079: async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({
          displayName: 'Populated 0078',
          email: 'legacy-0078@example.test',
          passwordHash: await new PasswordService().hash(OLD_PASSWORD),
        })
        .returning();
      legacyUser = user!;
      const [session] = await db
        .insert(schema.authSessions)
        .values({
          userId: user!.id,
          refreshTokenHash: 'legacy-session-hash',
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning();
      legacySession = session!;
      const result = await db.execute(
        "select to_regclass('public.password_recovery_challenges') as challenges, to_regclass('public.password_recovery_replays') as replays",
      );
      expect(result.rows[0]).toEqual({ challenges: null, replays: null });
    },
  });
});
beforeEach(async () => {
  await f.clearLimits();
});
afterAll(async () => {
  await f?.close();
});

describe('I-4 forward migration, retention and disable rollback', () => {
  it('populated 0078 upgrades through the real 0079 journal entry with preserved data, constraints, indexes and usable tables', async () => {
    const journal = await f.pool.query(
      'select * from drizzle.__drizzle_migrations where created_at=$1',
      [f.entry.when],
    );
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0].hash).toBe(f.migrationHash);
    const [user] = await f.db.select().from(schema.users).where(eq(schema.users.id, legacyUser.id));
    const [session] = await f.db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.id, legacySession.id));
    expect(user).toEqual(legacyUser);
    expect(session).toEqual(legacySession);
    const constraints = await f.pool.query<{ conname: string; definition: string }>(
      "select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('password_recovery_challenges'::regclass, 'password_recovery_replays'::regclass)",
    );
    expect(
      constraints.rows.some(
        (c) =>
          c.conname === 'password_recovery_attempts_bounded' && c.definition.includes('attempts'),
      ),
    ).toBe(true);
    expect(constraints.rows.filter((c) => c.definition.startsWith('PRIMARY KEY'))).toHaveLength(2);
    expect(
      constraints.rows.some((c) =>
        c.definition.includes('FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'),
      ),
    ).toBe(true);
    const indexes = await f.pool.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where tablename in ('password_recovery_challenges','password_recovery_replays')",
    );
    for (const name of ['password_recovery_expiry_idx', 'password_recovery_replay_expiry_idx']) {
      expect(indexes.rows.find((i) => i.indexname === name)?.indexdef).toContain('(expires_at)');
    }
    const emailDigest = crypto.digest('email', legacyUser.email!);
    await expect(
      f.pool.query(
        "insert into password_recovery_challenges (email_digest,id,code_digest,attempts,expires_at,resend_available_at) values ($1,$2,'proof',6,now(),now())",
        [emailDigest, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.pool.query(
        "insert into password_recovery_challenges (email_digest,id,user_id,code_digest,expires_at,resend_available_at) values ($1,$2,$3,'proof',now(),now())",
        [emailDigest, randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const requested = await f.request(legacyUser.email!);
    expect(
      (
        await post(
          f.b,
          COMPLETE,
          {
            email: legacyUser.email!,
            challengeId: requested.body.challengeId,
            code: requested.proof!.code,
            password: NEW_PASSWORD,
          },
          { key: 'legacy-completion' },
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await f.pool.query('select * from password_recovery_replays')).rows.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('invoked cleanup deletes at most 100 challenges expired plus 24h and 100 replays at their own expiry, retaining younger controls', async () => {
    // Each cleanup invocation needs an eligible account and a fresh email so
    // the request succeeds without hitting the per-email resend cooldown.
    const firstTrigger = await f.register();
    const secondTrigger = await f.register();
    await f.pool.query(
      "insert into password_recovery_challenges (email_digest,id,code_digest,expires_at,resend_available_at) select 'cleanup-old-'||n, gen_random_uuid(),'proof',now()-interval '25 hours',now()-interval '25 hours' from generate_series(1,105) n",
    );
    await f.pool.query(
      "insert into password_recovery_replays (key,fingerprint,expires_at) select 'cleanup-old-'||n,'fingerprint',now()-interval '1 hour' from generate_series(1,105) n",
    );
    for (const [name, age] of [
      ['recent-expired', '-23 hours'],
      ['live', '1 hour'],
    ] as const) {
      await f.pool.query(
        "insert into password_recovery_challenges (email_digest,id,code_digest,expires_at,resend_available_at) values ($1,$2,'proof',now()+$3::interval,now())",
        [`cleanup-${name}`, randomUUID(), age],
      );
    }
    await f.pool.query(
      "insert into password_recovery_replays (key,fingerprint,expires_at) values ('cleanup-live','fingerprint',now()+interval '1 hour')",
    );
    await f.request(firstTrigger.email);
    for (const [table, column] of [
      ['password_recovery_challenges', 'email_digest'],
      ['password_recovery_replays', 'key'],
    ] as const) {
      expect(
        Number(
          (
            await f.pool.query(
              `select count(*) as n from ${table} where ${column} like 'cleanup-old-%'`,
            )
          ).rows[0].n,
        ),
      ).toBe(5);
    }
    await f.request(secondTrigger.email);
    expect(
      (
        await f.pool.query(
          "select email_digest from password_recovery_challenges where email_digest like 'cleanup-%' order by email_digest",
        )
      ).rows.map((r) => r.email_digest),
    ).toEqual(['cleanup-live', 'cleanup-recent-expired']);
    expect(
      (await f.pool.query("select key from password_recovery_replays where key like 'cleanup-%'"))
        .rows,
    ).toEqual([{ key: 'cleanup-live' }]);
  });

  it('restart with disabled mail uniformly refuses recovery endpoints, keeps tables and revocations, and preserves the new password', async () => {
    const user = await f.prepare();
    expect((await post(f.a, COMPLETE, user.input)).statusCode).toBe(204);
    await f.stopApp(f.a);
    await f.stopApp(f.b);
    // Restart against the same database/Redis with disabled configuration.
    const disabled = await f.startApp({ disabled: true });
    const bodies = [];
    for (const email of [user.email, `missing-${randomUUID()}@example.test`]) {
      for (const endpoint of [REQUEST, VERIFY, COMPLETE]) {
        const response = await post(
          disabled,
          endpoint,
          endpoint === REQUEST ? { email } : { ...user.input, email },
        );
        expect(response.statusCode).toBe(503);
        const body = response.json<Record<string, unknown>>();
        expect(body).toMatchObject({ code: 'RECOVERY_MAIL_NOT_CONFIGURED', retryable: false });
        bodies.push({ ...body, request_id: '<request-id>' });
      }
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    const tables = await f.pool.query(
      "select to_regclass('password_recovery_challenges') as challenges, to_regclass('password_recovery_replays') as replays",
    );
    expect(tables.rows[0]).toEqual({
      challenges: 'password_recovery_challenges',
      replays: 'password_recovery_replays',
    });
    expect((await f.snapshot(user.userId, user.email)).challenge).toHaveLength(1);
    expect((await me(disabled, user.accessToken)).statusCode).toBe(401);
    expect(
      (await post(disabled, '/v1/auth/refresh', { refreshToken: user.refreshToken })).statusCode,
    ).toBe(401);
    expect(
      (await post(disabled, '/v1/auth/login', { email: user.email, password: OLD_PASSWORD }))
        .statusCode,
    ).toBe(401);
    const login = await post(disabled, '/v1/auth/login', {
      email: user.email,
      password: NEW_PASSWORD,
    });
    expect(login.statusCode).toBe(201);
    expect((await me(disabled, login.json<Grant>().accessToken)).statusCode).toBe(200);
  });
});
