import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../domain/actor';
import { RATE_LIMIT_KEY, type RateLimitSpec } from './decorators';
import { RATE_LIMIT_STORE, type RateLimitStore } from './rate-limit.service';

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
    const spec = this.reflector.getAllAndOverride<RateLimitSpec | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!spec) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const parts: string[] = [spec.action];
    if (spec.keyBy.includes('ip')) parts.push(req.ip ?? 'noip');
    if (spec.keyBy.includes('actor'))
      parts.push(req.actor ? `${req.actor.type}:${req.actor.id}` : 'anon');

    const count = await this.store.hit(parts.join('|'), spec.windowSeconds);
    if (count > spec.limit) {
      throw AppError.tooManyRequests();
    }
    return true;
  }
}
