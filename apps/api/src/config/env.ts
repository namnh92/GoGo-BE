import { z } from 'zod';

/**
 * FND-006: config validation — the process must fail fast on invalid config.
 * Secrets are required outside development/test so a misconfigured production
 * deployment never boots with empty signing keys.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /**
     * Which deployment this is, as opposed to how it was built.
     *
     * NODE_ENV is the build mode, and every deployed environment sets it to
     * `production` — DEV included, because DEV runs the production build. Rules
     * written against NODE_ENV therefore apply to DEV as if it were production,
     * which is how the CMS ended up unreachable there: login refused an admin
     * without MFA, and enrolling MFA needs a session that login would not
     * issue.
     *
     * Unset means a workstation.
     */
    APP_ENV: z.enum(['dev', 'staging', 'prod', 'production']).default('dev'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_HOST: z.string().default('0.0.0.0'),
    /**
     * Which proxies may set X-Forwarded-For. `false` = trust nobody (direct
     * exposure), a number = trust that many hops closest to the server, or a
     * comma-separated CIDR list. NEVER `true`: trusting every hop lets any
     * client spoof its IP and walk past every IP-keyed rate limit.
     *
     * Defaults to `false`, and production must set it explicitly. It used to
     * default to `1`, which trusts the direct peer — so anywhere the API was
     * reachable without a proxy in front, a client could send its own
     * X-Forwarded-For and get a fresh rate-limit bucket per request. Measured:
     * 15 login attempts with a rotating header drew no 429 at all, while the
     * same 15 from a fixed address were cut off after 10.
     *
     * A wrong value now costs availability (every client looks like the proxy)
     * rather than security, and an operator behind a proxy is made to say so.
     */
    TRUST_PROXY: z.string().optional(),
    DATABASE_URL: z.string().url().or(z.string().startsWith('postgres://')),
    /**
     * DB-002 — pool size **per process**. The ceiling is the server's
     * `max_connections` divided by every process that connects (api replicas,
     * worker, migrations, an operator's psql), not the application's
     * concurrency. Sizing it from concurrency is how a deploy that doubles
     * replicas exhausts the database exactly when it is busiest.
     */
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: z.string().startsWith('redis://').or(z.string().startsWith('rediss://')),
    AUTH_JWT_SECRET: z.string().default(''),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
    AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    AUTH_GUEST_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
    /**
     * SEC-003 — CMS sessions expire sooner than consumer ones (security rule).
     * 8 hours covers a shift; the consumer refresh lives 30 days.
     */
    AUTH_ADMIN_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(28_800),
    /**
     * #62 / ADR-0010 — the Cloudflare Access application whose assertions are
     * accepted as CMS identity. `CF_ACCESS_TEAM_DOMAIN` is the team hostname
     * (`<team>.cloudflareaccess.com`), which is also where the signing keys
     * are published; `CF_ACCESS_AUD` is the application's audience tag.
     *
     * Empty means single sign-on is off for this environment and
     * `POST /v1/cms/auth/access-exchange` answers 503 saying so. Password +
     * TOTP is unaffected either way.
     */
    CF_ACCESS_TEAM_DOMAIN: z.string().default(''),
    CF_ACCESS_AUD: z.string().default(''),
    /**
     * #255 — per-type SLA override for the privacy-request ledger, JSON:
     * `{"delete":{"ackHours":72,"fulfillHours":720},...}`. Empty uses the
     * PROVISIONAL engineering defaults in shared/privacy-ledger.ts — Legal
     * must confirm production values against current law before launch.
     */
    PRIVACY_SLA_JSON: z
      .string()
      .default('')
      .refine(
        (v) => {
          if (!v) return true;
          try {
            const parsed = JSON.parse(v) as Record<
              string,
              { ackHours: number; fulfillHours: number }
            >;
            return Object.entries(parsed).every(
              ([k, w]) =>
                ['export', 'delete', 'correction'].includes(k) &&
                Number.isFinite(w?.ackHours) &&
                Number.isFinite(w?.fulfillHours) &&
                w.ackHours > 0 &&
                w.fulfillHours >= w.ackHours,
            );
          } catch {
            return false;
          }
        },
        {
          message:
            'PRIVACY_SLA_JSON must be JSON of {export|delete|correction: {ackHours, fulfillHours}} with fulfillHours >= ackHours',
        },
      ),
    /**
     * #255 — how long a closed privacy request is kept before the retention
     * job hard-deletes it. Product default 12; Legal sign-off required before
     * production.
     */
    PRIVACY_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(12),
    /**
     * #154 — the SSE transport, per environment. Default on: a client that
     * cannot open the stream falls back to polling, so the failure mode of
     * having it on is worse latency, not a broken app.
     */
    REALTIME_SSE_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * SEC-004 (#62) — encrypts admin TOTP secrets at rest. Required in
     * production: without it a database dump hands over every second factor,
     * which is the one credential a leaked dump is not supposed to include.
     */
    CMS_MFA_ENCRYPTION_KEY: z.string().default(''),
    /**
     * SG-009 (#48) — the mandatory AI kill switch. Off by default: a real
     * provider needs a prompt/data privacy review and a DPA first, and until
     * then the deterministic keyword parser does the work.
     */
    FLAG_AI_FEEDBACK: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    COOKIE_SECRET: z.string().default(''),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    FLAG_AI_REFINEMENT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    FLAG_PLACE_IMPORT_AUTOPUBLISH: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /**
     * ADR-0007. Off means every leg is the straight-line estimate — the same
     * behaviour as before the Routes adapter existed, and the permanent
     * fallback for quota exhaustion and outages.
     */
    FLAG_ROUTES_API: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    GOOGLE_MAPS_API_KEY: z.string().default(''),
    /** Optional split key for the Sheets read scope; falls back to the Maps key. */
    GOOGLE_SHEETS_API_KEY: z.string().default(''),
    /** Optional split key for Routes; falls back to the Maps key. */
    GOOGLE_ROUTES_API_KEY: z.string().default(''),
    R2_ACCOUNT_ID: z.string().default(''),
    R2_ACCESS_KEY_ID: z.string().default(''),
    R2_SECRET_ACCESS_KEY: z.string().default(''),
    R2_BUCKET: z.string().default(''),
    /**
     * #151 — public base for place imagery. While it is empty the API omits
     * photos entirely rather than emitting a URL that will not load: a broken
     * image is worse than the neutral placeholder a client falls back to.
     */
    MEDIA_PUBLIC_BASE_URL: z.string().default(''),
    R2_BACKUP_BUCKET: z.string().default(''),
    SENTRY_DSN: z.string().default(''),
    /**
     * PI-SRE-001 — bearer token for `GET /metrics`. Empty means the endpoint
     * answers 404: series names and label values describe internal structure,
     * and an unconfigured deployment must not quietly publish it.
     */
    METRICS_TOKEN: z.string().default(''),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_JWT_SECRET'],
          message: 'AUTH_JWT_SECRET must be at least 32 chars in production',
        });
      }
      // DB-002: TLS everywhere (security rule). A connection string without
      // it is refused rather than quietly downgraded — a database link that
      // silently falls back to plaintext is the kind of thing nobody notices
      // until it is in a packet capture.
      if (!/[?&]sslmode=(require|verify-ca|verify-full)\b/.test(env.DATABASE_URL)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message:
            'DATABASE_URL must set sslmode=require (or verify-ca / verify-full) in production',
        });
      }
      if (env.TRUST_PROXY === undefined || env.TRUST_PROXY.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUST_PROXY'],
          message:
            'TRUST_PROXY must be set explicitly in production: "false" when the API is directly exposed, or the hop count / CIDR list of the proxies in front of it',
        });
      }
      if (env.CMS_MFA_ENCRYPTION_KEY.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CMS_MFA_ENCRYPTION_KEY'],
          message: 'CMS_MFA_ENCRYPTION_KEY must be at least 32 chars in production',
        });
      }
      if (env.COOKIE_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COOKIE_SECRET'],
          message: 'COOKIE_SECRET must be at least 32 chars in production',
        });
      }
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COOKIE_SECURE'],
          message: 'COOKIE_SECURE must be true in production',
        });
      }
    }

    // #62 / ADR-0010 — half-configured single sign-on is worse than none. A
    // team domain without an audience tag accepts an assertion minted for any
    // application in the Cloudflare account, and those are different doors
    // with different allow-lists.
    if (Boolean(env.CF_ACCESS_TEAM_DOMAIN) !== Boolean(env.CF_ACCESS_AUD)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CF_ACCESS_AUD'],
        message:
          'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together: a team domain without an audience tag would accept an assertion issued for any other application in the account',
      });
    }

    // Security rule: the CMS requires SSO in production. Keyed on APP_ENV, not
    // NODE_ENV — every deployed environment runs the production build, so
    // NODE_ENV would demand this of DEV too (the mistake fixed in #215/#216).
    if ((env.APP_ENV === 'prod' || env.APP_ENV === 'production') && !env.CF_ACCESS_TEAM_DOMAIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CF_ACCESS_TEAM_DOMAIN'],
        message:
          'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required in production: the CMS requires SSO there',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export { APP_CONFIG } from '@gogo/modules';
