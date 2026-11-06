import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type * as TimersPromises from 'node:timers/promises';
import { NoopMetrics, type MetricsPort } from '@gogo/observability';
import { PasswordRecoveryService, RecoveryCrypto } from './password-recovery.service';
import { RecoveryMailSink, UnconfiguredRecoveryMailSender } from '../infrastructure/recovery-mail';
import type { RecoveryRepository } from '../infrastructure/recovery.repository';
import { InMemoryRateLimitStore } from '../presentation/rate-limit.service';
import { recoveryCompleteSchema } from '../presentation/dtos';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';

// Verify the padding policy without depending on real timer scheduling.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

describe('consumer password recovery', () => {
  afterEach(() => vi.restoreAllMocks());
  let now: number;
  let user: any;
  let challenge: any;
  let sessions: string[];
  let attempts: number;
  let audit: number;
  let records: Map<string, any>;
  let sink: RecoveryMailSink;
  let service: PasswordRecoveryService;
  let store: InMemoryRateLimitStore;
  let crypto: RecoveryCrypto;
  let repo: any;
  let settlements: string[];
  let revokeMany: ReturnType<typeof vi.fn>;
  let metrics: MetricsPort;
  const ctx = (key: string) => ({ ip: '127.0.0.1', key });
  const email = 'person@example.com';
  const body = () => ({
    email,
    challengeId: challenge.id,
    code: sink.sent.at(-1)!.code,
    password: 'NewPass1!',
  });

  function setup() {
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    user = {
      id: 'original-user',
      email,
      status: 'active',
      passwordHash: 'old-hash',
      emailVerifiedAt: null,
    };
    challenge = undefined;
    sessions = ['family-a-session', 'family-b-session'];
    attempts = 4;
    audit = 0;
    records = new Map();
    sink = new RecoveryMailSink();
    store = new InMemoryRateLimitStore();
    crypto = new RecoveryCrypto('x'.repeat(48));
    settlements = [];
    metrics = new NoopMetrics();
    revokeMany = vi.fn(async (_ids: string[]) => {
      expect(settlements.at(-1)).toBe('committed');
    });
    let tail = Promise.resolve();
    repo = {
      transaction: (_digest: string, _email: string, _mode: string, _key: string, work: any) => {
        const result = tail.then(() =>
          work({
            user,
            getChallenge: async () => challenge,
            replaceChallenge: async (value: any) => {
              challenge = value;
            },
            getReplay: async (key: string) => records.get(key),
            saveReplay: async (key: string, value: any) => {
              records.set(key, value);
            },
            failAttempt: async () => {
              challenge.attempts += 1;
            },
            reset: async (hash: string) => {
              challenge.consumedAt = new Date(now);
              user.passwordHash = hash;
              user.emailVerifiedAt ??= new Date(now);
              const revoked = sessions;
              sessions = [];
              attempts = 0;
              audit += 1;
              return revoked;
            },
          }),
        );
        const settled = result.then(
          (value: unknown) => {
            settlements.push('committed');
            return value;
          },
          (error: unknown) => {
            settlements.push('rolled-back');
            throw error;
          },
        );
        tail = settled.then(
          () => undefined,
          () => undefined,
        );
        return settled;
      },
      invalidate: vi.fn(async (_digest: string, id: string) => {
        if (challenge?.id === id) challenge.consumedAt = new Date(now);
      }),
    };
    service = new PasswordRecoveryService(
      repo as unknown as RecoveryRepository,
      { hash: vi.fn(async () => 'new-hash') } as any,
      { revokeMany } as any,
      store,
      crypto,
      sink,
      metrics,
    );
  }

  beforeEach(() => {
    setup();
    vi.mocked(delay).mockClear();
  });

  it('uses the same response and bounded sink work for eligible, unknown, disabled and passwordless identities', async () => {
    const active = { ...user };
    for (const candidate of [
      active,
      { ...active, emailVerifiedAt: new Date() },
      undefined,
      { ...active, status: 'suspended' },
      { ...active, status: 'banned' },
      { ...active, status: 'deleted' },
      { ...active, passwordHash: null },
      { ...active, email: null, passwordHash: null },
    ]) {
      setup(); // Rebuild the injected limiter, repository, mail and service together.
      user = candidate;
      const send = vi.spyOn(sink, 'send');
      const response = await service.request({ email }, ctx('request-1'));
      expect(Object.keys(response).sort()).toEqual([
        'challengeId',
        'expiresAt',
        'resendAvailableAt',
      ]);
      expect(response.challengeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(Date.parse(response.expiresAt) - now).toBe(300_000);
      expect(Date.parse(response.resendAvailableAt) - now).toBe(60_000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0] !== null).toBe(
        candidate?.status === 'active' && !!candidate.passwordHash,
      );
    }
  });

  it('allows only one concurrent completion with different retry keys', async () => {
    await service.request({ email }, ctx('request-1'));
    const input = body();
    const results = await Promise.allSettled([
      service.complete(input, ctx('complete-1')),
      service.complete(input, ctx('complete-2')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(audit).toBe(1);
  });

  it('preserves an existing verification timestamp', async () => {
    const verifiedAt = new Date(now - 86_400_000);
    user.emailVerifiedAt = verifiedAt;
    await service.request({ email }, ctx('request-1'));
    await service.complete(body(), ctx('complete-1'));
    expect(user.emailVerifiedAt).toBe(verifiedAt);
  });

  it('verifies unverified email, revokes every family, clears lockout and audits once; proof is single use', async () => {
    await service.request({ email }, ctx('request-1'));
    const input = body();
    await service.complete(input, ctx('complete-1'));
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).toBe('new-hash');
    expect(sessions).toEqual([]);
    expect(revokeMany).toHaveBeenCalledExactlyOnceWith(['family-a-session', 'family-b-session']);
    expect(attempts).toBe(0);
    expect(audit).toBe(1);
    await expect(service.complete(input, ctx('complete-2'))).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
    await service.complete(input, ctx('complete-1'));
    expect(audit).toBe(1);
  });

  it('expires at five minutes and never stores the raw code', async () => {
    await service.request({ email }, ctx('request-1'));
    const input = body();
    expect(JSON.stringify(challenge)).not.toContain(input.code);
    now += 300_000;
    await expect(service.complete(input, ctx('complete-1'))).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
  });

  it('commits five bad attempts then rejects the correct code', async () => {
    await service.request({ email }, ctx('request-1'));
    const input = body();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.complete(
          { ...input, code: input.code === '000000' ? '111111' : '000000' },
          ctx(`wrong-key-${i}`),
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
    }
    expect(challenge.attempts).toBe(5);
    expect(settlements).toEqual(Array(6).fill('committed'));
    await expect(service.complete(input, ctx('complete-1'))).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
  });

  it('resend invalidates the previous proof while durable request replay survives it', async () => {
    const first = await service.request({ email }, ctx('request-1'));
    const old = body();
    now += 60_001;
    const second = await service.request({ email }, ctx('request-2'));
    expect(second.challengeId).not.toBe(first.challengeId);
    const fresh = body();
    await expect(service.complete(old, ctx('complete-1'))).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
    now += 60_001;
    expect(await service.request({ email }, ctx('request-1'))).toEqual(first);
    expect(challenge.id).toBe(second.challengeId);
    await service.complete(fresh, ctx('complete-fresh'));
    expect(user.passwordHash).toBe('new-hash');
    await expect(
      service.request({ email: 'other@example.com' }, ctx('request-1')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('does not rebind a proof to a replacement account', async () => {
    await service.request({ email }, ctx('request-1'));
    const input = body();
    user = { ...user, id: 'replacement-user' };
    await expect(service.complete(input, ctx('complete-1'))).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
  });

  it('reuses the register password validator and password field error', () => {
    expect(() =>
      new ZodValidationPipe(recoveryCompleteSchema).transform({
        email,
        challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        code: '123456',
        password: 'weak',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        options: expect.objectContaining({
          fieldErrors: expect.arrayContaining([expect.objectContaining({ field: 'password' })]),
        }),
      }),
    );
  });

  it('rate limits replays and decoys with the existing retry envelope and distinct windows', async () => {
    const hit = vi.spyOn(store, 'hit');
    await service.request({ email }, ctx('request-1'));
    await expect(service.request({ email }, ctx('request-1'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      options: { retryable: true, retryAfterSeconds: 60 },
    });
    const keys = hit.mock.calls.slice(0, 4).map(([key]) => key);
    expect(new Set(keys).size).toBe(4);
    expect(keys.join()).not.toContain(email);
    user = undefined;
    now += 60_001;
    await service.request({ email }, ctx('request-2'));
    now += 60_001;
    await expect(service.request({ email }, ctx('request-3'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      options: { retryAfterSeconds: 3600 },
    });
  });

  it('hides eligible-only delivery errors and invalidates that proof', async () => {
    vi.spyOn(sink, 'send').mockRejectedValue(new Error('do not expose'));
    await expect(service.request({ email }, ctx('request-1'))).resolves.toHaveProperty(
      'challengeId',
    );
    expect(challenge.consumedAt).toBeTruthy();
  });

  it('emits only finite recovery labels across success, send failure, failures and throttling', async () => {
    const increment = vi.spyOn(metrics, 'increment');
    const observe = vi.spyOn(metrics, 'observe');
    await service.request({ email }, ctx('request-1'));
    const input = body();
    await service.complete(input, ctx('complete-1'));
    await expect(service.complete(input, ctx('complete-2'))).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
    await expect(service.request({ email }, ctx('request-1'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    now += 60_001;
    vi.spyOn(sink, 'send').mockRejectedValue(new Error(email));
    await service.request({ email }, ctx('request-2'));
    vi.spyOn(store, 'hit').mockResolvedValue(100);
    await expect(service.complete(input, ctx('complete-3'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    vi.mocked(store.hit).mockRejectedValue(new Error(input.code));
    await expect(service.request({ email }, ctx('request-3'))).rejects.toMatchObject({
      code: 'RECOVERY_UNAVAILABLE',
    });
    expect(increment.mock.calls).toEqual([
      ['password_recovery_requested'],
      ['password_recovery_sent', { adapter: 'sink' }],
      ['password_recovery_completed'],
      ['password_recovery_failed', { action: 'complete' }],
      ['password_recovery_requested'],
      ['password_recovery_throttled', { action: 'request' }],
      ['password_recovery_requested'],
      ['password_recovery_failed', { action: 'send' }],
      ['password_recovery_throttled', { action: 'complete' }],
      ['password_recovery_requested'],
      ['password_recovery_failed', { action: 'request' }],
    ]);
    expect(
      observe.mock.calls.map(([name, seconds, labels]: any) => {
        expect(seconds).toBeGreaterThanOrEqual(0);
        return [name, labels];
      }),
    ).toEqual(
      ['request', 'complete', 'complete', 'request', 'request', 'complete', 'request'].map(
        (action) => ['password_recovery_duration_seconds', { action }],
      ),
    );
    const emitted = JSON.stringify([increment.mock.calls, observe.mock.calls]);
    for (const secret of [email, input.code, challenge.codeDigest, challenge.emailDigest])
      expect(emitted).not.toContain(secret);
  });

  it('production stub fails before lookup with a typed configuration error', async () => {
    expect(() => new UnconfiguredRecoveryMailSender().assertConfigured()).toThrow(
      expect.objectContaining({ code: 'RECOVERY_MAIL_NOT_CONFIGURED', httpStatus: 503 }),
    );
  });

  it('rejects configuration and limiter outages before account lookup, without leaking dependency messages', async () => {
    const transaction = vi.spyOn(repo, 'transaction');
    vi.spyOn(sink, 'assertConfigured').mockImplementation(() =>
      new UnconfiguredRecoveryMailSender().assertConfigured(),
    );
    await expect(service.request({ email }, ctx('request-1'))).rejects.toMatchObject({
      code: 'RECOVERY_MAIL_NOT_CONFIGURED',
    });
    expect(transaction).not.toHaveBeenCalled();
    vi.mocked(sink.assertConfigured).mockImplementation(() => undefined);
    vi.spyOn(store, 'hit').mockRejectedValue(new Error(`do not expose ${email}`));
    await expect(service.request({ email }, ctx('request-2'))).rejects.toMatchObject({
      code: 'RECOVERY_UNAVAILABLE',
      message: 'Password recovery is temporarily unavailable',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('applies the IP request limit across different missing emails', async () => {
    user = undefined;
    for (let i = 0; i < 10; i += 1) {
      challenge = undefined; // each email has its own row in the real repository
      await service.request({ email: `missing-${i}@example.com` }, ctx(`request-key-${i}`));
    }
    await expect(
      service.request({ email: 'last@example.com' }, ctx('request-last')),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', options: { retryAfterSeconds: 60 } });
  });

  it('limits completion even for nonexistent challenges', async () => {
    user = undefined;
    for (let i = 0; i < 10; i += 1) {
      await expect(
        service.complete(
          { email, challengeId: 'missing', code: '000000', password: 'NewPass1!' },
          ctx(`complete-key-${i}`),
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
    }
    await expect(
      service.complete(
        { email, challengeId: 'missing', code: '000000', password: 'NewPass1!' },
        ctx('complete-last'),
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', options: { retryAfterSeconds: 900 } });
  });

  it.each([
    [0, 250],
    [100, 150],
    [250, 0],
    [300, 0],
  ])('after %ims of work requests %ims of padding', async (elapsed, padding) => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValue(1000 + elapsed);
    await service.request({ email }, ctx('request-1'));
    expect(delay).toHaveBeenCalledExactlyOnceWith(padding);
  });

  it('applies the same padding policy to missing identities and request failures', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    user = undefined;
    await service.request({ email }, ctx('request-1'));
    expect(delay).toHaveBeenCalledExactlyOnceWith(250);

    vi.mocked(delay).mockClear();
    vi.spyOn(sink, 'assertConfigured').mockImplementation(() =>
      new UnconfiguredRecoveryMailSender().assertConfigured(),
    );
    await expect(service.request({ email }, ctx('request-2'))).rejects.toMatchObject({
      code: 'RECOVERY_MAIL_NOT_CONFIGURED',
    });
    expect(delay).toHaveBeenCalledExactlyOnceWith(250);
  });

  it('domain separates email, proof and idempotency HMACs', () => {
    expect(
      new Set(['email', 'proof', 'replay'].map((purpose) => crypto.digest(purpose, 'same'))).size,
    ).toBe(3);
  });
});
