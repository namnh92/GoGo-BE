import { sql } from 'drizzle-orm';
import {
  type CreditExec,
  lockSyncCreditRules,
} from '../../../../libs/modules/shared/credit-catalogue';
import {
  lockCreditCutover,
  lockCreditRecipients,
} from '../../../../libs/modules/shared/credit-event-protocol';
import { discoverLegacyCredits } from '../../../../libs/modules/shared/credit-grants';
import { grantSubmissionCredits } from '../../../../libs/modules/shared/assistant-credits';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { schema, type Db } from '@gogo/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export const creditOps = (file: string) => path.resolve(__dirname, '../../../../scripts/ops', file);
export async function creditIndexes(pool: Pool) {
  const script = await readFile(creditOps('index-credit-events.sql'), 'utf8');
  for (const statement of script
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await pool.query(statement);
}
/** A populated S1 -> S2 forward migration, with indexes built outside its transaction. */
export async function creditDatabase(
  beforeS2?: (pool: Pool) => Promise<void>,
  beforeD1?: (pool: Pool) => Promise<void>,
) {
  const container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 12 });
  const db = drizzle(pool, { schema });
  const migrations = path.resolve(__dirname, '../../../../migrations');
  const folder = await mkdtemp(path.join(os.tmpdir(), 'credit-s2-'));
  try {
    const journal = JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 98);
    await mkdir(path.join(folder, 'meta'));
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await cp(path.join(migrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: folder });
    await beforeS2?.(pool);
    if (beforeD1) {
      const d1Journal = JSON.parse(
        await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'),
      );
      d1Journal.entries = d1Journal.entries.filter((e: { idx: number }) => e.idx < 99);
      await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(d1Journal));
      for (const entry of d1Journal.entries)
        await cp(path.join(migrations, entry.tag + '.sql'), path.join(folder, entry.tag + '.sql'));
      await migrate(db, { migrationsFolder: folder });
      await creditIndexes(pool);
      await beforeD1(pool);
    }
    await migrate(db, { migrationsFolder: migrations });
    await creditIndexes(pool);
    await assistantSpendIndexes(pool);
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return {
    db,
    pool,
    container,
    close: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
export async function creditUser(pool: Pool) {
  return String(
    (await pool.query("insert into users(display_name) values ('Credit subject') returning id"))
      .rows[0].id,
  );
}
export async function creditOutbox(
  pool: Pool,
  type: string,
  payload: Record<string, unknown>,
  version = 2,
) {
  return String(
    (
      await pool.query(
        `insert into outbox_events(event_type,resource_type,resource_id,payload,payload_schema_version)
    values($1,'credit-test',gen_random_uuid()::text,$2::jsonb,$3) returning id`,
        [type, JSON.stringify(payload), version],
      )
    ).rows[0].id,
  );
}

/** Existing regression suites need the explicit S2 index phase after migrations.
 * Prefix/snapshot tests before 0098 deliberately have no catalogue yet. */
export async function migrateWithCreditIndexes(db: Db, config: Parameters<typeof migrate>[1]) {
  await migrate(db, config);
  const result = await db.execute(sql`select to_regclass('credit_events') as name`);
  if (!(result.rows[0] as { name: string | null }).name) return;
  const script = await readFile(creditOps('index-credit-events.sql'), 'utf8');
  for (const statement of script
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await db.execute(sql.raw(statement));
  const spend = await db.execute(sql`select to_regclass('assistant_credit_spend_control') as name`);
  if (!(spend.rows[0] as { name: string | null }).name) return;
  const spendScript = await readFile(creditOps('index-assistant-credit-spend.sql'), 'utf8');
  for (const s of spendScript
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await db.execute(sql.raw(s));
}

/** Test grants acquire the same tiers as production's decision entry. */
export async function grantLockedSubmissionCredits(
  tx: CreditExec,
  userId: string,
  submissionId: string,
  venue: string,
  evidence = 0,
  base = true,
) {
  await lockCreditCutover(tx);
  await lockSyncCreditRules(tx);
  const legacy = await discoverLegacyCredits(tx, submissionId, venue);
  const accounts = [userId, ...legacy.flatMap((row) => (row.user_id ? [row.user_id] : []))];
  await lockCreditRecipients(tx, accounts);
  await grantSubmissionCredits(tx, userId, submissionId, venue, evidence, base, new Set(accounts));
}

/** D1 builds the existing-ledger index outside the migration transaction. */
export async function assistantSpendIndexes(pool: Pool) {
  const script = await readFile(creditOps('index-assistant-credit-spend.sql'), 'utf8');
  for (const s of script
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await pool.query(s);
}
