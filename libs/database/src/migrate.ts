import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Applies ./migrations to DATABASE_URL. Used by local dev, CI and deploy.
 * Rollback strategy per ADR-0002: every migration PR documents its down path;
 * production rollback is roll-forward with a reverting migration.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: 'migrations' });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('migrations applied');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
