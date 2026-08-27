import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://gogo:gogo@localhost:5432/gogo',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv (FND-006 fail-fast config)', () => {
  it('parses a minimal valid development env', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(env.API_PORT).toBe(3000);
    expect(env.AUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => loadEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('rejects production boot without strong secrets', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/AUTH_JWT_SECRET/);
  });

  it('rejects production boot with insecure cookies', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        AUTH_JWT_SECRET: 'x'.repeat(48),
        COOKIE_SECRET: 'y'.repeat(48),
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('caps access token TTL at one hour (short-lived tokens rule)', () => {
    expect(() => loadEnv({ ...base, AUTH_ACCESS_TOKEN_TTL_SECONDS: '86400' })).toThrow(
      /AUTH_ACCESS_TOKEN_TTL_SECONDS/,
    );
  });

  it('splits CORS origins', () => {
    const env = loadEnv({ ...base, CORS_ORIGINS: 'https://a.example, https://b.example' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });
});
