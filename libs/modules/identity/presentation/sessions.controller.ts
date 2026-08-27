import { Body, Controller, Delete, Get, Inject, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { APP_CONFIG, type IdentityConfig } from '../../shared/config';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AuthService } from '../application/auth.service';
import { SessionRevocationService } from '../application/session-revocation.service';
import type { Actor } from '../domain/actor';
import { IdentityRepository } from '../infrastructure/identity.repository';
import { clearAuthCookies, setAuthCookies } from './cookies';
import { CurrentActor, Public, RateLimit } from './decorators';
import { guestSessionSchema, logoutSchema, type GuestSessionDto, type LogoutDto } from './dtos';

@Controller()
export class SessionsController {
  constructor(
    private readonly auth: AuthService,
    private readonly repo: IdentityRepository,
    private readonly revocations: SessionRevocationService,
    @Inject(APP_CONFIG) private readonly config: IdentityConfig,
  ) {}

  /** FR-AUTH-002 — guest joins with a display name only, no registration. */
  @Public()
  @RateLimit({ action: 'sessions.guest', limit: 10, windowSeconds: 60, keyBy: 'ip' })
  @Post('sessions/guest')
  async createGuestSession(
    @Body(new ZodValidationPipe(guestSessionSchema)) body: GuestSessionDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.createGuestSession(body);
    setAuthCookies(
      reply,
      { accessToken: result.accessToken },
      {
        secure: this.config.COOKIE_SECURE,
        accessTtlSeconds: this.config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
        refreshTtlSeconds: this.config.AUTH_GUEST_SESSION_TTL_SECONDS,
      },
    );
    return {
      guestSessionId: result.actor.id,
      roomId: result.roomId,
      accessToken: result.accessToken,
      // Long-lived opaque credential for re-entry + claim on registration.
      guestToken: result.guestToken,
    };
  }

  @Delete('sessions/current')
  async endSession(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(logoutSchema)) body: LogoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (actor.type === 'user') {
      await this.auth.logout(actor.sessionId, body.allDevices);
    } else {
      await this.repo.revokeGuestSession(actor.sessionId);
      await this.revocations.revokeSession(actor.sessionId);
    }
    clearAuthCookies(reply, this.config.COOKIE_SECURE);
    return { revoked: true };
  }

  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    if (actor.type === 'guest') {
      const guest = await this.repo.findGuestSessionById(actor.id);
      return {
        actorType: 'guest',
        id: actor.id,
        roomId: actor.roomId,
        displayName: guest?.displayName,
        expiresAt: guest?.expiresAt?.toISOString(),
      };
    }
    const user = await this.repo.findUserById(actor.id);
    return {
      actorType: 'user',
      id: actor.id,
      displayName: user?.displayName,
      email: user?.email,
      locale: user?.locale,
    };
  }
}
