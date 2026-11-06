import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppExceptionFilter } from '../../../../apps/api/src/common/filters/app-exception.filter';
import { PasswordRecoveryService, RecoveryCrypto, type RecoveryChallenge, type RecoveryReplay } from '../application/password-recovery.service';
import type { PasswordService } from '../application/password.service';
import type { SessionRevocationService } from '../application/session-revocation.service';
import type { RecoveryRepository, RecoveryTransaction } from '../infrastructure/recovery.repository';
import { RecoveryMailSink } from '../infrastructure/recovery-mail';
import { PasswordRecoveryController } from './password-recovery.controller';
import { InMemoryRateLimitStore } from './rate-limit.service';

// Real controller, validation pipe, service and exception filter; no listening socket or database.
describe('password recovery HTTP privacy contract', () => {
  const apps: NestFastifyApplication[] = [];
  const email = 'person@example.com';
  const active = { id: 'original-user', email, status: 'active', passwordHash: 'old-hash', emailVerifiedAt: null };
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
    let challenge: RecoveryChallenge | undefined;
    const replays = new Map<string, RecoveryReplay>();
    const sink = new RecoveryMailSink();
    const store = new InMemoryRateLimitStore();
    const transaction = async <T,>(_digest: string, _email: string, _mode: string, _key: string, work: (tx: RecoveryTransaction) => Promise<T>) => work({
      user,
      getChallenge: async () => challenge,
      replaceChallenge: async (value) => { challenge = value; },
      getReplay: async (key) => replays.get(key),
      saveReplay: async (key, value) => { replays.set(key, value); },
      failAttempt: async () => { challenge!.attempts += 1; },
      reset: async () => { challenge!.consumedAt = new Date(now); return ['family-a', 'family-b']; },
    });
    const service = new PasswordRecoveryService(
      { transaction, invalidate: async () => { challenge!.consumedAt = new Date(now); } } as unknown as RecoveryRepository,
      { hash: async () => 'new-hash' } as unknown as PasswordService,
      { revokeMany: async () => undefined } as unknown as SessionRevocationService,
      store, new RecoveryCrypto('x'.repeat(48)), sink,
    );
    @Module({ controllers: [PasswordRecoveryController], providers: [{ provide: PasswordRecoveryService, useValue: service }] })
    class Harness {}
    const app = await NestFactory.create<NestFastifyApplication>(Harness, new FastifyAdapter({ genReqId: () => 'privacy-request' }), { logger: false });
    apps.push(app);
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const request = (key = 'request-1', address = email) => app.inject({
      method: 'POST', url: '/v1/auth/password-recovery/request', payload: { email: address }, headers: { 'idempotency-key': key },
    });
    return { app, request, store, sink };
  }

  function accepted(response: Awaited<ReturnType<NestFastifyApplication['inject']>>) {
    expect(response.statusCode).toBe(202);
    expect(response.headers['retry-after']).toBeUndefined();
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresAt', 'resendAvailableAt']);
    expect(body.challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    expect(new Date(body.resendAvailableAt).toISOString()).toBe(body.resendAvailableAt);
    expect(JSON.stringify(body)).not.toContain(email);
    return body;
  }

  it('returns equal 202 shapes and exact lifetimes for verified, unverified and every ineligible identity', async () => {
    for (const user of [active, { ...active, emailVerifiedAt: new Date(now) }, null,
      { ...active, status: 'suspended' }, { ...active, status: 'banned' }, { ...active, status: 'deleted' },
      { ...active, passwordHash: null }, { ...active, email: null, passwordHash: null }]) {
      const { request } = await setup(user);
      const body = accepted(await request());
      expect(Date.parse(body.expiresAt) - now).toBe(300_000);
      expect(Date.parse(body.resendAvailableAt) - now).toBe(60_000);
    }
  });

  it('keeps eligible-only delivery failure at HTTP 202', async () => {
    const { request, sink } = await setup();
    vi.spyOn(sink, 'send').mockRejectedValue(new Error('eligible-only mail failure'));
    accepted(await request());
  });

  function envelope(response: Awaited<ReturnType<NestFastifyApplication['inject']>>, status: number, code: string, retryAfter?: string) {
    expect(response.statusCode).toBe(status);
    expect(response.headers['retry-after']).toBe(retryAfter);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['code', 'field_errors', 'message', 'request_id', 'retryable']);
    expect(body).toMatchObject({ code, field_errors: [], request_id: 'privacy-request', retryable: status === 429 });
    expect(typeof body.message).toBe('string');
    return body;
  }

  it('keeps cooldown, replay, body conflict and quota envelopes equal across eligibility', async () => {
    const outcomes = [];
    for (const user of [active, null]) {
      const { request, store } = await setup(user);
      const first = accepted(await request());
      const minute = envelope(await request(), 429, 'RATE_LIMITED', '60'); // replay counts before lookup
      const hit = vi.spyOn(store, 'hit').mockResolvedValue(1);
      const cooldown = envelope(await request(), 429, 'RATE_LIMITED', '60'); // independently hit the row cooldown
      now += 60_001;
      expect(accepted(await request())).toEqual(first); // durable replay after cooldown
      const conflict = envelope(await request('request-1', 'other@example.com'), 422, 'IDEMPOTENCY_KEY_REUSED');
      hit.mockRestore();
      const quota = await setup(user); // Quotas get an independent fixture; the replay refusal above counted.
      accepted(await quota.request('quota-key-1'));
      now += 60_001;
      accepted(await quota.request('quota-key-2'));
      now += 60_001;
      accepted(await quota.request('quota-key-3'));
      now += 60_001;
      const hour = envelope(await quota.request('quota-key-4'), 429, 'RATE_LIMITED', '3600');
      outcomes.push({ minute, cooldown, conflict, hour });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  }, 10_000);

  it('maps invalid proof and password validation errors, then completes with an empty 204', async () => {
    const { app, request, sink } = await setup();
    const first = accepted(await request());
    const payload = { email, challengeId: first.challengeId, code: sink.sent[0]!.code, password: 'NewPass1!' };
    const complete = (body: unknown) => app.inject({ method: 'POST', url: '/v1/auth/password-recovery/complete', payload: body as any, headers: { 'idempotency-key': 'complete-1' } });
    const weak = await complete({ ...payload, password: 'weak' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false, field_errors: expect.arrayContaining([expect.objectContaining({ field: 'password' })]) });
    envelope(await complete({ ...payload, code: payload.code === '000000' ? '111111' : '000000' }), 400, 'RECOVERY_INVALID');
    const success = await complete(payload);
    expect(success.statusCode).toBe(204);
    expect(success.body).toBe('');
  });
});
