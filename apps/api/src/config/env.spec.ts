import { generateKeyPairSync } from 'node:crypto';
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

  /**
   * GoGo-BE#548 — an R2 credential with no resolvable account id used to boot
   * fine and hand out presigned URLs for `.r2.cloudflarestorage.com`.
   */
  it('refuses an R2 credential with no account id and no endpoint', () => {
    expect(() =>
      loadEnv({
        ...base,
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_BUCKET: 'gogo-dev-assets',
      }),
    ).toThrow(/R2_ACCOUNT_ID/);
  });

  it('accepts an R2 credential whose account id comes from the endpoint', () => {
    const env = loadEnv({
      ...base,
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'gogo-dev-assets',
      R2_ENDPOINT: 'https://acc123.r2.cloudflarestorage.com',
    });
    expect(env.R2_ENDPOINT).toBe('https://acc123.r2.cloudflarestorage.com');
  });

  it('refuses an endpoint that is not R2, rather than signing for a wrong host', () => {
    expect(() =>
      loadEnv({
        ...base,
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_BUCKET: 'gogo-dev-assets',
        R2_ENDPOINT: 'https://storage.example.com',
      }),
    ).toThrow(/R2_ACCOUNT_ID/);
  });

  it('splits CORS origins', () => {
    const env = loadEnv({ ...base, CORS_ORIGINS: 'https://a.example, https://b.example' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('accepts push provider config and rejects an app id that is not a UUID (#193)', () => {
    const env = loadEnv({
      ...base,
      ONESIGNAL_APP_ID: '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
      ONESIGNAL_REST_API_KEY: 'k',
      PUSH_PROVIDER_MODE: 'onesignal',
    });
    expect(env.PUSH_PROVIDER_MODE).toBe('onesignal');
    expect(loadEnv(base).PUSH_PROVIDER_MODE).toBeUndefined();
    expect(() => loadEnv({ ...base, ONESIGNAL_APP_ID: 'gogo-dev' })).toThrow(/ONESIGNAL_APP_ID/);
    expect(() => loadEnv({ ...base, PUSH_PROVIDER_MODE: 'apns' })).toThrow(/PUSH_PROVIDER_MODE/);
  });

  it('validates the identity signing key at boot and caps its TTL (#199)', () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    expect(
      loadEnv({ ...base, ONESIGNAL_IDENTITY_VERIFICATION_KEY: pem })
        .ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS,
    ).toBe(3_600);
    expect(loadEnv(base).ONESIGNAL_IDENTITY_VERIFICATION_KEY).toBe('');
    expect(() =>
      loadEnv({ ...base, ONESIGNAL_IDENTITY_VERIFICATION_KEY: 'os_v2_app_key' }),
    ).toThrow(/ONESIGNAL_IDENTITY_VERIFICATION_KEY/);
    expect(() => loadEnv({ ...base, ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: '7200' })).toThrow(
      /ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS/,
    );
  });

  it('accepts a bare https share host and refuses anything with a path or credentials (#205)', () => {
    expect(
      loadEnv({ ...base, SHARE_LINK_BASE_URL: 'https://go-dev.gogo.id.vn' }).SHARE_LINK_BASE_URL,
    ).toBe('https://go-dev.gogo.id.vn');
    expect(loadEnv(base).SHARE_LINK_BASE_URL).toBe('');
    for (const bad of [
      'http://go-dev.gogo.id.vn',
      'https://go-dev.gogo.id.vn/l',
      'https://user:pw@go-dev.gogo.id.vn',
      'https://go-dev.gogo.id.vn?x=1',
      'go-dev.gogo.id.vn',
    ]) {
      expect(() => loadEnv({ ...base, SHARE_LINK_BASE_URL: bad })).toThrow(/SHARE_LINK_BASE_URL/);
    }
  });

  it('validates the Tenjin tracking template like the adapter does (#206)', () => {
    const ok = loadEnv({
      ...base,
      TENJIN_TRACKING_URL_TEMPLATE: 'https://track.tenjin.com/v0/click/AbCdEf12',
    });
    expect(ok.TENJIN_TRACKING_URL_TEMPLATE).toBe('https://track.tenjin.com/v0/click/AbCdEf12');
    expect(loadEnv(base).TENJIN_TRACKING_URL_TEMPLATE).toBe('');
    for (const bad of [
      'track.tenjin.com/v0/click/x',
      'http://track.tenjin.com/v0/click/x',
      'https://track.tenjin.com/v0/click/x?deeplink_url=https%3A%2F%2Fx',
    ]) {
      expect(() => loadEnv({ ...base, TENJIN_TRACKING_URL_TEMPLATE: bad })).toThrow(
        /TENJIN_TRACKING_URL_TEMPLATE/,
      );
    }
  });
});

describe('SHARE_LINK_EDGE_AUTH_TOKEN (SEC-004)', () => {
  it('is empty by default — no edge is trusted until one is configured', () => {
    expect(loadEnv({ ...base }).SHARE_LINK_EDGE_AUTH_TOKEN).toBe('');
  });

  it('accepts a token long enough to be one', () => {
    const token = 'a'.repeat(32);
    expect(loadEnv({ ...base, SHARE_LINK_EDGE_AUTH_TOKEN: token }).SHARE_LINK_EDGE_AUTH_TOKEN).toBe(
      token,
    );
  });

  it('refuses a short token at boot rather than comparing against it', () => {
    expect(() => loadEnv({ ...base, SHARE_LINK_EDGE_AUTH_TOKEN: 'short' })).toThrow(
      /SHARE_LINK_EDGE_AUTH_TOKEN/,
    );
  });

  describe('CMS password door (#679, ADR-0032)', () => {
    const access = { CF_ACCESS_TEAM_DOMAIN: 'gogo.cloudflareaccess.com', CF_ACCESS_AUD: 'aud-tag' };

    it('is open by default, so no existing environment changes', () => {
      expect(loadEnv({ ...base, NODE_ENV: 'development' }).CMS_PASSWORD_LOGIN_ENABLED).toBe(true);
    });

    it('refuses to close it when Access is not configured: the console would have no door', () => {
      expect(() =>
        loadEnv({ ...base, NODE_ENV: 'development', CMS_PASSWORD_LOGIN_ENABLED: 'false' }),
      ).toThrow(/CMS_PASSWORD_LOGIN_ENABLED=false requires CF_ACCESS_TEAM_DOMAIN/);
    });

    it('closes it when Access is configured', () => {
      const env = loadEnv({
        ...base,
        NODE_ENV: 'development',
        APP_ENV: 'dev',
        CMS_PASSWORD_LOGIN_ENABLED: 'false',
        ...access,
      });
      expect(env.CMS_PASSWORD_LOGIN_ENABLED).toBe(false);
    });

    it('accepts only true or false, so a typo cannot read as either', () => {
      expect(() =>
        loadEnv({ ...base, NODE_ENV: 'development', CMS_PASSWORD_LOGIN_ENABLED: 'no', ...access }),
      ).toThrow(/CMS_PASSWORD_LOGIN_ENABLED/);
    });
  });

  describe('CMS_SUPER_ADMIN_EMAIL (#687 D-2)', () => {
    it('is the one super admin address, compared lower-cased', () => {
      expect(
        loadEnv({ ...base, NODE_ENV: 'development', CMS_SUPER_ADMIN_EMAIL: ' Boss@Example.COM ' })
          .CMS_SUPER_ADMIN_EMAIL,
      ).toBe('boss@example.com');
    });

    it('may be absent on a workstation', () => {
      expect(loadEnv({ ...base, NODE_ENV: 'development' }).CMS_SUPER_ADMIN_EMAIL).toBe('');
    });

    it('is required in every deployed environment (NODE_ENV=production)', () => {
      expect(() =>
        loadEnv({
          ...base,
          NODE_ENV: 'production',
          AUTH_JWT_SECRET: 'x'.repeat(48),
          AUTH_REFRESH_SECRET: 'y'.repeat(48),
          COOKIE_SECRET: 'z'.repeat(48),
          COOKIE_SECURE: 'true',
        }),
      ).toThrow(/CMS_SUPER_ADMIN_EMAIL is required/);
    });

    it('#687: a deployed environment without Access leaves the super admin no door and is refused', () => {
      const deployed = {
        ...base,
        NODE_ENV: 'production',
        APP_ENV: 'dev',
        AUTH_JWT_SECRET: 'x'.repeat(48),
        AUTH_REFRESH_SECRET: 'y'.repeat(48),
        COOKIE_SECRET: 'z'.repeat(48),
        COOKIE_SECURE: 'true',
        CMS_SUPER_ADMIN_EMAIL: 'boss@example.com',
      };
      expect(() => loadEnv(deployed)).toThrow(
        /super admin signs in only through Cloudflare Access/,
      );
      // A workstation still boots without it.
      expect(() =>
        loadEnv({ ...base, NODE_ENV: 'development', CMS_SUPER_ADMIN_EMAIL: 'boss@example.com' }),
      ).not.toThrow();
    });

    for (const bad of ['boss', 'boss@', '@example.com', 'boss@example..com', 'a b@example.com']) {
      it(`refuses a malformed address: ${JSON.stringify(bad)}`, () => {
        expect(() =>
          loadEnv({ ...base, NODE_ENV: 'development', CMS_SUPER_ADMIN_EMAIL: bad }),
        ).toThrow(/CMS_SUPER_ADMIN_EMAIL/);
      });
    }
  });

  describe('super admin through Access only (#687, ADR-0034)', () => {
    const access = { CF_ACCESS_TEAM_DOMAIN: 'gogo.cloudflareaccess.com', CF_ACCESS_AUD: 'aud-tag' };

    // AC-7 / D-8 (O-8): staging and production — under either production alias
    // (F-19) — refuse a configuration in which the super admin keeps a password
    // door, and require Access itself in staging as well as production.
    for (const appEnv of ['prod', 'production', 'staging']) {
      it(`refuses CMS_SUPER_ADMIN_SSO_ONLY=false when APP_ENV=${appEnv}`, () => {
        expect(() =>
          loadEnv({ ...base, NODE_ENV: 'development', APP_ENV: appEnv, ...access }),
        ).toThrow(/CMS_SUPER_ADMIN_SSO_ONLY must be true when APP_ENV is staging or production/);
      });

      it(`accepts CMS_SUPER_ADMIN_SSO_ONLY=true with Access when APP_ENV=${appEnv}`, () => {
        const env = loadEnv({
          ...base,
          NODE_ENV: 'development',
          APP_ENV: appEnv,
          CMS_SUPER_ADMIN_SSO_ONLY: 'true',
          ...access,
        });
        expect(env.CMS_SUPER_ADMIN_SSO_ONLY).toBe(true);
      });
    }

    it('requires Access in staging too', () => {
      expect(() =>
        loadEnv({
          ...base,
          NODE_ENV: 'development',
          APP_ENV: 'staging',
          CMS_SUPER_ADMIN_SSO_ONLY: 'true',
        }),
      ).toThrow(/CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required in staging and production/);
    });

    it('leaves dev free to keep the super admin password door', () => {
      expect(
        loadEnv({ ...base, NODE_ENV: 'development', APP_ENV: 'dev' }).CMS_SUPER_ADMIN_SSO_ONLY,
      ).toBe(false);
    });

    it('is off by default, so no existing environment changes', () => {
      expect(loadEnv({ ...base, NODE_ENV: 'development' }).CMS_SUPER_ADMIN_SSO_ONLY).toBe(false);
    });

    it('refuses to turn on without Access: the super admin would have no door', () => {
      expect(() =>
        loadEnv({ ...base, NODE_ENV: 'development', CMS_SUPER_ADMIN_SSO_ONLY: 'true' }),
      ).toThrow(/CMS_SUPER_ADMIN_SSO_ONLY=true requires CF_ACCESS_TEAM_DOMAIN/);
    });

    it('turns on with Access, leaving the general password door as it was', () => {
      const env = loadEnv({
        ...base,
        NODE_ENV: 'development',
        APP_ENV: 'dev',
        CMS_SUPER_ADMIN_SSO_ONLY: 'true',
        ...access,
      });
      expect(env.CMS_SUPER_ADMIN_SSO_ONLY).toBe(true);
      expect(env.CMS_PASSWORD_LOGIN_ENABLED).toBe(true);
    });

    it('accepts both switches together: redundant, not contradictory', () => {
      const env = loadEnv({
        ...base,
        NODE_ENV: 'development',
        APP_ENV: 'dev',
        CMS_PASSWORD_LOGIN_ENABLED: 'false',
        CMS_SUPER_ADMIN_SSO_ONLY: 'true',
        ...access,
      });
      expect(env.CMS_PASSWORD_LOGIN_ENABLED).toBe(false);
      expect(env.CMS_SUPER_ADMIN_SSO_ONLY).toBe(true);
    });

    it('accepts only true or false, so a typo cannot read as either', () => {
      expect(() =>
        loadEnv({ ...base, NODE_ENV: 'development', CMS_SUPER_ADMIN_SSO_ONLY: 'yes', ...access }),
      ).toThrow(/CMS_SUPER_ADMIN_SSO_ONLY/);
    });
  });
});

/*
 * PR #677 F-08 — a rotation past V2 must reach the API exactly as it reaches the
 * worker: both pick every EXPORT_WRAPPING_KEY_V<n> generically.
 */
describe('export wrapping keys (GoGo-BE#256)', () => {
  const key = () => Buffer.alloc(32, Math.floor(Math.random() * 255)).toString('base64');

  it('keeps V3 and an ACTIVE that names it', async () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'development',
      EXPORT_WRAPPING_KEY_V1: key(),
      EXPORT_WRAPPING_KEY_V3: key(),
      EXPORT_WRAPPING_KEY_ACTIVE: '3',
    });
    const { parseExportKeyring } = await import('@gogo/modules');
    const ring = parseExportKeyring(
      (env as unknown as { EXPORT_WRAPPING_KEYS: Record<string, string> }).EXPORT_WRAPPING_KEYS,
    )!;
    expect(ring.activeVersion).toBe(3);
    expect([...ring.keys.keys()].sort()).toEqual([1, 3]);
  });

  it('refuses a malformed key at boot', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'development', EXPORT_WRAPPING_KEY_V1: 'short' }),
    ).toThrow(/EXPORT_WRAPPING_KEY/);
  });

  it('an empty .env.example slot is absent, not invalid', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'development',
        EXPORT_WRAPPING_KEY_V1: '',
        EXPORT_WRAPPING_KEY_ACTIVE: '',
      }),
    ).not.toThrow();
  });

  it('reads the assistant settings by the GoGo-Infra manifest names (ADR-0014)', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'development',
      OPENROUTER_ASSISTANT_API_KEY: 'k',
      ASSISTANT_USER_DAILY_MAX_MESSAGES: '30',
      ASSISTANT_MONTHLY_MAX_USD: '5',
    });
    expect(env.OPENROUTER_ASSISTANT_API_KEY).toBe('k');
    expect(env.ASSISTANT_USER_DAILY_MAX_MESSAGES).toBe(30);
    expect(env.ASSISTANT_MONTHLY_MAX_USD).toBe(5);
    expect(env.ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES).toBe(5);
  });
});
