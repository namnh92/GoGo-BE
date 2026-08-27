import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../domain/actor';
import { IdentityRepository } from '../infrastructure/identity.repository';
import { PasswordService } from './password.service';
import { SessionRevocationService } from './session-revocation.service';
import { TokenService } from './token.service';
import { ROOM_EVENT_BUS, type RoomEventBus } from '../../realtime/application/room-event-bus';

export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');

export type AuthOptions = {
  refreshTtlSeconds: number;
  guestTtlSeconds: number;
  /** Failed logins per identifier within lockout window before blocking. */
  lockoutThreshold: number;
  lockoutWindowSeconds: number;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
};

export type ClientMeta = { ip?: string; userAgent?: string };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * BE-BFF-002 — register/login/refresh/revoke + guest sessions + claim flow.
 * Security posture per ADR-0003: enumeration-safe login, lockout on abuse,
 * rotating hashed refresh tokens with family revoke on reuse.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly revocations: SessionRevocationService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
    @Inject(ROOM_EVENT_BUS) private readonly events: RoomEventBus,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    claimGuestToken?: string;
    meta?: ClientMeta;
  }): Promise<{ userId: string; tokens: TokenPair; claimedRoomId?: string }> {
    const existing = await this.repo.findUserByEmail(input.email);
    if (existing) {
      // Same code/message shape as validation errors; does not confirm which
      // field failed to an attacker probing for accounts.
      throw AppError.conflict('REGISTRATION_FAILED', 'Registration could not be completed');
    }
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.repo.createUser({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });

    let claimedRoomId: string | undefined;
    if (input.claimGuestToken) {
      const guest = await this.verifyGuestToken(input.claimGuestToken).catch(() => undefined);
      if (guest) {
        await this.repo.claimGuestSession(guest.id, user.id);
        claimedRoomId = guest.roomId;
        await this.repo.insertAudit({
          actorType: 'user',
          actorId: user.id,
          action: 'guest_session.claimed',
          resourceType: 'guest_session',
          resourceId: guest.id,
        });
      }
    }

    const tokens = await this.issueSession(user.id, input.meta);
    return { userId: user.id, tokens, ...(claimedRoomId ? { claimedRoomId } : {}) };
  }

  async login(input: {
    email: string;
    password: string;
    meta?: ClientMeta;
  }): Promise<{ userId: string; tokens: TokenPair }> {
    const identifierHash = sha256(input.email.trim().toLowerCase());
    const ipHash = sha256(input.meta?.ip ?? 'unknown');

    const failures = await this.repo.countRecentFailures(
      identifierHash,
      this.options.lockoutWindowSeconds,
    );
    if (failures >= this.options.lockoutThreshold) {
      // Lockout responses are indistinguishable from bad credentials except
      // for retryable=true, and never confirm the account exists.
      throw AppError.tooManyRequests('Too many attempts, try again later');
    }

    const user = await this.repo.findUserByEmail(input.email);
    const valid = await this.passwords.verifyOrBurn(user?.passwordHash, input.password);
    await this.repo.recordLoginAttempt({ identifierHash, ipHash, succeeded: valid });
    if (!valid || !user || user.status !== 'active') {
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    const tokens = await this.issueSession(user.id, input.meta);
    return { userId: user.id, tokens };
  }

  /**
   * Rotating refresh: each token is single-use. Presenting a superseded token
   * is treated as theft — the entire family is revoked (ADR-0003).
   */
  async refresh(refreshToken: string, meta?: ClientMeta): Promise<TokenPair> {
    const hash = this.tokens.hashOpaqueToken(refreshToken);
    const session = await this.repo.findAuthSessionByTokenHash(hash);
    if (!session) throw AppError.unauthorized('INVALID_REFRESH_TOKEN', 'Session is not valid');

    if (session.revokedAt) {
      throw AppError.unauthorized('SESSION_REVOKED', 'Session is not valid');
    }
    if (session.supersededAt) {
      await this.repo.revokeFamily(session.familyId, 'refresh_token_reuse');
      await this.revocations.revokeMany(await this.repo.listFamilySessionIds(session.familyId));
      throw AppError.unauthorized('SESSION_REVOKED', 'Session is not valid');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized('SESSION_EXPIRED', 'Session is not valid');
    }

    await this.repo.markSessionSuperseded(session.id);
    const newRefresh = this.tokens.generateOpaqueToken();
    const next = await this.repo.createAuthSession({
      userId: session.userId,
      refreshTokenHash: this.tokens.hashOpaqueToken(newRefresh),
      familyId: session.familyId,
      rotatedFromId: session.id,
      expiresAt: new Date(Date.now() + this.options.refreshTtlSeconds * 1000),
      ...(meta?.ip ? { ipHash: sha256(meta.ip) } : {}),
      ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
    });
    return {
      accessToken: this.tokens.issueAccessToken({
        actorId: session.userId,
        actorType: 'user',
        sessionId: next.id,
      }),
      refreshToken: newRefresh,
      accessExpiresInSeconds: this.accessTtl(),
    };
  }

  async logout(sessionId: string, allDevices: boolean): Promise<void> {
    const session = await this.repo.findAuthSessionById(sessionId);
    if (!session) return; // already gone — logout is idempotent
    if (allDevices) {
      await this.repo.revokeFamily(session.familyId, 'logout_all');
      // Every access token minted from this family dies now, not at expiry.
      const family = await this.repo.listFamilySessionIds(session.familyId);
      await this.revocations.revokeMany(family);
    } else {
      await this.repo.revokeSession(session.id, 'logout');
      await this.revocations.revokeSession(session.id);
    }
  }

  // --- guest sessions (FR-AUTH-002/003) ------------------------------------

  async createGuestSession(input: {
    roomCode: string;
    displayName: string;
  }): Promise<{ actor: Actor; accessToken: string; guestToken: string; roomId: string }> {
    const room = await this.repo.findRoomByCode(input.roomCode);
    if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'Room not found');
    if (!['draft', 'collecting'].includes(room.status)) {
      throw AppError.gone('ROOM_NOT_JOINABLE', 'Room is no longer accepting members');
    }
    if (room.expiresAt && room.expiresAt.getTime() <= Date.now()) {
      throw AppError.gone('ROOM_EXPIRED', 'Room link has expired');
    }

    const guestToken = this.tokens.generateOpaqueToken();
    const session = await this.repo.createGuestSession({
      roomId: room.id,
      displayName: input.displayName,
      tokenHash: this.tokens.hashOpaqueToken(guestToken),
      expiresAt: new Date(Date.now() + this.options.guestTtlSeconds * 1000),
    });
    const { memberId } = await this.repo.addGuestMember({
      roomId: room.id,
      guestSessionId: session.id,
      displayName: input.displayName,
    });
    // Only a genuine join is announced: a guest whose membership row already
    // existed has reconnected, and telling the room they arrived again would
    // be a lie the UI would render as a new participant.
    if (memberId) {
      try {
        await this.events.publish({
          roomId: room.id,
          type: 'participant.joined',
          actorId: memberId,
          payload: { memberId, role: 'member', memberType: 'guest' },
        });
      } catch {
        /* transport-only; clients fall back to polling */
      }
    }

    const actor: Actor = {
      type: 'guest',
      id: session.id,
      sessionId: session.id,
      roomId: room.id,
      displayName: input.displayName,
    };
    return {
      actor,
      // Guest access token carries the room claim; policies reject any other
      // room even if the guest crafts requests by hand.
      accessToken: this.tokens.issueAccessToken({
        actorId: session.id,
        actorType: 'guest',
        sessionId: session.id,
        roomId: room.id,
      }),
      guestToken,
      roomId: room.id,
    };
  }

  /** Validates a long-lived opaque guest token (used for claim + re-entry). */
  async verifyGuestToken(guestToken: string): Promise<{ id: string; roomId: string }> {
    const hash = this.tokens.hashOpaqueToken(guestToken);
    const found = await this.repo.findGuestSessionByTokenHash(hash);
    if (!found) throw AppError.unauthorized('INVALID_GUEST_TOKEN', 'Guest session is not valid');
    if (found.revokedAt || found.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized('GUEST_SESSION_EXPIRED', 'Guest session is not valid');
    }
    return { id: found.id, roomId: found.roomId };
  }

  /** Guest access-token renewal from the opaque guest token. */
  async refreshGuestAccess(guestToken: string): Promise<{ accessToken: string; roomId: string }> {
    const guest = await this.verifyGuestToken(guestToken);
    return {
      accessToken: this.tokens.issueAccessToken({
        actorId: guest.id,
        actorType: 'guest',
        sessionId: guest.id,
        roomId: guest.roomId,
      }),
      roomId: guest.roomId,
    };
  }

  private async issueSession(userId: string, meta?: ClientMeta): Promise<TokenPair> {
    const refreshToken = this.tokens.generateOpaqueToken();
    const session = await this.repo.createAuthSession({
      userId,
      refreshTokenHash: this.tokens.hashOpaqueToken(refreshToken),
      familyId: randomUUID(),
      expiresAt: new Date(Date.now() + this.options.refreshTtlSeconds * 1000),
      ...(meta?.ip ? { ipHash: sha256(meta.ip) } : {}),
      ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
    });
    return {
      accessToken: this.tokens.issueAccessToken({
        actorId: userId,
        actorType: 'user',
        sessionId: session.id,
      }),
      refreshToken,
      accessExpiresInSeconds: this.accessTtl(),
    };
  }

  private accessTtl(): number {
    return this.tokens.accessTtlSeconds;
  }
}
