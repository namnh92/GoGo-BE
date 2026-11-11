import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertPlaceNameKeyReady } from '../../../libs/modules/shared/place-name-key-readiness';
import { SearchService } from '../../../libs/modules/search/application/search.service';
import { SearchRepository } from '../../../libs/modules/search/infrastructure/search.repository';
import { schema } from '@gogo/database';

/**
 * #857 — migration 0102 forward-tested on a populated pre-0102 database, mandatory post-migration concurrent ops, readiness, recovery, and rollback. Real PostGIS; no application code beyond the migrations.
 */
const migrations = path.resolve(__dirname, '../../../migrations');
const opsFile = path.resolve(__dirname, '../../../scripts/ops/index-place-name-key.sql');
const KEY = `btrim(regexp_replace(name_normalized, '${schema.PLACE_NAME_KEY_WHITESPACE}', ' ', 'g'), ' ')`;
let container: StartedPostgreSqlContainer;
const pools: Pool[] = [];

async function populatedBefore0102(database: string) {
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`create database ${database} template template_postgis`).catch(async () => {
    await admin.query(`create database ${database}`);
  });
  await admin.end();
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  pools.push(pool);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'place-name-key-'));
  try {
    const journal = JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 102);
    await mkdir(path.join(folder, 'meta'));
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await cp(path.join(migrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    await migrate(drizzle(pool, { schema }), { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  // Existing rows, written before the index exists; the trigger keeps the odd whitespace.
  await pool.query(`insert into places(name,name_normalized,status,geom)
    select v, 'trigger', 'published', ST_SetSRID(ST_MakePoint(106.7,10.7),4326)
    from unnest(array['Sương Mai','Sương  Mai',E' Sương\\tMai ','Khác Hẳn']) v`);
  await pool.query(`insert into places(name,name_normalized,status,geom)
    select 'Bulk ' || n, 'trigger', 'published', ST_SetSRID(ST_MakePoint(106.7,10.7),4326)
    from generate_series(1,3000) n`);
  return pool;
}
const index = (pool: Pool) =>
  pool.query(
    `select i.indisvalid, i.indisready from pg_index i where i.indexrelid = to_regclass('places_name_key_idx')`,
  );
async function familyThroughIndex(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local enable_seqscan = off');
    const plan = await client.query(
      `explain (format json) select id from places p where ${KEY} = any(array['suong mai']::text[])`,
    );
    const rows = await client.query(
      `select name from places p where ${KEY} = any(array['suong mai']::text[]) order by name`,
    );
    await client.query('rollback');
    return { plan: JSON.stringify(plan.rows), names: rows.rows.map((r) => r.name as string) };
  } finally {
    client.release();
  }
}
async function runOps(pool: Pool) {
  const client = await pool.connect();
  let last: unknown;
  try {
    for (const statement of (await readFile(opsFile, 'utf8'))
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((part) => part.trim()))
      last = (await client.query(statement)).rows?.[0] ?? last;
    return last;
  } finally {
    client.release(true);
  }
}
const ready = (pool: Pool) => assertPlaceNameKeyReady(drizzle(pool, { schema }));
const notReady = (pool: Pool) =>
  expect(ready(pool)).rejects.toMatchObject({ code: 'PLACE_NAME_KEY_NOT_READY' });
async function resolverUnavailable(pool: Pool) {
  const db = drizzle(pool, { schema });
  const service = new SearchService(new SearchRepository(db), db);
  await expect(service.resolvePlaceName('Sương Mai')).rejects.toMatchObject({
    reason: 'read_error',
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await container?.stop();
});

describe('migration 0102: places_name_key_idx on a populated database', () => {
  it('forward: indexes existing rows, changes no data, and is re-runnable; rollback is DROP INDEX', async () => {
    const pool = await populatedBefore0102('name_key_forward');
    expect((await index(pool)).rows).toEqual([]);
    const before = await pool.query(
      `select md5(string_agg(id::text || name || name_normalized || updated_at::text, ',' order by id)) as digest, count(*)::int as count from places`,
    );
    await migrate(drizzle(pool, { schema }), { migrationsFolder: migrations });
    expect((await index(pool)).rows).toEqual([]);
    await notReady(pool);
    await resolverUnavailable(pool);
    expect(await runOps(pool)).toEqual({ places_name_key_idx_ready: 1 });
    await ready(pool);
    expect((await index(pool)).rows).toEqual([{ indisvalid: true, indisready: true }]);
    const after = await pool.query(
      `select md5(string_agg(id::text || name || name_normalized || updated_at::text, ',' order by id)) as digest, count(*)::int as count from places`,
    );
    expect(after.rows).toEqual(before.rows);
    const family = await familyThroughIndex(pool);
    expect(family.plan).toContain('places_name_key_idx');
    expect(family.names).toEqual([' Sương\tMai ', 'Sương  Mai', 'Sương Mai'].sort());
    // Readiness check accepts the ops-built shape; ops and migrate are both idempotent.
    expect(await runOps(pool)).toEqual({ places_name_key_idx_ready: 1 });
    await migrate(drizzle(pool, { schema }), { migrationsFolder: migrations });
    // New and renamed rows are maintained by the index like any other.
    await pool.query(`update places set name = 'Sương   Mai' where name = 'Khác Hẳn'`);
    expect((await familyThroughIndex(pool)).names).toHaveLength(4);
    // Rollback: the index is the whole change. Equality still answers without it.
    await pool.query('drop index concurrently places_name_key_idx');
    await notReady(pool);
    await resolverUnavailable(pool);
    const rows = await pool.query(
      `select count(*)::int as count from places p where ${KEY} = any(array['suong mai']::text[])`,
    );
    expect(rows.rows).toEqual([{ count: 4 }]);
  });
  it('prebuild path: ops builds CONCURRENTLY first, then 0102 is a no-op on the same valid index', async () => {
    const pool = await populatedBefore0102('name_key_concurrent');
    expect(await runOps(pool)).toEqual({ places_name_key_idx_ready: 1 });
    const built = await pool.query(`select to_regclass('places_name_key_idx')::oid as oid`);
    await migrate(drizzle(pool, { schema }), { migrationsFolder: migrations });
    expect(
      (await pool.query(`select to_regclass('places_name_key_idx')::oid as oid`)).rows,
    ).toEqual(built.rows);
    expect((await index(pool)).rows).toEqual([{ indisvalid: true, indisready: true }]);
    expect((await familyThroughIndex(pool)).plan).toContain('places_name_key_idx');
  });
  it('rejects incompatible same-name shapes in ops and runtime, without silently rebuilding', async () => {
    const pool = await populatedBefore0102('name_key_wrong');
    for (const definition of [
      'on places(name_normalized)',
      `on places ((${KEY.replace("' ', 'g'", "'', 'g'")}))`,
      `on places using hash ((${KEY}))`,
      `on places ((${KEY}) text_pattern_ops)`,
      `on places ((${KEY}) desc)`,
      `on places ((${KEY})) where status='published'`,
      `on places ((${KEY})) include(id)`,
    ]) {
      await pool.query(`create index concurrently places_name_key_idx ${definition}`);
      const before = (await pool.query("select to_regclass('places_name_key_idx')::oid as oid"))
        .rows;
      await migrate(drizzle(pool, { schema }), { migrationsFolder: migrations });
      await notReady(pool);
      await resolverUnavailable(pool);
      await expect(runOps(pool)).rejects.toThrow(/DROP INDEX CONCURRENTLY/);
      expect(
        (await pool.query("select to_regclass('places_name_key_idx')::oid as oid")).rows,
      ).toEqual(before);
      await pool.query('drop index concurrently places_name_key_idx');
    }
    await runOps(pool);
    await ready(pool);
  });
  it('detects a genuinely interrupted concurrent build, refuses the remnant, and recovers', async () => {
    const pool = await populatedBefore0102('name_key_interrupted');
    const writer = await pool.connect();
    const builder = await pool.connect();
    try {
      await writer.query('begin');
      await writer.query("update places set name=name where name='Khác Hẳn'");
      const pid = (await builder.query('select pg_backend_pid() as pid')).rows[0].pid;
      const building = builder
        .query(`create index concurrently places_name_key_idx on places ((${KEY}))`)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        const deadline = Date.now() + 5000;
        while (!(await index(pool)).rows.length && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect((await index(pool)).rows).toEqual([{ indisvalid: false, indisready: false }]);
      } finally {
        await pool.query('select pg_cancel_backend($1)', [pid]);
        await building;
      }
      expect(await building).toMatchObject({ code: '57014' });
      await writer.query('rollback');
      await notReady(pool);
      await resolverUnavailable(pool);
      await expect(runOps(pool)).rejects.toThrow(/DROP INDEX CONCURRENTLY/);
      await pool.query('drop index concurrently places_name_key_idx');
      await runOps(pool);
      await ready(pool);
    } finally {
      await writer.query('rollback');
      writer.release();
      builder.release();
    }
  });
  it('migration completes with an open writer; concurrent build permits another writer', async () => {
    const pool = await populatedBefore0102('name_key_writers');
    const writer = await pool.connect();
    try {
      await writer.query('begin');
      await writer.query("update places set name=name where name='Khác Hẳn'");
      const migration = await readFile(
        path.join(migrations, '0102_place-name-key-index.sql'),
        'utf8',
      );
      const migrating = await pool.connect();
      try {
        await migrating.query('begin');
        await migrating.query("set local statement_timeout='500ms'");
        await migrating.query(migration);
        await migrating.query('commit');
      } finally {
        await migrating.query('rollback');
        migrating.release();
      }
      const building = runOps(pool);
      try {
        const deadline = Date.now() + 5000;
        while (!(await index(pool)).rows.length && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect((await index(pool)).rows).toHaveLength(1);
        const concurrent = await pool.connect();
        try {
          await concurrent.query('begin');
          await concurrent.query("set local statement_timeout='500ms'");
          await concurrent.query("update places set name='Bulk renamed' where name='Bulk 1'");
          await concurrent.query('commit');
        } finally {
          await concurrent.query('rollback');
          concurrent.release();
        }
      } finally {
        await writer.query('rollback');
        await building;
      }
      await ready(pool);
      expect(
        (await pool.query("select count(*)::int as n from places where name='Bulk renamed'")).rows,
      ).toEqual([{ n: 1 }]);
    } finally {
      await writer.query('rollback');
      writer.release();
    }
  });
});
