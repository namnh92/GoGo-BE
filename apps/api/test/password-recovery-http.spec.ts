import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import {
  PasswordRecoveryService,
  RecoveryCrypto,
  type RecoveryChallenge,
  type RecoveryReplay,
} from '../../../libs/modules/identity/application/password-recovery.service';
import type { PasswordService } from '../../../libs/modules/identity/application/password.service';
import type { SessionRevocationService } from '../../../libs/modules/identity/application/session-revocation.service';
import type {
  RecoveryRepository,
  RecoveryTransaction,
} from '../../../libs/modules/identity/infrastructure/recovery.repository';
import { RecoveryMailSink } from '../../../libs/modules/identity/infrastructure/recovery-mail';
import { PasswordRecoveryController } from '../../../libs/modules/identity/presentation/password-recovery.controller';
import { InMemoryRateLimitStore } from '../../../libs/modules/identity/presentation/rate-limit.service';

// Real controller, validation pipe, service and exception filter; no listening socket or database.
describe('password recovery HTTP privacy contract', () => {
  const apps: NestFastifyApplication[] = [];
  const email = 'person@example.com';
  const active = {
    id: 'original-user',
    email,
    status: 'active',
    passwordHash: 'old-hash',
    emailVerifiedAt: null,
  };
  let now: number;
  beforeEach(() => {
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.restoreAllMocks();
  });

  async function setup(user: any = active) {
    const challenges = new Map<string, RecoveryChallenge>();
    const replays = new Map<string, RecoveryReplay>();
    const sink = new RecoveryMailSink();
    const store = new InMemoryRateLimitStore();
    const transaction = async <T>(
      digest: string,
      _email: string,
      _mode: string,
      _key: string,
      work: (tx: RecoveryTransaction) => Promise<T>,
    ) =>
      work({
        user,
        getChallenge: async () => challenges.get(digest),
        replaceChallenge: async (value) => {
          challenges.set(digest, value);
        },
        getReplay: async (key) => replays.get(key),
        saveReplay: async (key, value) => {
          replays.set(key, value);
        },
        failAttempt: async () => {
          challenges.get(digest)!.attempts += 1;
        },
        reset: async () => {
          challenges.get(digest)!.consumedAt = new Date(now);
          return ['family-a', 'family-b'];
        },
      });
    const service = new PasswordRecoveryService(
      {
        transaction,
        invalidate: async (digest: string) => {
          challenges.get(digest)!.consumedAt = new Date(now);
        },
      } as unknown as RecoveryRepository,
      { hash: async () => 'new-hash' } as unknown as PasswordService,
      { revokeMany: async () => undefined } as unknown as SessionRevocationService,
      store,
      new RecoveryCrypto('x'.repeat(48)),
      sink,
    );
    @Module({
      controllers: [PasswordRecoveryController],
      providers: [{ provide: PasswordRecoveryService, useValue: service }],
    })
    class Harness {}
    const app = await NestFactory.create<NestFastifyApplication>(
      Harness,
      new FastifyAdapter({ genReqId: () => 'privacy-request' }),
      { logger: false },
    );
    apps.push(app);
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const request = (key = 'request-1', address = email) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password-recovery/request',
        payload: { email: address },
        headers: { 'idempotency-key': key },
      });
    return { app, request, store, sink };
  }

  function accepted(response: Awaited<ReturnType<NestFastifyApplication['inject']>>) {
    expect(response.statusCode).toBe(202);
    expect(response.headers['retry-after']).toBeUndefined();
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresAt', 'resendAvailableAt']);
    expect(body.challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    expect(new Date(body.resendAvailableAt).toISOString()).toBe(body.resendAvailableAt);
    expect(JSON.stringify(body)).not.toContain(email);
    return body;
  }

  it('returns 202 and exact lifetimes for verified and unverified eligible identities', async () => {
    for (const user of [active, { ...active, emailVerifiedAt: new Date(now) }]) {
      const { request } = await setup(user);
      const body = accepted(await request());
      expect(Date.parse(body.expiresAt) - now).toBe(300_000);
      expect(Date.parse(body.resendAvailableAt) - now).toBe(60_000);
    }
  });

  it.each([
    null,
    { ...active, passwordHash: null },
    { ...active, status: 'disabled' },
    { ...active, status: 'suspended' },
    { ...active, status: 'banned' },
    { ...active, status: 'deleted' },
  ])('returns generic 404 and throttles ineligible identity %#', async (user) => {
    const { request, sink } = await setup(user);
    expect(envelope(await request(), 404, 'RECOVERY_ACCOUNT_NOT_FOUND')).toMatchObject({
      message: 'Tài khoản không tồn tại',
      retryable: false,
    });
    expect(sink.sent).toEqual([]);
    envelope(await request(), 429, 'RATE_LIMITED', '60');
  });

  it('keeps eligible-only delivery failure at HTTP 202', async () => {
    const { request, sink } = await setup();
    vi.spyOn(sink, 'send').mockRejectedValue(new Error('eligible-only mail failure'));
    accepted(await request());
  });

  function envelope(
    response: Awaited<ReturnType<NestFastifyApplication['inject']>>,
    status: number,
    code: string,
    retryAfter?: string,
  ) {
    expect(response.statusCode).toBe(status);
    expect(response.headers['retry-after']).toBe(retryAfter);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      'code',
      'field_errors',
      'message',
      'request_id',
      'retryable',
    ]);
    expect(body).toMatchObject({
      code,
      field_errors: [],
      request_id: 'privacy-request',
      retryable: status === 429,
    });
    expect(typeof body.message).toBe('string');
    return body;
  }

  it('preserves eligible cooldown, replay, body conflict and quota envelopes', async () => {
    const { request, store } = await setup();
    const first = accepted(await request());
    envelope(await request(), 429, 'RATE_LIMITED', '60'); // replay counts before lookup
    const hit = vi.spyOn(store, 'hit').mockResolvedValue(1);
    envelope(await request(), 429, 'RATE_LIMITED', '60'); // independently hit the row cooldown
    now += 60_001;
    expect(accepted(await request())).toEqual(first); // durable replay after cooldown
    envelope(await request('request-1', 'other@example.com'), 422, 'IDEMPOTENCY_KEY_REUSED');
    hit.mockRestore();
    const quota = await setup(); // Quotas get an independent fixture; the replay refusal above counted.
    accepted(await quota.request('quota-key-1'));
    now += 60_001;
    accepted(await quota.request('quota-key-2'));
    now += 60_001;
    accepted(await quota.request('quota-key-3'));
    now += 60_001;
    envelope(await quota.request('quota-key-4'), 429, 'RATE_LIMITED', '3600');
  }, 10_000);

  it('charges all four quota windows for 404, including repeat keys and distinct addresses', async () => {
    const { request } = await setup(null);
    for (let i = 0; i < 3; i++) {
      envelope(await request(), 404, 'RECOVERY_ACCOUNT_NOT_FOUND');
      now += 60_001;
    }
    envelope(await request(), 429, 'RATE_LIMITED', '3600');
    const ipMinute = await setup(null);
    for (let i = 0; i < 10; i++) {
      envelope(
        await ipMinute.request(`ip-minute-${i}`, `missing-${i}@example.com`),
        404,
        'RECOVERY_ACCOUNT_NOT_FOUND',
      );
    }
    envelope(
      await ipMinute.request('ip-minute-10', 'missing-10@example.com'),
      429,
      'RATE_LIMITED',
      '60',
    );
    const ipHour = await setup(null);
    for (let i = 0; i < 50; i++) {
      if (i % 10 === 0) now += 60_001;
      envelope(
        await ipHour.request(`ip-hour-${i}`, `absent-${i}@example.com`),
        404,
        'RECOVERY_ACCOUNT_NOT_FOUND',
      );
    }
    now += 60_001;
    envelope(
      await ipHour.request('ip-hour-50', 'absent-50@example.com'),
      429,
      'RATE_LIMITED',
      '3600',
    );
  }, 25_000);

  it('maps invalid proof and password validation errors, then completes with an empty 204', async () => {
    const { app, request, sink } = await setup();
    const first = accepted(await request());
    const payload = {
      email,
      challengeId: first.challengeId,
      code: sink.sent[0]!.code,
      password: 'NewPass1!',
    };
    const complete = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password-recovery/complete',
        payload: body as any,
        headers: { 'idempotency-key': 'complete-1' },
      });
    const weak = await complete({ ...payload, password: 'weak' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
      field_errors: expect.arrayContaining([expect.objectContaining({ field: 'password' })]),
    });
    envelope(
      await complete({ ...payload, code: payload.code === '000000' ? '111111' : '000000' }),
      400,
      'RECOVERY_INVALID',
    );
    const success = await complete(payload);
    expect(success.statusCode).toBe(204);
    expect(success.body).toBe('');
  });

  it('verify validates six digits, rejects a wrong OTP, then returns empty 204 without consuming it', async () => {
    const { app, request, sink } = await setup();
    const first = accepted(await request());
    const payload = { email, challengeId: first.challengeId, code: sink.sent[0]!.code };
    const verify = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password-recovery/verify',
        payload: body as any,
        headers: { 'idempotency-key': 'verify-same-key' },
      });
    for (const body of [
      { ...payload, code: '12345' },
      { ...payload, challengeId: 'bad-id' },
      { ...payload, email: 'bad-email' },
    ]) {
      const response = await verify(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    envelope(
      await verify({ ...payload, code: payload.code === '000000' ? '111111' : '000000' }),
      400,
      'RECOVERY_INVALID',
    );
    for (let i = 0; i < 2; i++) {
      const response = await verify(payload);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    }
    const completed = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-recovery/complete',
      payload: { ...payload, password: 'NewPass1!' },
      headers: { 'idempotency-key': 'verify-completion' },
    });
    expect(completed.statusCode).toBe(204);
    envelope(await verify(payload), 400, 'RECOVERY_INVALID');
  });
});
