import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '@gogo/database';
import { sql } from 'drizzle-orm';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let folder: string;
const migrations = path.resolve(__dirname, '../../../migrations');
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  folder = await mkdtemp(path.join(tmpdir(), 's5-migrations-'));
  await mkdir(path.join(folder, 'meta'));
  const journal = JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
  const all = journal.entries as { idx: number; when: number; tag: string }[];
  expect(new Set(all.map((e) => e.idx)).size).toBe(all.length);
  expect(all.every((e, i) => !i || e.when > all[i - 1]!.when)).toBe(true);
  journal.entries = all.filter((e) => e.idx < 103);
  await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const e of journal.entries)
    await copyFile(path.join(migrations, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
  await migrate(db, { migrationsFolder: folder });
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});
it('0103 forward on a populated pre-S5 database, rerun, unique/FK/indexes and rollback', async () => {
  const p = (
    await db.execute(
      sql`insert into places(name,name_normalized,status,geom) values ('Tiệm Trà Sân Vườn','trigger','published',ST_SetSRID(ST_MakePoint(105.79,21.03),4326)) returning id,updated_at`,
    )
  ).rows[0]!;
  expect((await db.execute(sql`select to_regclass('place_aliases') as name`)).rows).toEqual([
    { name: null },
  ]);
  await migrate(db, { migrationsFolder: migrations });
  expect(
    (await db.execute(sql`select updated_at from places where id=${p.id}::uuid`)).rows[0]!
      .updated_at,
  ).toEqual(p.updated_at);
  await migrate(db, { migrationsFolder: migrations });
  const indexes = await db.execute(
    sql`select indexname,indexdef from pg_indexes where tablename='place_aliases'`,
  );
  expect(indexes.rows.map((r) => r.indexname).sort()).toEqual([
    'place_aliases_normalized_idx',
    'place_aliases_normalized_trgm_idx',
    'place_aliases_place_normalized_unique',
  ]);
  expect(
    indexes.rows.find((r) => r.indexname === 'place_aliases_normalized_trgm_idx')!.indexdef,
  ).toContain('gin_trgm_ops');
  const insert = () =>
    db.execute(
      sql`insert into place_aliases(place_id,alias,alias_normalized,source_type,source_reference,collected_at) values (${p.id}::uuid,'Garden Tea','garden tea','editorial','Merchant interview',now())`,
    );
  await insert();
  await expect(insert()).rejects.toThrow();
  await expect(
    db.execute(
      sql`insert into place_aliases(place_id,alias,alias_normalized,source_type,source_reference,collected_at) values ('00000000-0000-4000-8000-000000000000','Garden Tea','garden tea','editorial','Merchant interview',now())`,
    ),
  ).rejects.toThrow();
  await db.execute(sql`drop table place_aliases`);
  expect(
    (await db.execute(sql`select count(*)::int as n from places where id=${p.id}::uuid`)).rows,
  ).toEqual([{ n: 1 }]);
});
