import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import IORedis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, type IdentityConfig } from '../../shared/config';
import { AuthService, AUTH_OPTIONS, type AuthOptions } from '../application/auth.service';
import {
  CachedRevocationStore,
  FallbackRevocationStore,
  InMemoryRevocationStore,
  RedisRevocationStore,
  REVOCATION_STORE,
  SessionRevocationService,
} from '../application/session-revocation.service';
import { PasswordService } from '../application/password.service';
import { TokenService } from '../application/token.service';
import { IdentityRepository } from '../infrastructure/identity.repository';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { RateLimitGuard } from './rate-limit.guard';
import {
  BASELINE_RATE_LIMIT_STORE,
  InMemoryRateLimitStore,
  RATE_LIMIT_STORE,
} from './rate-limit.service';
import { FallbackRateLimitStore, RedisRateLimitStore } from './redis-rate-limit.store';
import { SessionsController } from './sessions.controller';

/**
 * BE-BFF-002. AuthGuard + RateLimitGuard are registered globally here:
 * every route in the app is authenticated deny-by-default unless @Public().
 */
@Module({
  controllers: [AuthController, SessionsController],
  providers: [
    PasswordService,
    IdentityRepository,
    {
      provide: TokenService,
      useFactory: (config: IdentityConfig) =>
        new TokenService({
          // Outside production an empty secret gets an ephemeral one —
          // sessions do not survive restarts, which is fine for dev/test.
          // Production refuses to boot with a weak secret (env validation).
          secret: config.AUTH_JWT_SECRET || randomBytes(48).toString('base64url'),
          accessTtlSeconds: config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: AUTH_OPTIONS,
      useFactory: (config: IdentityConfig): AuthOptions => ({
        refreshTtlSeconds: config.AUTH_REFRESH_TOKEN_TTL_SECONDS,
        guestTtlSeconds: config.AUTH_GUEST_SESSION_TTL_SECONDS,
        lockoutThreshold: 5,
        lockoutWindowSeconds: 15 * 60,
      }),
      inject: [APP_CONFIG],
    },
    {
      provide: 'ACCESS_TTL_SECONDS',
      useFactory: (config: IdentityConfig) => config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      inject: [APP_CONFIG],
    },
    {
      // Denylist of revoked session ids, kept for one access-token lifetime.
      provide: REVOCATION_STORE,
      useFactory: (config: IdentityConfig & { REDIS_URL?: string }) => {
        if (!config.REDIS_URL || config.NODE_ENV === 'test') return new InMemoryRevocationStore();
        const redis = new IORedis(config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: true,
        });
        redis.on('error', () => undefined);
        // Fallback keeps this instance correct through a Redis blip; the cache
        // in front of it keeps an ordinary request off Redis altogether.
        return new CachedRevocationStore(
          new FallbackRevocationStore(new RedisRevocationStore(redis)),
        );
      },
      inject: [APP_CONFIG],
    },
    {
      // Per process by design — see BASELINE_RATE_LIMIT_STORE.
      provide: BASELINE_RATE_LIMIT_STORE,
      useClass: InMemoryRateLimitStore,
    },
    SessionRevocationService,
    AuthService,
    {
      // Redis-backed limits when configured (multi-instance correct); the
      // wrapper fails open to the per-process store on Redis outage.
      provide: RATE_LIMIT_STORE,
      useFactory: (config: IdentityConfig & { REDIS_URL?: string }) => {
        if (!config.REDIS_URL || config.NODE_ENV === 'test') {
          return new InMemoryRateLimitStore();
        }
        const redis = new IORedis(config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        redis.on('error', () => {
          /* handled by fallback wrapper per hit */
        });
        return new FallbackRateLimitStore(new RedisRateLimitStore(redis));
      },
      inject: [APP_CONFIG],
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [
    AuthService,
    TokenService,
    PasswordService,
    IdentityRepository,
    SessionRevocationService,
    RATE_LIMIT_STORE,
  ],
})
export class IdentityModule {}
