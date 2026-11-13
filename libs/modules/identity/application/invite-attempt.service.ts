import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { NoopMetrics, RUNTIME_METRICS, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG } from '../../shared/config';
import { AppError } from '../../shared/app-error';
import {
  InviteAttemptRepository,
  type InviteContext,
} from '../infrastructure/invite-attempt.repository';
import {
  CONTEXT_TTL_MS,
  InviteAttemptCrypto,
  inviteContextRequired,
  inviteLookupUnavailable,
  type InviteTransport,
} from './invite-attempt-crypto';

export type InviteAttemptRequest = {
  ip: string;
  key?: string | undefined;
  headerProof?: string | undefined;
  cookieProof?: string | undefined;
  csrf?: string | undefined;
  origin?: string | undefined;
  fetchSite?: string | undefined;
};
export type InviteBootstrapResult = {
  expiresAt: string;
  contextToken?: string;
  csrfToken?: string;
};
export type InviteBootstrapOutput = {
  body: InviteBootstrapResult;
  cookie?: string;
  maxAge: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const csrfFailed = () => AppError.forbidden('CSRF_FAILED', 'Invite CSRF validation failed');

/** Canonical IP + independent IPv6 /64, from the vetted edge hop or req.ip only. */
export function inviteIpBuckets(ip: string): { ip: string; prefix: string } {
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (isIP(ip) === 4) return { ip, prefix: ip.split('.').slice(0, 3).join('.') + '.0/24' };
  if (isIP(ip) !== 6) throw inviteLookupUnavailable();
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = normalized.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const parts =
    right === undefined
      ? start
      : [...start, ...Array<string>(8 - start.length - end.length).fill('0'), ...end];
  return {
    ip: parts.map((part) => part.padStart(4, '0')).join(':'),
    prefix:
      parts
        .slice(0, 4)
        .map((part) => part.padStart(4, '0'))
        .join(':') + '::/64',
  };
}

@Injectable()
export class InviteAttemptService {
  constructor(
    private readonly repo: InviteAttemptRepository,
    private readonly crypto: InviteAttemptCrypto,
    @Inject(APP_CONFIG) private readonly config: { CORS_ORIGINS?: string[] },
    @Optional() @Inject(RUNTIME_METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async bootstrap(
    transport: InviteTransport,
    request: InviteAttemptRequest,
  ): Promise<InviteBootstrapOutput> {
    return this.protected('bootstrap', async () => {
      this.crypto.assertConfigured();
      const ips = inviteIpBuckets(request.ip);
      await this.repo.limit([
        { key: this.crypto.digest('bucket', 'global'), limit: 1000 },
        { key: this.crypto.digest('bucket', 'ip', ips.ip), limit: 10 },
        { key: this.crypto.digest('bucket', 'prefix', ips.prefix), limit: 30 },
      ]);
      if (!request.key || !UUID.test(request.key))
        throw AppError.badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID');
      if (transport === 'BROWSER_COOKIE') this.browserOrigin(request);
      else if (request.origin !== undefined) throw csrfFailed();
      const proof = this.transportProof(transport, request);
      const hash = proof === undefined ? undefined : this.crypto.proofHash(proof);
      // Proof-bearing bootstrap is resource-scoped; first bootstrap is the approved IP exception.
      const key = this.crypto.digest('bootstrap-replay', hash ?? ips.ip, request.key.toLowerCase());
      const fingerprint = this.crypto.digest('bootstrap-body', transport, hash ?? 'first');
      const result = await this.repo.transaction(key, async (tx) => {
        if (hash !== undefined) {
          const current = this.valid(await tx.findProof(hash), tx.now, transport);
          if (transport === 'BROWSER_COOKIE') this.browserCsrf(current, request);
          return this.output(current, proof!, tx.now);
        }
        const replay = await tx.replay();
        if (replay) {
          if (replay.fingerprint !== fingerprint)
            throw new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key reused with different input',
              422,
            );
          // Replay revalidates concrete context expiry/revocation. Never resurrect a proof.
          const context = this.valid(await tx.findId(replay.contextId), tx.now, transport);
          if (replay.expiresAt.getTime() <= tx.now.getTime()) throw inviteContextRequired();
          const token = this.crypto.open(
            replay.ciphertext,
            JSON.stringify([key, transport, context.id]),
          );
          if (this.crypto.proofHash(token) !== context.proofHash) throw inviteLookupUnavailable();
          return this.output(context, token, tx.now);
        }
        const token = this.crypto.token();
        const context: InviteContext = {
          id: randomUUID(),
          proofHash: this.crypto.proofHash(token),
          purpose: 'invite_attempts',
          transport,
          createdAt: tx.now,
          expiresAt: new Date(tx.now.getTime() + CONTEXT_TTL_MS),
          revokedAt: null,
        };
        await tx.create(context, {
          key,
          fingerprint,
          contextId: context.id,
          ciphertext: this.crypto.seal(token, JSON.stringify([key, transport, context.id])),
          expiresAt: context.expiresAt,
        });
        return this.output(context, token, tx.now);
      });
      this.metrics.increment('invite_context_bootstrap_total', {
        operation: 'bootstrap',
        result: proof === undefined ? 'created_or_replayed' : 'reused',
      });
      return result;
    });
  }

  /** Read-only browser recovery; deliberately separate from mutation validation. */
  async recoverCsrf(
    request: InviteAttemptRequest,
  ): Promise<{ expiresAt: string; csrfToken: string }> {
    return this.protected('recover', async () => {
      this.browserOrigin(request);
      this.crypto.assertConfigured();
      const ips = inviteIpBuckets(request.ip);
      await this.repo.limit([
        { key: this.crypto.digest('bucket', 'global'), limit: 1000 },
        { key: this.crypto.digest('bucket', 'ip', ips.ip), limit: 10 },
        { key: this.crypto.digest('bucket', 'prefix', ips.prefix), limit: 30 },
      ]);
      const proof = this.transportProof('BROWSER_COOKIE', request);
      if (proof === undefined) throw inviteContextRequired();
      const { context, now } = await this.repo.findProof(this.crypto.proofHash(proof));
      const valid = this.valid(context, now, 'BROWSER_COOKIE');
      this.metrics.increment('invite_context_recovery_total', { result: 'recovered' });
      return { expiresAt: valid.expiresAt.toISOString(), csrfToken: this.crypto.csrf(valid.id) };
    });
  }

  /** I08 calls this after syntax/actor validation and before ticket/budget/lookup.
   * No global AuthGuard change: legacy/TOKEN128 callers need no new field. */
  async validateForCredential(
    credentialType: 'CODE6' | 'TOKEN128' | undefined,
    request: InviteAttemptRequest,
  ): Promise<InviteContext | undefined> {
    if (credentialType !== 'CODE6') return undefined;
    return this.protected('validate', async () => {
      this.crypto.assertConfigured();
      if (request.cookieProof !== undefined && request.headerProof !== undefined)
        throw inviteContextRequired();
      const transport = request.cookieProof !== undefined ? 'BROWSER_COOKIE' : 'MOBILE_HEADER';
      const token = this.transportProof(transport, request);
      if (token === undefined) throw inviteContextRequired();
      const hash = this.crypto.proofHash(token);
      const { context, now } = await this.repo.findProof(hash);
      const valid = this.valid(context, now, transport);
      if (transport === 'BROWSER_COOKIE') {
        this.browserOrigin(request);
        this.browserCsrf(valid, request);
      } else if (request.origin !== undefined) throw csrfFailed();
      return valid;
    });
  }

  private valid(
    context: InviteContext | undefined,
    now: Date,
    transport: InviteTransport,
  ): InviteContext {
    if (
      context &&
      (!Number.isFinite(context.createdAt.getTime()) ||
        !Number.isFinite(context.expiresAt.getTime()) ||
        !Number.isFinite(now.getTime()))
    )
      throw inviteLookupUnavailable();
    if (
      !context ||
      context.purpose !== 'invite_attempts' ||
      context.transport !== transport ||
      context.revokedAt ||
      context.expiresAt.getTime() <= now.getTime()
    )
      throw inviteContextRequired();
    return context;
  }

  private transportProof(
    transport: InviteTransport,
    request: InviteAttemptRequest,
  ): string | undefined {
    if (transport === 'BROWSER_COOKIE') {
      if (request.headerProof !== undefined) throw inviteContextRequired();
      return request.cookieProof;
    }
    if (request.cookieProof !== undefined) throw inviteContextRequired();
    return request.headerProof;
  }

  private browserOrigin(request: InviteAttemptRequest): void {
    const origins = this.config.CORS_ORIGINS ?? [];
    if (
      !request.origin ||
      !origins.includes(request.origin) ||
      !['same-origin', 'same-site'].includes(request.fetchSite ?? '')
    )
      throw csrfFailed();
    try {
      if (new URL(request.origin).protocol !== 'https:') throw csrfFailed();
    } catch {
      throw csrfFailed();
    }
  }

  private browserCsrf(context: InviteContext, request: InviteAttemptRequest): void {
    if (!this.crypto.matchesCsrf(context.id, request.csrf)) throw csrfFailed();
  }

  private output(context: InviteContext, token: string, now: Date): InviteBootstrapOutput {
    const expiresAt = context.expiresAt.toISOString();
    const maxAge = Math.max(0, Math.floor((context.expiresAt.getTime() - now.getTime()) / 1000));
    return context.transport === 'MOBILE_HEADER'
      ? { body: { expiresAt, contextToken: token }, maxAge }
      : { body: { expiresAt, csrfToken: this.crypto.csrf(context.id) }, cookie: token, maxAge };
  }

  private async protected<T>(
    operation: 'bootstrap' | 'validate' | 'recover',
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const safe = error instanceof AppError ? error : inviteLookupUnavailable();
      this.metrics.increment('invite_context_rejection_total', { operation, result: safe.code });
      // No DB/crypto error cause: it may carry SQL parameters or proof material.
      throw safe;
    }
  }
}
