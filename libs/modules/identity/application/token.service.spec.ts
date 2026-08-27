import { describe, expect, it } from 'vitest';
import { TokenService } from './token.service';

const service = new TokenService({ secret: 's'.repeat(48), accessTtlSeconds: 900 });

describe('TokenService (ADR-0003)', () => {
  it('signs and verifies access tokens with actor claims, no PII', () => {
    const token = service.issueAccessToken({
      actorId: 'user-1',
      actorType: 'user',
      sessionId: 'sess-1',
    });
    const claims = service.verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.act).toBe('user');
    expect(claims.sid).toBe('sess-1');
    expect(claims.room).toBeUndefined();
    expect(claims.jti).toBeTruthy();
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('guest tokens carry the room scope claim', () => {
    const token = service.issueAccessToken({
      actorId: 'guest-1',
      actorType: 'guest',
      sessionId: 'guest-1',
      roomId: 'room-9',
    });
    expect(service.verifyAccessToken(token).room).toBe('room-9');
  });

  it('rejects tampered tokens', () => {
    const token = service.issueAccessToken({
      actorId: 'user-1',
      actorType: 'user',
      sessionId: 's',
    });
    const [h, p, sig] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'user-2' }),
    ).toString('base64url');
    expect(() => service.verifyAccessToken(`${h}.${tamperedPayload}.${sig}`)).toThrow();
  });

  it('rejects tokens signed with a different secret', () => {
    const other = new TokenService({ secret: 'x'.repeat(48), accessTtlSeconds: 900 });
    const token = other.issueAccessToken({ actorId: 'u', actorType: 'user', sessionId: 's' });
    expect(() => service.verifyAccessToken(token)).toThrow();
  });

  it('opaque tokens are 256-bit and hash deterministically', () => {
    const t1 = service.generateOpaqueToken();
    const t2 = service.generateOpaqueToken();
    expect(t1).not.toBe(t2);
    expect(Buffer.from(t1, 'base64url')).toHaveLength(32);
    expect(service.hashOpaqueToken(t1)).toBe(service.hashOpaqueToken(t1));
    expect(service.hashOpaqueToken(t1)).toMatch(/^[0-9a-f]{64}$/);
  });
});
