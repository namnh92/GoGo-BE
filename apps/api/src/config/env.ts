import { z } from 'zod';

/**
 * FND-006: config validation — the process must fail fast on invalid config.
 * Secrets are required outside development/test so a misconfigured production
 * deployment never boots with empty signing keys.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_HOST: z.string().default('0.0.0.0'),
    /**
     * Which proxies may set X-Forwarded-For. `false` = trust nobody (direct
     * exposure), a number = trust that many hops closest to the server, or a
     * comma-separated CIDR list. NEVER `true`: trusting every hop lets any
     * client spoof its IP and walk past every IP-keyed rate limit.
     */
    TRUST_PROXY: z.string().default('1'),
    DATABASE_URL: z.string().url().or(z.string().startsWith('postgres://')),
    REDIS_URL: z.string().startsWith('redis://').or(z.string().startsWith('rediss://')),
    AUTH_JWT_SECRET: z.string().default(''),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
    AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    AUTH_GUEST_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
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
    GOOGLE_MAPS_API_KEY: z.string().default(''),
    R2_ACCOUNT_ID: z.string().default(''),
    R2_ACCESS_KEY_ID: z.string().default(''),
    R2_SECRET_ACCESS_KEY: z.string().default(''),
    R2_BUCKET: z.string().default(''),
    R2_BACKUP_BUCKET: z.string().default(''),
    SENTRY_DSN: z.string().default(''),
    // Push providers — waiting slots; fakes are bound while empty.
    FCM_SERVICE_ACCOUNT_B64: z.string().default(''),
    APNS_KEY_ID: z.string().default(''),
    APNS_TEAM_ID: z.string().default(''),
    APNS_BUNDLE_ID: z.string().default(''),
    APNS_PRIVATE_KEY_B64: z.string().default(''),
    APNS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
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
