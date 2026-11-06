import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

let container: StartedPostgreSqlContainer;
let pool: Pool;
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_rejection_migration')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

it('upgrades populated 0083, enforces keys and rolls schema back without losing decisions (#787)', async () => {
  const folder = path.resolve(__dirname, '../../../migrations');
  const journal = JSON.parse(await readFile(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const entry = journal.entries.find((item) => item.tag === '0084_submission-rejection-reason')!;
  const prior = journal.entries.filter((item) => item.idx < entry.idx);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gogo-787-migration-'));
  const db = drizzle(pool);
  try {
    await mkdir(path.join(temp, 'meta'));
    await writeFile(
      path.join(temp, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: prior }),
    );
    for (const item of prior)
      await cp(path.join(folder, `${item.tag}.sql`), path.join(temp, `${item.tag}.sql`));
    await migrate(db, { migrationsFolder: temp });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const statuses = ['pending', 'approved', 'rejected'];
  for (let i = 0; i < ids.length; i++) {
    await pool.query(
      `insert into place_submissions(id, google_place_id, status, decision_reason)
      values ($1, $2, $3, $4)`,
      [ids[i], `legacy-${i}`, statuses[i], 'PRIVATE legacy note'],
    );
  }
  await migrate(db, { migrationsFolder: folder });
  const migrated = await pool.query(`select id, status, decision_reason, rejection_reason
    from place_submissions order by google_place_id`);
  expect(migrated.rows).toEqual(
    ids.map((id, i) => ({
      id,
      status: statuses[i],
      decision_reason: 'PRIVATE legacy note',
      rejection_reason: null,
    })),
  );
  expect(
    (
      await pool.query('select 1 from drizzle.__drizzle_migrations where created_at=$1', [
        entry.when,
      ])
    ).rowCount,
  ).toBe(1);

  for (const key of [
    'duplicate_place',
    'incorrect_location',
    'permanently_closed',
    'not_public_place',
    'inappropriate_content',
    'other',
  ]) {
    await pool.query('update place_submissions set rejection_reason=$1 where id=$2', [key, ids[2]]);
  }
  await expect(
    pool.query('update place_submissions set rejection_reason=$1 where id=$2', ['unknown', ids[2]]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'place_submissions_rejection_reason_check',
  });
  await expect(
    pool.query('update place_submissions set rejection_reason=$1 where id=$2', ['other', ids[0]]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool.query('update place_submissions set rejection_reason=$1 where id=$2', ['other', ids[1]]),
  ).rejects.toMatchObject({ code: '23514' });

  // Execute the documented schema rollback. Historical status/note survive.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      'ALTER TABLE place_submissions DROP CONSTRAINT place_submissions_rejection_reason_check',
    );
    await client.query('ALTER TABLE place_submissions DROP COLUMN rejection_reason');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const rolledBack = await pool.query(
    'select id, status, decision_reason from place_submissions order by google_place_id',
  );
  expect(rolledBack.rows).toEqual(
    ids.map((id, i) => ({
      id,
      status: statuses[i],
      decision_reason: 'PRIVATE legacy note',
    })),
  );
  await expect(pool.query('select rejection_reason from place_submissions')).rejects.toMatchObject({
    code: '42703',
  });

  // A roll-forward restores the additive column without exposing private text.
  const migration = await readFile(path.join(folder, `${entry.tag}.sql`), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) await pool.query(statement);
  const restored = await pool.query('select rejection_reason from place_submissions');
  expect(restored.rows).toEqual(ids.map(() => ({ rejection_reason: null })));
});
