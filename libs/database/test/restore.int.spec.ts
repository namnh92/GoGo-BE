import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { execFileSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src';

/**
 * DB-002 (#21) — the restore drill, as a test.
 *
 * The runbook has described a quarterly restore drill for a while. A drill
 * that is only ever described is a drill nobody has run: the first time anyone
 * finds out whether a dump restores is during an incident, which is the worst
 * moment to learn that an extension was missing or a constraint did not come
 * back.
 *
 * This dumps a populated database, restores it into a *fresh* server, and
 * checks the things that actually matter after a restore — not just that rows
 * are present, but that the invariants which protect them are.
 */
let source: StartedPostgreSqlContainer;
let target: StartedPostgreSqlContainer;
let sourcePool: Pool;
let targetPool: Pool;

const migrationsFolder = path.resolve(__dirname, '../../../migrations');

beforeAll(async () => {
  source = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_restore_source')
    .start();
  target = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_restore_target')
    .start();

  sourcePool = new Pool({ connectionString: source.getConnectionUri(), max: 2 });
  sourcePool.on('error', () => undefined);
  targetPool = new Pool({ connectionString: target.getConnectionUri(), max: 2 });
  targetPool.on('error', () => undefined);

  const db = drizzle(sourcePool, { schema });
  await migrate(db, { migrationsFolder });

  // Enough real data that a restore has something to get wrong.
  const [host] = await db
    .insert(schema.users)
    .values({ displayName: 'Host', email: 'restore-host@gogo.vn' })
    .returning();
  const [room] = await db
    .insert(schema.rooms)
    .values({
      hostUserId: host!.id,
      code: 'RESTORE1',
      type: 'group',
      decisionMode: 'vote',
      participantCount: 3,
      status: 'collecting',
    })
    .returning();
  await db.insert(schema.places).values({
    name: 'Cà Phê Đà Lạt',
    nameNormalized: 'set-by-trigger',
    status: 'published',
    geom: { x: 106.7009, y: 10.7769 },
  });
  await db.insert(schema.plans).values({
    roomId: room!.id,
    version: 1,
    status: 'current',
    constraintVersion: 1,
    totals: {
      costMin: 0,
      costMax: 0,
      currency: 'VND',
      durationMinutes: 0,
      travelDistanceM: 0,
      overBudget: false,
      uncertain: false,
    },
  });
}, 300_000);

afterAll(async () => {
  await sourcePool?.end();
  await targetPool?.end();
  await source?.stop();
  await target?.stop();
});

describe('backup and restore drill (DB-002, #21)', () => {
  it('restores a dump into a fresh server with its data and invariants intact', async () => {
    // pg_dump/pg_restore run inside the container, so the drill does not
    // depend on a matching client version being installed on whoever's laptop.
    // Exclude the schemas PostGIS ships with. Dumping them makes every
    // restore fail on "schema already exists"; selecting only `public` instead
    // makes it fail on `CREATE SCHEMA public` and on f_unaccent resolving
    // before its extension. Both are drill findings worth keeping, because the
    // errors look alarming and neither means the backup is bad.
    const dump = await source.exec([
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--exclude-schema=tiger',
      '--exclude-schema=tiger_data',
      '--exclude-schema=topology',
      '--file=/tmp/gogo.dump',
      '--username=test',
      '--dbname=gogo_restore_source',
    ]);
    expect(dump.exitCode).toBe(0);

    const copied = execFileSync('docker', [
      'cp',
      `${source.getId()}:/tmp/gogo.dump`,
      '/tmp/gogo-restore-drill.dump',
    ]);
    void copied;
    execFileSync('docker', [
      'cp',
      '/tmp/gogo-restore-drill.dump',
      `${target.getId()}:/tmp/gogo.dump`,
    ]);

    const restore = await target.exec([
      'pg_restore',
      '--no-owner',
      '--username=test',
      '--dbname=gogo_restore_target',
      '/tmp/gogo.dump',
    ]);
    expect(restore.exitCode).toBe(0);

    const restored = drizzle(targetPool, { schema });

    // 1. The data came back.
    const rooms = await restored.execute(sql`select code from rooms`);
    expect((rooms.rows as { code: string }[]).map((r) => r.code)).toContain('RESTORE1');

    // 2. Extensions came back. Without unaccent, Vietnamese search silently
    //    stops matching and nothing errors.
    const unaccent = await restored.execute(sql`select f_unaccent('Đà') as v`);
    expect((unaccent.rows[0] as { v: string }).v).toBe('Da');

    // 3. PostGIS geometry survived as geometry, not as text.
    const geo = await restored.execute(
      sql`select ST_X(geom)::numeric(10,4) as lng from places limit 1`,
    );
    expect(Number((geo.rows[0] as { lng: string }).lng)).toBeCloseTo(106.7009, 3);

    // 4. Triggers came back. A restored database that accepts writes the
    //    original refused is the failure that looks like success.
    await restored.execute(sql`
      insert into places (name, name_normalized, status, geom)
      values ('Quán Ăn Ngon', 'placeholder', 'published', ST_SetSRID(ST_MakePoint(106.7, 10.77), 4326))
    `);
    const normalized = await restored.execute(
      sql`select name_normalized from places where name = 'Quán Ăn Ngon'`,
    );
    expect((normalized.rows[0] as { name_normalized: string }).name_normalized).toContain(
      'quan an',
    );

    // 5. Constraints came back — one current plan per room (FR-PLAN-001).
    const roomId = (
      (await restored.execute(sql`select id from rooms limit 1`)).rows[0] as { id: string }
    ).id;
    await expect(
      restored.execute(sql`
        insert into plans (room_id, status, constraint_version, totals)
        values (${roomId}::uuid, 'current', 1, '{}'::jsonb)
      `),
    ).rejects.toThrow();

    // 6. The migration ledger matches, so the restored database knows which
    //    migrations it has and the next deploy does not re-run them.
    const applied = async (pool: Pool) =>
      (
        await pool.query<{ n: string }>(
          'select count(*)::text as n from drizzle.__drizzle_migrations',
        )
      ).rows[0]!.n;
    expect(await applied(targetPool)).toBe(await applied(sourcePool));
  }, 300_000);
});
