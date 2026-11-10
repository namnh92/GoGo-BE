import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  NoopMetrics,
  RUNTIME_METRICS,
  reportRecoveryMailFailure,
  type MetricsPort,
} from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { RecoveryRepository } from '../infrastructure/recovery.repository';
import { RecoveryMailSender, type RecoveryMail } from '../infrastructure/recovery-mail';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../presentation/rate-limit.service';
import type { RecoveryCompleteDto, RecoveryRequestDto } from '../presentation/dtos';
import { PasswordService } from './password.service';
import { SessionRevocationService } from './session-revocation.service';

export class RecoveryCrypto {
  constructor(private readonly key: string) {}

  digest(purpose: string, ...parts: string[]): string {
    if (this.key.length < 32) {
      throw AppError.serviceUnavailable(
        'RECOVERY_UNAVAILABLE',
        'Password recovery requires a managed recovery key',
        false,
      );
    }
    return createHmac('sha256', this.key)
      .update(JSON.stringify(['consumer-recovery-v1', purpose, ...parts]))
      .digest('hex');
  }

  matches(left: string, right: string): boolean {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  }
}

type RecoveryContext = { ip: string; key?: string | undefined };
export type RecoveryResponse = {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
};
export type RecoveryReplay = {
  fingerprint: string;
  body: RecoveryResponse | null;
  expiresAt: Date;
};
export type RecoveryChallenge = {
  id: string;
  emailDigest: string;
  userId: string | null;
  codeDigest: string;
  attempts: number;
  expiresAt: Date;
  resendAvailableAt: Date;
  consumedAt: Date | null;
};

const invalid = () => AppError.badRequest('RECOVERY_INVALID', 'Recovery proof is not valid');

@Injectable()
export class PasswordRecoveryService {
  constructor(
    private readonly repo: RecoveryRepository,
    private readonly passwords: PasswordService,
    private readonly revocations: SessionRevocationService,
    @Inject(RATE_LIMIT_STORE) private readonly limits: RateLimitStore,
    private readonly crypto: RecoveryCrypto,
    private readonly mail: RecoveryMailSender,
    @Optional() @Inject(RUNTIME_METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async request(input: RecoveryRequestDto, context: RecoveryContext): Promise<RecoveryResponse> {
    const started = performance.now();
    this.metrics.increment('password_recovery_requested');
    try {
      this.mail.assertConfigured();
      const email = input.email.trim().toLowerCase();
      const digest = this.crypto.digest('email', email);
      await this.limit('request', digest, context.ip);
      const replay = this.replay('request', { email }, context);
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const id = randomUUID();
      const result = await this.repo.transaction(
        digest,
        email,
        'request',
        replay.key,
        async (tx) => {
          const current = await tx.getChallenge();
          if (current && current.resendAvailableAt.getTime() > Date.now()) {
            throw AppError.tooManyRequests(
              'Rate limit exceeded',
              Math.ceil((current.resendAvailableAt.getTime() - Date.now()) / 1000),
            );
          }
          const user = tx.user;
          const eligible =
            user?.status === 'active' && !!user.passwordHash && user.email?.toLowerCase() === email;
          const stored = await tx.getReplay(replay.key);
          if (stored) {
            this.checkReplay(stored, replay.fingerprint);
            return { body: stored.body!, deliver: false, user: null, notFound: !eligible };
          }
          const challenge: RecoveryChallenge = {
            id,
            emailDigest: digest,
            userId: eligible ? user.id : null,
            codeDigest: this.crypto.digest('proof', digest, id, code),
            attempts: 0,
            expiresAt: new Date(Date.now() + 300_000),
            resendAvailableAt: new Date(Date.now() + 60_000),
            consumedAt: null,
          };
          await tx.replaceChallenge(challenge);
          const body = {
            challengeId: id,
            expiresAt: challenge.expiresAt.toISOString(),
            resendAvailableAt: challenge.resendAvailableAt.toISOString(),
          };
          await tx.saveReplay(replay.key, {
            fingerprint: replay.fingerprint,
            body,
            expiresAt: new Date(Date.now() + 86_400_000),
          });
          return { body, deliver: true, user: eligible ? user : null, notFound: !eligible };
        },
      );
      if (result.deliver) {
        // Keep provider latency outside the response for both eligible and decoy work.
        // The adapter bounds delivery; contain even reporting failures in this detached task.
        void this.deliver(
          digest,
          id,
          result.user
            ? {
                email,
                code,
                challengeId: id,
                expiresAt: new Date(result.body.expiresAt),
                locale: result.user.locale === 'en' ? 'en' : 'vi',
              }
            : null,
        ).catch(() => undefined);
      }
      // Commit decoy work too: cooldown and bounded persistence remain equivalent.
      if (result.notFound) {
        throw new AppError('RECOVERY_ACCOUNT_NOT_FOUND', 'Tài khoản không tồn tại', 404, {
          retryable: false,
        });
      }
      return result.body;
    } catch (error) {
      this.failed('request', error);
      throw error instanceof AppError
        ? error
        : AppError.serviceUnavailable(
            'RECOVERY_UNAVAILABLE',
            'Password recovery is temporarily unavailable',
          );
    } finally {
      await delay(Math.max(0, 250 - (performance.now() - started)));
      this.metrics.observe(
        'password_recovery_duration_seconds',
        (performance.now() - started) / 1000,
        { action: 'request' },
      );
    }
  }

  async complete(input: RecoveryCompleteDto, context: RecoveryContext): Promise<void> {
    const started = performance.now();
    try {
      this.mail.assertConfigured();
      const email = input.email.trim().toLowerCase();
      const digest = this.crypto.digest('email', email);
      await this.limit('complete', digest, context.ip);
      const replay = this.replay('complete', { ...input, email }, context);
      // Equal expensive password work for decoys and invalid proofs; no provider call under locks.
      const hash = await this.passwords.hash(input.password);
      const result = await this.repo.transaction(
        digest,
        email,
        'complete',
        replay.key,
        async (tx) => {
          const stored = await tx.getReplay(replay.key);
          if (stored) {
            this.checkReplay(stored, replay.fingerprint);
            return { valid: true, ids: [], replay: true };
          }
          const challenge = await tx.getChallenge();
          const expected = challenge?.codeDigest ?? this.crypto.digest('proof', 'dummy');
          const match = this.crypto.matches(
            expected,
            this.crypto.digest('proof', digest, input.challengeId, input.code),
          );
          const user = tx.user;
          const live =
            challenge &&
            challenge.id === input.challengeId &&
            !challenge.consumedAt &&
            challenge.expiresAt.getTime() > Date.now() &&
            challenge.attempts < 5;
          if (
            !live ||
            !match ||
            !user ||
            user.id !== challenge.userId ||
            user.status !== 'active' ||
            !user.passwordHash ||
            user.email?.toLowerCase() !== email
          ) {
            if (live) await tx.failAttempt();
            return { valid: false, ids: [], replay: false };
          }
          const ids = await tx.reset(hash);
          await tx.saveReplay(replay.key, {
            fingerprint: replay.fingerprint,
            body: null,
            expiresAt: new Date(Date.now() + 86_400_000),
          });
          return { valid: true, ids, replay: false };
        },
      );
      // A rejected attempt must commit its counter before throwing.
      if (!result.valid) throw invalid();
      await this.revocations.revokeMany(result.ids);
      if (!result.replay) this.metrics.increment('password_recovery_completed');
    } catch (error) {
      this.failed('complete', error);
      throw error instanceof AppError
        ? error
        : AppError.serviceUnavailable(
            'RECOVERY_UNAVAILABLE',
            'Password recovery is temporarily unavailable',
          );
    } finally {
      this.metrics.observe(
        'password_recovery_duration_seconds',
        (performance.now() - started) / 1000,
        { action: 'complete' },
      );
    }
  }

  private async deliver(digest: string, id: string, message: RecoveryMail | null): Promise<void> {
    try {
      await this.mail.send(message);
      if (message) {
        this.metrics.increment('password_recovery_sent', { adapter: this.mail.adapter });
      }
    } catch {
      // ID matching protects a newer resend if this delivery fails after its response.
      await this.repo.invalidate(digest, id).catch(() => undefined);
      this.metrics.increment('password_recovery_failed', { action: 'send' });
      // Never pass the provider error, recipient, proof, or challenge to reporting.
      reportRecoveryMailFailure();
    }
  }

  private replay(action: string, body: unknown, context: RecoveryContext) {
    if (context.key !== undefined && !/^[\w-]{8,128}$/.test(context.key)) {
      throw AppError.badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 chars');
    }
    return {
      key: this.crypto.digest('replay-key', action, context.ip, context.key ?? randomUUID()),
      fingerprint: this.crypto.digest('replay-body', action, JSON.stringify(body)),
    };
  }

  private checkReplay(stored: RecoveryReplay, fingerprint: string): void {
    if (!this.crypto.matches(stored.fingerprint, fingerprint)) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different request body',
        422,
      );
    }
  }

  private async limit(action: 'request' | 'complete', digest: string, ip: string): Promise<void> {
    const windows =
      action === 'request'
        ? ([
            ['email-minute', digest, 60, 1],
            ['email-hour', digest, 3600, 3],
            ['ip-minute', this.crypto.digest('ip', ip), 60, 10],
            ['ip-hour', this.crypto.digest('ip', ip), 3600, 50],
          ] as const)
        : ([
            ['email-quarter', digest, 900, 10],
            ['ip-quarter', this.crypto.digest('ip', ip), 900, 30],
          ] as const);
    const results = await Promise.all(
      windows.map(async ([name, identity, seconds, max]) => ({
        seconds,
        count: await this.limits.hit(`recovery|${action}|${name}|${identity}`, seconds),
        max,
      })),
    );
    const refused = results.find((value) => value.count > value.max);
    if (refused) throw AppError.tooManyRequests('Rate limit exceeded', refused.seconds);
  }

  private failed(action: 'request' | 'complete', error: unknown): void {
    if (error instanceof AppError && error.httpStatus === 429) {
      this.metrics.increment('password_recovery_throttled', { action });
    } else if (error instanceof AppError && error.code === 'RECOVERY_ACCOUNT_NOT_FOUND') {
      this.metrics.increment('password_recovery_not_found');
    } else {
      this.metrics.increment('password_recovery_failed', { action });
    }
  }
}
