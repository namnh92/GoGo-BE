import {
  createParamDecorator,
  SetMetadata,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Actor } from '../domain/actor';

export const IS_PUBLIC_KEY = 'gogo:is_public';
/** Marks a route as reachable without authentication. Deny-by-default otherwise. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<{ actor?: Actor }>();
  if (!req.actor) throw new Error('CurrentActor used on a route without auth guard');
  return req.actor;
});

export type RateLimitSpec = {
  action: string;
  limit: number;
  windowSeconds: number;
  keyBy: 'ip' | 'actor' | 'ip+actor';
  /**
   * Optional second, shorter window on the same key (SEC-001). An hourly cap
   * alone still lets a compromised account spend the whole budget in seconds,
   * which is exactly the shape of a scripted abuse run and nothing like a
   * human working through an incident.
   */
  burst?: { limit: number; windowSeconds: number };
  /**
   * SEC-004 (#445): key on the address the share-link Worker forwarded, when
   * the request proved it came from the Worker, and on `ip` otherwise.
   *
   * Opt-in per action rather than global. Every other `keyBy: 'ip'` spec keeps
   * meaning "the address that connected to us", and so does the per-actor
   * baseline and the origin-wide flood net — a forwarded value earns its way
   * into exactly the one limit that is useless without it.
   */
  edgeClientIp?: boolean;
};

export const RATE_LIMIT_KEY = 'gogo:rate_limit';
/** Per-action rate limit (security rule: login/OTP/join/invite/suggestion/report). */
export const RateLimit = (spec: RateLimitSpec): CustomDecorator =>
  SetMetadata(RATE_LIMIT_KEY, spec);
