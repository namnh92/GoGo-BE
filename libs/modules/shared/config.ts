/**
 * Global config injection token. The api app binds its validated env object
 * to this token; modules declare the slice they need via these types.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type MediaConfig = { MEDIA_PUBLIC_BASE_URL: string };

/** The deployment a flag row is scoped to (#221). */
export type PlatformConfig = { APP_ENV: 'dev' | 'staging' | 'prod' | 'production' };

export type IdentityConfig = {
  NODE_ENV: 'development' | 'test' | 'production';
  /** The deployment, not the build mode. See apps/api/src/config/env.ts. */
  APP_ENV: 'dev' | 'staging' | 'prod' | 'production';
  AUTH_JWT_SECRET: string;
  AUTH_ACCESS_TOKEN_TTL_SECONDS: number;
  AUTH_REFRESH_TOKEN_TTL_SECONDS: number;
  AUTH_GUEST_SESSION_TTL_SECONDS: number;
  AUTH_ADMIN_REFRESH_TTL_SECONDS: number;
  /** Encrypts admin TOTP secrets at rest (#62). */
  CMS_MFA_ENCRYPTION_KEY: string;
  COOKIE_SECURE: boolean;
};

/**
 * #62 — the Cloudflare Access application whose assertions this deployment
 * accepts as CMS identity. See ADR-0010.
 *
 * Both values or neither: a team domain on its own would accept an assertion
 * minted for any application in the account, which is a different door with a
 * different allow-list.
 */
export type CloudflareAccessConfig = {
  /** e.g. `gogo.cloudflareaccess.com`. Also the JWKS host. */
  CF_ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag — its id, not its hostname. */
  CF_ACCESS_AUD: string;
};
