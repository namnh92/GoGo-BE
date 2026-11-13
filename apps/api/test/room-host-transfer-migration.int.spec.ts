import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

const root = path.resolve(__dirname, '../../..');
let container: StartedPostgreSqlContainer;
const pools: Pool[] = [];
async function oldSnapshot() {
  const database = 'm' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: container.getConnectionUri() });
  await admin.query(`create database ${database}`);
  await admin.end();
  const url = new URL(container.getConnectionUri());
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  pools.push(pool);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'host-transfer-migration-'));
  try {
    const journal = JSON.parse(
      await readFile(path.join(root, 'migrations/meta/_journal.json'), 'utf8'),
    );
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 105);
    await mkdir(path.join(folder, 'meta'));
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await cp(
        path.join(root, 'migrations', entry.tag + '.sql'),
        path.join(folder, entry.tag + '.sql'),
      );
    await migrate(drizzle(pool, { schema }), { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return pool;
}
async function seed(pool: Pool, host = true) {
  const users = (
    await pool.query("insert into users(display_name) values ('A'),('B') returning id")
  ).rows;
  const room = (
    await pool.query(
      "insert into rooms(code,type,decision_mode,host_user_id) values($1,'group','host',$2) returning id",
      [randomUUID(), users[0].id],
    )
  ).rows[0].id;
  const members = (
    await pool.query(
      `insert into room_members(room_id,user_id,role,display_name)
    values($1,$2,$4,'A'),($1,$3,'member','B') returning id`,
      [room, users[0].id, users[1].id, host ? 'host' : 'member'],
    )
  ).rows;
  return { room, users, members };
}
const upgrade = (pool: Pool) =>
  migrate(drizzle(pool, { schema }), { migrationsFolder: path.join(root, 'migrations') });
async function ops(pool: Pool, file: string) {
  const client = await pool.connect();
  try {
    const script = await readFile(path.join(root, 'scripts/ops', file), 'utf8');
    if (file === 'activate-room-host-transfer.sql') await client.query(script);
    else
      for (const statement of script
        .replace(/--[^\n]*/g, '')
        .split(';')
        .filter((s) => s.trim()))
        await client.query(statement);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
}, 180000);
afterAll(async () => {
  for (const p of pools) await p.end();
  await container?.stop();
});

describe('host migration, readiness and compatibility rollback (#879)', () => {
  it('fences activation on existing zero-host data without choosing a replacement', async () => {
    const pool = await oldSnapshot();
    const f = await seed(pool, false);
    await upgrade(pool);
    await ops(pool, 'backfill-room-creators.sql');
    await expect(ops(pool, 'activate-room-host-transfer.sql')).rejects.toThrow();
    await pool.query('rollback');
    expect(
      (await pool.query('select enabled from room_host_transfer_rollout')).rows[0].enabled,
    ).toBe(false);
    await pool.query("update room_members set role='host' where id=$1", [f.members[0].id]);
  });
  it('upgrades a populated snapshot, backfills in batches and supports old-binary create atomically', async () => {
    const pool = await oldSnapshot();
    const f = await seed(pool);
    // Representative volume for correctness; DEV must measure production-sized lock/runtime separately.
    await pool.query(
      `with r as (insert into rooms(code,type,decision_mode,host_user_id)
      select gen_random_uuid()::text,'group','host',$1 from generate_series(1,2500) returning id)
      insert into room_members(room_id,user_id,role,display_name) select id,$1,'host','A' from r`,
      [f.users[0].id],
    );
    await upgrade(pool);
    expect((await pool.query('select room_host_transfer_ready() ready')).rows[0].ready).toBe(false);
    for (let n = 0; n < 3; n++) await ops(pool, 'backfill-room-creators.sql');
    expect(
      (await pool.query('select count(*)::int n from rooms where created_by_user_id is null'))
        .rows[0].n,
    ).toBe(0);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const r = (
        await client.query(
          "insert into rooms(code,type,decision_mode,host_user_id) values($1,'group','host',$2) returning *",
          [randomUUID(), f.users[0].id],
        )
      ).rows[0];
      await client.query(
        "insert into room_members(room_id,user_id,role,display_name) values($1,$2,'host','A')",
        [r.id, f.users[0].id],
      );
      await client.query('commit');
      expect(r.created_by_user_id).toBe(f.users[0].id);
    } finally {
      await client.query('rollback');
      client.release();
    }
    await ops(pool, 'index-room-active-host.sql');
    await ops(pool, 'validate-room-host-transfer.sql');
    await pool.query(
      'update room_host_transfer_rollout set enabled=true,api_guards_ready=true,workers_ready=true,clients_ready=true,preflight_passed=true',
    );
    expect((await pool.query('select room_host_transfer_ready() ready')).rows[0].ready).toBe(true);
    // Same-name malformed index cannot pass the readiness fence.
    await pool.query('drop index concurrently room_members_active_host_unique');
    await pool.query('create index room_members_active_host_unique on room_members(room_id)');
    expect((await pool.query('select room_host_transfer_ready() ready')).rows[0].ready).toBe(false);
    await pool.query('drop index concurrently room_members_active_host_unique');
    await ops(pool, 'index-room-active-host.sql');
    expect((await pool.query('select room_host_transfer_ready() ready')).rows[0].ready).toBe(true);
  });
  it('rejects direct two-host, zero-host, pointer mismatch and guest-host commits; permits transfer and deletion', async () => {
    const pool = await oldSnapshot();
    const f = await seed(pool);
    await upgrade(pool);
    await ops(pool, 'index-room-active-host.sql');
    for (const [q, params] of [
      ["update room_members set role='host' where id=$1", [f.members[1].id]],
      ["update room_members set role='member' where id=$1", [f.members[0].id]],
      ['delete from room_members where id=$1', [f.members[0].id]],
      ['update rooms set host_user_id=$2 where id=$1', [f.room, f.users[1].id]],
      ['update room_members set removed_at=now() where id=$1', [f.members[0].id]],
    ] as const)
      await expect(pool.query(q, [...params])).rejects.toThrow();
    const guest = (
      await pool.query(
        "insert into guest_sessions(room_id,display_name,token_hash,expires_at) values($1,'G',$2,now()+interval '1 day') returning id",
        [f.room, randomUUID()],
      )
    ).rows[0].id;
    await expect(
      pool.query('update room_members set user_id=null,guest_session_id=$2 where id=$1', [
        f.members[0].id,
        guest,
      ]),
    ).rejects.toThrow();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from rooms where id=$1 for update', [f.room]);
      await client.query("update room_members set role='member' where id=$1", [f.members[0].id]);
      await client.query("update room_members set role='host' where id=$1", [f.members[1].id]);
      await client.query(
        'update rooms set host_user_id=$2,host_version=host_version+1 where id=$1',
        [f.room, f.users[1].id],
      );
      await client.query('commit');
      expect(
        (await pool.query('select host_version from rooms where id=$1', [f.room])).rows[0]
          .host_version,
      ).toBe(2);
      // Compatibility rollback is a producer fence. It never reverses roles/version/history.
      await pool.query('update room_host_transfer_rollout set enabled=false');
      expect(
        (await pool.query('select host_user_id from rooms where id=$1', [f.room])).rows[0]
          .host_user_id,
      ).toBe(f.users[1].id);
      await pool.query('delete from rooms where id=$1', [f.room]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
