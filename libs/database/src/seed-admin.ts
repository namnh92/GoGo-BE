import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { seedAdminConfig } from './seed-admin-config';

/**
 * DB-012 — create the first CMS super admin, and nothing else.
 *
 * Deliberately not part of `seed.ts`. The demo seed inserts a place corpus; this
 * inserts one account. Bundling them meant every environment that wanted demo
 * data had to carry a super admin password in the same env file the API and the
 * worker load, so the credential sat in the process environment of the two
 * internet-facing processes that have no use for it. Split, the credential is
 * needed by exactly one command that a person runs on purpose
 * (GoGo-Infra INF-069).
 *
 * Idempotent, and idempotent in the strong sense: an existing account is left
 * exactly as it is, hash included. Changing the value in SSM is not a password
 * rotation — a seed that quietly rewrote the hash would lock out whoever is
 * already using the account, and would do it during a routine deploy.
 *
 * SSM holds *bootstrap* credentials, and the database is the authentication
 * source (ADR-0018). Those two sentences are the same sentence: the account's
 * password exists as an Argon2id hash that nothing can read back, the parameter
 * is what the first login is typed from, and after that first login the two are
 * unrelated. Rotation goes through CMS account management, which authenticates
 * the person doing it, audits the change and revokes the sessions it
 * invalidates — none of which editing a parameter does.
 *
 * One account, once. An environment has exactly one super admin; this command
 * creates it if it is absent and refuses to add a second.
 */
async function main(): Promise<void> {
  // Parsed before the pool opens. A half-written configuration should fail as
  // a configuration error, not as a connection that got opened and abandoned.
  const config = seedAdminConfig(process.env);
  if (!config) {
    // eslint-disable-next-line no-console
    console.log(
      'seed-admin: no bootstrap credentials configured — no account created.\n' +
        '  Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD from SSM. See GoGo-Infra docs/cms-bootstrap-ssm.md.',
    );
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  try {
    // Checked before anything is hashed or written. An environment has exactly
    // one super admin (ADR-0018), so a bootstrap run against an environment that
    // already has one under a *different* address is a mistake with two possible
    // shapes — the wrong environment, or the wrong parameter value — and both
    // are better as a refusal than as a second privileged account.
    //
    // The database refuses it too. Reaching it as a unique-violation stack trace
    // would leave the operator guessing which of the two mistakes they made.
    const [incumbent] = await db
      .select({ email: schema.adminUsers.email, status: schema.adminUsers.status })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.role, 'super_admin'))
      .limit(1);

    if (incumbent && incumbent.email !== config.email) {
      throw new Error(
        'this environment already has a super admin under a different address; ' +
          'an environment has exactly one, and changing who holds the role is CMS account management',
      );
    }

    const { default: argon2 } = await import('argon2');
    const passwordHash = await argon2.hash(config.password, { type: argon2.argon2id });

    const created = await db
      .insert(schema.adminUsers)
      .values({
        email: config.email,
        passwordHash,
        displayName: 'Bootstrap Super Admin',
        role: 'super_admin',
      })
      .onConflictDoNothing({ target: schema.adminUsers.email })
      .returning({ id: schema.adminUsers.id });

    if (created.length > 0) {
      // eslint-disable-next-line no-console
      console.log('seed-admin: bootstrap super admin created.');
      return;
    }

    // Not an error, and worth saying out loud: the operator asked for an
    // account and is getting the one that already exists. Whether its password
    // still matches the value in SSM is a question this command cannot answer
    // and must not answer by overwriting the hash.
    //
    // Reached for a row that already holds the role, and for one that holds a
    // lesser role under the same address. The second is left alone too:
    // promoting an existing account is a role change, and role changes belong to
    // the audited path, not to a command that runs from a deploy shell.
    const existing = await db
      .select({ role: schema.adminUsers.role, status: schema.adminUsers.status })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, config.email));

    // eslint-disable-next-line no-console
    console.log(
      `seed-admin: account already exists (role=${existing[0]?.role ?? 'unknown'}, ` +
        `status=${existing[0]?.status ?? 'unknown'}) — left unchanged.\n` +
        '  Its stored password was NOT replaced, and editing the SSM value does not\n' +
        '  change how it signs in. Rotating the password is a separate, authorised\n' +
        '  action through CMS account management, which audits it and revokes the\n' +
        '  sessions it invalidates.',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
