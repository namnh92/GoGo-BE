/**
 * Global config injection token. The api app binds its validated env object
 * to this token; modules declare the slice they need via these types.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type MediaConfig = { MEDIA_PUBLIC_BASE_URL: string };

export type IdentityConfig = {
  NODE_ENV: 'development' | 'test' | 'production';
  AUTH_JWT_SECRET: string;
  AUTH_ACCESS_TOKEN_TTL_SECONDS: number;
  AUTH_REFRESH_TOKEN_TTL_SECONDS: number;
  AUTH_GUEST_SESSION_TTL_SECONDS: number;
  AUTH_ADMIN_REFRESH_TTL_SECONDS: number;
  /** Encrypts admin TOTP secrets at rest (#62). */
  CMS_MFA_ENCRYPTION_KEY: string;
  COOKIE_SECURE: boolean;
};
