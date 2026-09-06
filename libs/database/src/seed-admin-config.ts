/**
 * Bootstrap credentials for the first CMS super admin.
 *
 * The values come from the environment, which GoGo-Infra fills from
 * `/gogo/<env>/backend/cms/seed-admin-{email,password}` (SecureString). There
 * is deliberately no fallback: the previous one lived in this file, applied to
 * every environment at once, and is in this repository's history forever.
 * A missing credential now means "do not create an account", never "use the
 * one everybody knows".
 *
 * This parses and gates only. Creating the account is `seed-admin.ts`, and the
 * demo seed cannot do it at all — that separation is what keeps these two
 * variables out of the API and worker process environment (GoGo-Infra INF-069).
 */

export type SeedAdminConfig = { email: string; password: string };

/** Deployed environments name themselves in APP_ENV; an unset one is a workstation. */
export function isProductionAppEnv(appEnv: string | undefined): boolean {
  return appEnv === 'prod' || appEnv === 'production';
}

/**
 * Returns null when nothing is configured — the caller creates no account.
 * Throws when the configuration is half-written or when production is asked
 * for without saying so. Neither message carries a value: this runs in CI logs
 * and on a deploy runner.
 */
export function seedAdminConfig(env: NodeJS.ProcessEnv): SeedAdminConfig | null {
  const email = env.SEED_ADMIN_EMAIL?.trim();
  const password = env.SEED_ADMIN_PASSWORD;

  if (!email && !password) return null;
  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must both be configured');
  }

  // Production bootstrap is a real act with a real blast radius, so it is
  // opt-in per invocation rather than a property of whichever env file got
  // loaded. Same shape as GoGo-Infra's SEED_CONFIRM on the demo seed: the
  // confirmation names the environment, so a copied command line from another
  // environment does not satisfy it.
  const appEnv = env.APP_ENV ?? 'dev';
  if (isProductionAppEnv(appEnv) && env.SEED_ADMIN_CONFIRM !== appEnv) {
    throw new Error(
      `refusing to bootstrap a ${appEnv} CMS admin without SEED_ADMIN_CONFIRM=${appEnv}`,
    );
  }

  return { email, password };
}
