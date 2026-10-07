import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { syncSuperAdmin } from './super-admin-sync';

/**
 * `pnpm cms:sync-super-admin` — GoGo-BE#687 D-3. The migrate container runs this
 * after migrations on every deploy (docker/Dockerfile, PROCESS=migrate). See
 * super-admin-sync.ts for what it does; this file only wires the environment.
 */
async function main(): Promise<void> {
  const email = (process.env.CMS_SUPER_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!email) {
    throw new Error(
      'cms:sync-super-admin: CMS_SUPER_ADMIN_EMAIL is not set (SSM cms/super-admin-email) — nothing was changed',
    );
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await syncSuperAdmin(drizzle(pool, { schema }), {
      email,
      ssoOnly: process.env.CMS_SUPER_ADMIN_SSO_ONLY === 'true',
      revision: process.env.GOGO_REVISION ?? null,
    });
    // Ids and counts only: the address is not logged.
    // eslint-disable-next-line no-console
    console.log(
      `cms:sync-super-admin: ${result.action} (admin ${result.adminId}, sessions revoked ${result.revokedSessions})`,
    );
    if (result.passwordErased) {
      // eslint-disable-next-line no-console
      console.log('cms:sync-super-admin: super admin password erased (SSO confirmed)');
    }
    if (result.erasePending) {
      // eslint-disable-next-line no-console
      console.log('cms:sync-super-admin: super admin password erase pending SSO confirmation');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
