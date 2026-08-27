import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSigner, createVerifier } from 'fast-jwt';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  type AccessTokenClaims,
  type ActorType,
} from '../domain/actor';

export type TokenServiceOptions = {
  secret: string;
  accessTtlSeconds: number;
};

export type IssueInput = {
  actorId: string;
  actorType: ActorType;
  sessionId: string;
  roomId?: string;
};

/**
 * Access tokens: HS256 JWT, ≤15 min, no PII in claims (ADR-0003).
 * Refresh/guest credentials: 256-bit opaque values; only SHA-256 digests are
 * ever persisted or compared.
 */
@Injectable()
export class TokenService {
  private readonly sign: (payload: Record<string, unknown>) => string;
  private readonly verifyFn: (token: string) => AccessTokenClaims;

  constructor(private readonly options: TokenServiceOptions) {
    const key = options.secret;
    this.sign = createSigner({
      key,
      algorithm: 'HS256',
      expiresIn: options.accessTtlSeconds * 1000,
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
    });
    this.verifyFn = createVerifier({
      key,
      algorithms: ['HS256'],
      allowedIss: ACCESS_TOKEN_ISSUER,
      allowedAud: ACCESS_TOKEN_AUDIENCE,
      cache: false,
    }) as unknown as (token: string) => AccessTokenClaims;
  }

  get accessTtlSeconds(): number {
    return this.options.accessTtlSeconds;
  }

  issueAccessToken(input: IssueInput): string {
    return this.sign({
      sub: input.actorId,
      act: input.actorType,
      sid: input.sessionId,
      ...(input.roomId ? { room: input.roomId } : {}),
      jti: randomUUID(),
    });
  }

  /** Throws on any invalid/expired token. */
  verifyAccessToken(token: string): AccessTokenClaims {
    return this.verifyFn(token);
  }

  /** 256-bit URL-safe opaque credential (refresh tokens, guest tokens, invites). */
  generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
