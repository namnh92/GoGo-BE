/**
 * Global config injection token. The api app binds its validated env object
 * to this token; modules declare the slice they need via these types.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type MediaConfig = { MEDIA_PUBLIC_BASE_URL: string };

/** #334 — the reader half of the Google provenance unification. */
export type ProvenanceConfig = { PROVENANCE_UNIFIED_READS: boolean };

/** The deployment a flag row is scoped to (#221). */
export type PlatformConfig = { APP_ENV: 'dev' | 'staging' | 'prod' | 'production' };

/**
 * #337 — the resolution attestation's key and lifetime (plan §2.8).
 *
 * An empty secret is a valid state: it means the deployment cannot mint or
 * verify the proof, so the submit path falls back to the Google fetch it did
 * before. See `apps/api/src/config/env.ts` for why that is the safe direction.
 */
export type ResolutionAttestationConfig = {
  PLACE_RESOLUTION_ATTESTATION_SECRET: string;
  PLACE_RESOLUTION_TTL_S: number;
};

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
/** #255 — the privacy-request ledger's knobs. See shared/privacy-ledger.ts. */
export type PrivacyLedgerConfig = {
  PRIVACY_SLA_JSON: string;
  PRIVACY_RETENTION_MONTHS: number;
};

export type CloudflareAccessConfig = {
  /** e.g. `gogo.cloudflareaccess.com`. Also the JWKS host. */
  CF_ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag — its id, not its hostname. */
  CF_ACCESS_AUD: string;
};
