import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { eq } from 'drizzle-orm';
import {
  RecoveryRepository,
  type RecoveryTransaction,
} from '../../../libs/modules/identity/infrastructure/recovery.repository';
import { RecoveryMailSender } from '../../../libs/modules/identity/infrastructure/recovery-mail';
import type { RecoveryResponse } from '../../../libs/modules/identity/application/password-recovery.service';
import {
  COMPLETE,
  REQUEST,
  NEW_PASSWORD,
  auth,
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
const normalizeError = (body: Record<string, unknown>) => ({ ...body, request_id: '<request-id>' });
function errorEnvelope(body: Record<string, unknown>, code: string, retryable: boolean) {
  expect(Object.keys(body).sort()).toEqual([
    'code',
    'field_errors',
    'message',
    'request_id',
    'retryable',
  ]);
  expect(body).toMatchObject({ code, field_errors: [], retryable });
  expect(body.request_id).toEqual(expect.any(String));
}

describe('I-2 real app enumeration, quota and replay contracts', () => {
  it('validates equal 202 shapes, 300s/60s lifetimes, padding floor and equivalent logical persistence/send-discard work for eligible, missing, guest and passwordless identities', async () => {
    const eligible = await f.register();
    const passwordless = `passwordless-${randomUUID()}@example.test`;
    await f.db.insert(schema.users).values({ email: passwordless, displayName: 'Passwordless' });
    const guest = await f.guest();
    const identities = [
      { email: eligible.email, headers: {}, eligible: true },
      { email: `missing-${randomUUID()}@example.test`, headers: {}, eligible: false },
      {
        email: `guest-target-${randomUUID()}@example.test`,
        headers: auth(guest.accessToken),
        eligible: false,
      },
      { email: passwordless, headers: {}, eligible: false },
    ];
    const operations: string[][] = [];
    const repo = f.a.get(RecoveryRepository);
    const original = repo.transaction.bind(repo);
    const transaction = vi
      .spyOn(repo, 'transaction')
      .mockImplementation(
        <T>(
          digest: string,
          email: string,
          mode: 'request' | 'complete',
          key: string,
          work: (tx: RecoveryTransaction) => Promise<T>,
        ) =>
          original(digest, email, mode, key, async (tx) => {
            const calls = ['getChallenge', 'getReplay', 'replaceChallenge', 'saveReplay'].map(
              (name) => ({ name, spy: vi.spyOn(tx, name as 'getChallenge') }),
            );
            const result = await work(tx);
            operations.push(
              calls.flatMap(({ name, spy }) =>
                Array.from({ length: spy.mock.calls.length }, () => name),
              ),
            );
            return result;
          }),
      );
    const send = vi.spyOn(f.a.get<RecoveryMailSender>(RecoveryMailSender), 'send');
    const normalized: object[] = [];
    try {
      for (const identity of identities) {
        const started = Date.now();
        const monotonic = performance.now();
        const response = await post(
          f.a,
          REQUEST,
          { email: identity.email },
          { headers: identity.headers },
        );
        const ended = Date.now();
        expect(response.statusCode).toBe(202);
        // A tolerant lower-bound smoke check of the configured 250ms policy;
        // no ceiling or branch timing-distribution comparison is claimed.
        expect(performance.now() - monotonic).toBeGreaterThanOrEqual(225);
        const body = response.json<RecoveryResponse>();
        expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresAt', 'resendAvailableAt']);
        expect(body.challengeId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        for (const [value, lifetime] of [
          [body.expiresAt, 300_000],
          [body.resendAvailableAt, 60_000],
        ] as const) {
          expect(new Date(value).toISOString()).toBe(value);
          expect(Date.parse(value)).toBeGreaterThanOrEqual(started + lifetime);
          expect(Date.parse(value)).toBeLessThanOrEqual(ended + lifetime);
        }
        const [challenge] = await f.db
          .select()
          .from(schema.passwordRecoveryChallenges)
          .where(
            eq(
              schema.passwordRecoveryChallenges.emailDigest,
              crypto.digest('email', identity.email),
            ),
          );
        expect(challenge!.id).toBe(body.challengeId);
        expect(Boolean(challenge!.userId)).toBe(identity.eligible);
        normalized.push({
          challengeId: '<uuid>',
          expiresAt: '<300s-iso>',
          resendAvailableAt: '<60s-iso>',
        });
      }
      expect(
        normalized.every((body) => JSON.stringify(body) === JSON.stringify(normalized[0])),
      ).toBe(true);
      expect(operations).toHaveLength(4);
      for (const work of operations)
        expect(work).toEqual(['getChallenge', 'getReplay', 'replaceChallenge', 'saveReplay']);
      expect(send).toHaveBeenCalledTimes(4);
      expect(send.mock.calls[0]![0]).toMatchObject({ email: eligible.email });
      expect(send.mock.calls.slice(1).map(([message]) => message)).toEqual([null, null, null]);
    } finally {
      transaction.mockRestore();
      send.mockRestore();
    }
  });

  it('disabled configuration and scoped persistence failure return equal 503 envelopes for eligible and ineligible identities', async () => {
    const eligible = await f.register();
    const missing = `missing-${randomUUID()}@example.test`;
    const disabled = await f.startApp({ disabled: true });
    for (const endpoint of [REQUEST, COMPLETE]) {
      const bodies: Record<string, unknown>[] = [];
      for (const email of [eligible.email, missing]) {
        const response = await post(
          disabled,
          endpoint,
          endpoint === REQUEST
            ? { email }
            : { email, challengeId: randomUUID(), code: '123456', password: NEW_PASSWORD },
        );
        expect(response.statusCode).toBe(503);
        errorEnvelope(response.json(), 'RECOVERY_MAIL_NOT_CONFIGURED', false);
        bodies.push(normalizeError(response.json()));
      }
      expect(bodies[1]).toEqual(bodies[0]);
    }
    const bodies: Record<string, unknown>[] = [];
    for (const email of [eligible.email, missing]) {
      const undo = await f.failWrite(
        'password_recovery_challenges',
        `NEW.email_digest = '${crypto.digest('email', email)}'`,
      );
      try {
        const response = await post(f.a, REQUEST, { email });
        expect(response.statusCode).toBe(503);
        errorEnvelope(response.json(), 'RECOVERY_UNAVAILABLE', true);
        bodies.push(normalizeError(response.json()));
      } finally {
        await undo();
      }
      expect(
        (
          await f.pool.query('select * from password_recovery_challenges where email_digest=$1', [
            crypto.digest('email', email),
          ])
        ).rows,
      ).toHaveLength(0);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    const completionBodies: Record<string, unknown>[] = [];
    for (const email of [eligible.email, missing]) {
      await f.clearLimits();
      const { body, proof } = await f.request(email);
      const undo = await f.failWrite(
        'password_recovery_challenges',
        `NEW.email_digest = '${crypto.digest('email', email)}'`,
      );
      try {
        const response = await post(f.b, COMPLETE, {
          email,
          challengeId: body.challengeId,
          code: proof?.code === '000000' ? '111111' : '000000',
          password: NEW_PASSWORD,
        });
        expect(response.statusCode).toBe(503);
        errorEnvelope(response.json(), 'RECOVERY_UNAVAILABLE', true);
        completionBodies.push(normalizeError(response.json()));
        expect(
          (
            await f.pool.query(
              'select attempts from password_recovery_challenges where email_digest=$1',
              [crypto.digest('email', email)],
            )
          ).rows[0].attempts,
        ).toBe(0);
      } finally {
        await undo();
      }
    }
    expect(completionBodies[1]).toEqual(completionBodies[0]);
  });

  it('eligible-only mail failure remains 202 and invalidates the delivered challenge', async () => {
    const user = await f.register();
    const sender = f.a.get<RecoveryMailSender>(RecoveryMailSender);
    const original = sender.send.bind(sender);
    const send = vi.spyOn(sender, 'send').mockImplementation(async (message) => {
      if (message) throw new Error('eligible-only sink failure');
      await original(message);
    });
    try {
      const response = await post(f.a, REQUEST, { email: user.email });
      const missing = await post(f.a, REQUEST, { email: `missing-${randomUUID()}@example.test` });
      expect([response.statusCode, missing.statusCode]).toEqual([202, 202]);
      const [challenge] = await f.db
        .select()
        .from(schema.passwordRecoveryChallenges)
        .where(
          eq(schema.passwordRecoveryChallenges.id, response.json<RecoveryResponse>().challengeId),
        );
      expect(challenge!.consumedAt).toBeInstanceOf(Date);
      expect(
        (
          await post(f.b, COMPLETE, {
            email: user.email,
            challengeId: challenge!.id,
            code: send.mock.calls[0]![0]!.code,
            password: NEW_PASSWORD,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      send.mockRestore();
    }
  });

  const quotas = [
    ['request', 'email-minute', 60, 1],
    ['request', 'email-hour', 3600, 3],
    ['request', 'ip-minute', 60, 10],
    ['request', 'ip-hour', 3600, 50],
    ['complete', 'email-quarter', 900, 10],
    ['complete', 'ip-quarter', 900, 30],
  ] as const;
  it.each(quotas)(
    '%s %s uses real Redis counters/TTLs and enforces the shared limit across instances equally for eligible/ineligible callers',
    async (action, dimension, seconds, max) => {
      const eligible = await f.register();
      const envelopes: Record<string, unknown>[] = [];
      for (const email of [eligible.email, `missing-${randomUUID()}@example.test`]) {
        await f.clearLimits();
        const ip = freshIp();
        const identity = dimension.startsWith('email')
          ? crypto.digest('email', email)
          : crypto.digest('ip', ip);
        const bucket = `rl:recovery|${action}|${dimension}|${identity}`;
        const payload =
          action === 'request'
            ? { email }
            : { email, challengeId: randomUUID(), code: '123456', password: NEW_PASSWORD };
        const first = await post(f.a, action === 'request' ? REQUEST : COMPLETE, payload, { ip });
        expect(first.statusCode).toBe(action === 'request' ? 202 : 400);
        expect(await f.redis.get(bucket)).toBe('1');
        expect(await f.redis.ttl(bucket)).toBeGreaterThan(0);
        expect(await f.redis.ttl(bucket)).toBeLessThanOrEqual(seconds);
        // Seed the rest of this window at its boundary, preserving the real TTL.
        // B's real INCR must aggregate with A's hit and refuse at max+1.
        await f.redis.set(bucket, String(max), 'KEEPTTL');
        for (const [sameAction, name] of quotas) {
          if (sameAction !== action || name === dimension) continue;
          const id = name.startsWith('email')
            ? crypto.digest('email', email)
            : crypto.digest('ip', ip);
          await f.redis.del(`rl:recovery|${action}|${name}|${id}`);
        }
        const refused = await post(f.b, action === 'request' ? REQUEST : COMPLETE, payload, { ip });
        expect(refused.statusCode).toBe(429);
        errorEnvelope(refused.json(), 'RATE_LIMITED', true);
        expect(refused.headers['retry-after']).toBe(String(seconds));
        expect(await f.redis.get(bucket)).toBe(String(max + 1));
        expect(await f.redis.ttl(bucket)).toBeGreaterThan(0);
        envelopes.push(normalizeError(refused.json()));
      }
      expect(envelopes[1]).toEqual(envelopes[0]);
    },
  );

  it('request replay checks quotas and cooldown before replay lookup, then returns the exact original JSON fields and values after cooldown and after resend', async () => {
    const user = await f.register();
    const context = { ip: freshIp(), key: 'request-replay-original' };
    const first = await post(f.a, REQUEST, { email: user.email }, context);
    expect(first.statusCode).toBe(202);
    const originalBody = first.json<RecoveryResponse>();
    expect(Object.keys(originalBody).sort()).toEqual([
      'challengeId',
      'expiresAt',
      'resendAvailableAt',
    ]);
    const repo = f.b.get(RecoveryRepository);
    const original = repo.transaction.bind(repo);
    const getReplay = vi.fn();
    const spy = vi
      .spyOn(repo, 'transaction')
      .mockImplementation(
        <T>(
          digest: string,
          email: string,
          mode: 'request' | 'complete',
          key: string,
          work: (tx: RecoveryTransaction) => Promise<T>,
        ) =>
          original(digest, email, mode, key, async (tx) => {
            const read = tx.getReplay.bind(tx);
            tx.getReplay = async (value) => {
              getReplay();
              return read(value);
            };
            return work(tx);
          }),
      );
    const send = vi.spyOn(f.b.get<RecoveryMailSender>(RecoveryMailSender), 'send');
    try {
      const quota = await post(f.b, REQUEST, { email: user.email }, context);
      expect(quota.statusCode).toBe(429);
      expect(quota.headers['retry-after']).toBe('60');
      expect(spy).not.toHaveBeenCalled();
      await f.clearLimits();
      const cooldown = await post(f.b, REQUEST, { email: user.email }, context);
      expect(cooldown.statusCode).toBe(429);
      expect(Number(cooldown.headers['retry-after'])).toBeGreaterThan(0);
      expect(getReplay).not.toHaveBeenCalled();
      await f.allowResend(user.email);
      const replay = await post(f.b, REQUEST, { email: user.email }, context);
      expect(replay.statusCode).toBe(202);
      // Match the shared idempotency contract: jsonb preserves JSON values,
      // not object key order. Strict equality also rejects extra fields.
      expect(replay.json()).toStrictEqual(originalBody);
      expect(send).not.toHaveBeenCalled();
      await f.clearLimits();
      const resend = await post(
        f.b,
        REQUEST,
        { email: user.email },
        { ...context, key: 'request-resend-new' },
      );
      expect(resend.statusCode).toBe(202);
      expect(resend.json<RecoveryResponse>().challengeId).not.toBe(
        first.json<RecoveryResponse>().challengeId,
      );
      await f.allowResend(user.email);
      await f.clearLimits();
      const replayAfterResend = await post(f.b, REQUEST, { email: user.email }, context);
      expect(replayAfterResend.statusCode).toBe(202);
      expect(replayAfterResend.json()).toStrictEqual(originalBody);
      expect(send).toHaveBeenCalledTimes(1);
      const changed = await post(
        f.b,
        REQUEST,
        { email: `changed-${randomUUID()}@example.test` },
        context,
      );
      expect(changed.statusCode).toBe(422);
      errorEnvelope(changed.json(), 'IDEMPOTENCY_KEY_REUSED', false);
    } finally {
      spy.mockRestore();
      send.mockRestore();
    }
  });

  it('completion replay returns 204 with no second reset/audit and rejects changed-body reuse with 422', async () => {
    const user = await f.prepare();
    const context = { ip: freshIp(), key: 'completion-exact-replay' };
    expect((await post(f.a, COMPLETE, user.input, context)).statusCode).toBe(204);
    const before = await f.snapshot(user.userId, user.email);
    expect((await post(f.b, COMPLETE, user.input, context)).statusCode).toBe(204);
    expect(await f.snapshot(user.userId, user.email)).toEqual(before);
    expect(before.audits.filter((a) => a.action === 'password.recovered')).toHaveLength(1);
    const changed = await post(
      f.b,
      COMPLETE,
      { ...user.input, password: 'Changed-Recovery-7!' },
      context,
    );
    expect(changed.statusCode).toBe(422);
    errorEnvelope(changed.json(), 'IDEMPOTENCY_KEY_REUSED', false);
    expect(await f.snapshot(user.userId, user.email)).toEqual(before);
  });
});
