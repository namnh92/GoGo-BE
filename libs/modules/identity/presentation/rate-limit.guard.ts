import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../domain/actor';
import { RATE_LIMIT_KEY, type RateLimitSpec } from './decorators';
import { RATE_LIMIT_STORE, type RateLimitStore } from './rate-limit.service';

/**
 * BE-IMP-005 — per-actor baseline, applied on top of the per-action specs.
 *
 * Keying the baseline by IP punished the wrong thing: a whole CMS team behind
 * one office IP shared a single bucket, while an authenticated admin — whose
 * identity is already known — never needed to be guessed at through their IP.
 * Anonymous traffic still falls back to IP.
 *
 * These are flood ceilings, not abuse limits. The limits that actually matter
 * (login, invite lookup, provider-quota endpoints) are per-action `@RateLimit`
 * specs and are deliberately untouched by this: a higher baseline for admins
 * buys them faster reading, not a faster way to burn Google quota.
 */
const BASELINE_WINDOW_SECONDS = 60;
const BASELINE_PER_MINUTE: Record<string, number> = {
  admin: 900,
  user: 300,
  guest: 120,
  anonymous: 120,
};

/** Uptime monitors poll these; they carry no data and no cost. */
const BASELINE_EXEMPT = /^\/v1\/health\//;

/**
 * Enforces @RateLimit() specs. Runs after AuthGuard so actor-keyed limits
 * see the resolved actor; IP-keyed limits work on public routes too.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    await this.enforceBaseline(req);

    const spec = this.reflector.getAllAndOverride<RateLimitSpec | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!spec) return true;

    const parts: string[] = [spec.action];
    if (spec.keyBy.includes('ip')) parts.push(req.ip ?? 'noip');
    if (spec.keyBy.includes('actor'))
      parts.push(req.actor ? `${req.actor.type}:${req.actor.id}` : 'anon');

    const key = parts.join('|');
    const count = await this.store.hit(key, spec.windowSeconds);
    if (count > spec.limit) {
      throw AppError.tooManyRequests();
    }
    if (spec.burst) {
      const burst = await this.store.hit(`${key}|burst`, spec.burst.windowSeconds);
      if (burst > spec.burst.limit) throw AppError.tooManyRequests();
    }
    return true;
  }

  private async enforceBaseline(req: FastifyRequest & { actor?: Actor }): Promise<void> {
    if (BASELINE_EXEMPT.test(req.url)) return;

    // req.ip already honours TRUST_PROXY — never read X-Forwarded-For directly
    // (that was the spoofing hole fixed in #129).
    const key = req.actor
      ? `baseline|${req.actor.type}:${req.actor.id}`
      : `baseline|ip:${req.ip ?? 'noip'}`;
    const limit = BASELINE_PER_MINUTE[req.actor?.type ?? 'anonymous'] ?? 120;

    const count = await this.store.hit(key, BASELINE_WINDOW_SECONDS);
    if (count > limit) throw AppError.tooManyRequests();
  }
}
