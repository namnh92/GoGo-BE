import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { PrivacyJobs } from '@gogo/modules';

/**
 * #576 fix-forward (retro SA review F-01 on PR #640) — the origin retention
 * purge and a constraint edit serialize on the room row.
 *
 * `applyConstraintVersion` merges omitted fields from `previous`, the
 * constraint row it reads while holding `rooms ... FOR UPDATE`. That merge is
 * only safe if the purge cannot null the stored coordinates between that read
 * and the insert of the new version — so the purge has to take the same room
 * lock before it writes.
 *
 * Under today's state machine the two never meet on a real room: the purge
 * only picks terminal rooms and the edit refuses them under its lock. The test
 * therefore stands in for the edit with a raw transaction that does what
 * `applyConstraintVersion` does — lock the room, read `previous`, insert the
 * next version copying the coordinates, bump the room — on a room the purge
 * has selected. What it pins is the lock order, so a future path that edits or
 * reopens such a room cannot resurrect a purged origin.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_origin_retention')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function finishedRoomWithOrigin(): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 8);
  const user = await pool.query(
    'insert into users (email, display_name) values ($1, $2) returning id',
    [`${tag}@retention.gogo.test`, tag],
  );
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: `RT${tag.toUpperCase()}`,
      type: 'group',
      decisionMode: 'vote',
      status: 'completed',
      hostUserId: user.rows[0].id as string,
    })
    .returning();
  await pool.query(`update rooms set updated_at = now() - interval '31 days' where id = $1`, [
    room!.id,
  ]);
  await db.insert(schema.roomConstraints).values({
    roomId: room!.id,
    version: 1,
    originText: 'Hồ Gươm',
    originLat: 21.0287,
    originLng: 105.8524,
    budgetMode: 'total',
    budgetAmount: 500_000,
  });
  return room!.id;
}

/** True once `pid` is blocked waiting for a lock. */
async function isWaitingOnLock(pid: number): Promise<boolean> {
  const res = await pool.query(
    `select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
    [pid],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Waits until the purge has either finished or is parked behind a lock. */
async function purgeSettledOrBlocked(
  purge: Promise<unknown>,
  editorPid: number,
): Promise<'finished' | 'blocked'> {
  let finished = false;
  void purge.then(
    () => (finished = true),
    () => (finished = true),
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (finished) return 'finished';
    const blocked = await pool.query(
      `select pid from pg_stat_activity
        where pid <> $1 and wait_event_type = 'Lock' and query ilike '%rooms%'`,
      [editorPid],
    );
    if ((blocked.rowCount ?? 0) > 0 && (await isWaitingOnLock(blocked.rows[0].pid as number))) {
      return 'blocked';
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('purge neither finished nor blocked within 10s');
}

describe('origin retention vs constraint edit (#576, retro F-01)', () => {
  it('a purge overlapping an edit leaves no origin on any version, the new one included', async () => {
    const roomId = await finishedRoomWithOrigin();

    const editor: PoolClient = await pool.connect();
    const editorPid = (await editor.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    let purge: Promise<unknown> | undefined;
    let state: 'finished' | 'blocked' | undefined;
    try {
      // The edit: lock the room, then read `previous` under that lock.
      await editor.query('begin');
      await editor.query('select id from rooms where id = $1 for update', [roomId]);
      const previous = (
        await editor.query(
          'select origin_lat, origin_lng from room_constraints where room_id = $1 and version = 1',
          [roomId],
        )
      ).rows[0] as { origin_lat: number | null; origin_lng: number | null };
      expect(previous.origin_lat).not.toBeNull();

      // The purge starts while the edit holds the room lock.
      purge = new PrivacyJobs(db as never).run(false);
      state = await purgeSettledOrBlocked(purge, editorPid);

      // The edit inserts the next version, copying the coordinates it read,
      // and bumps the room exactly like `applyConstraintVersion`.
      await editor.query(
        `insert into room_constraints
           (room_id, version, origin_text, origin_lat, origin_lng, budget_mode, budget_amount)
         values ($1, 2, 'Hồ Gươm', $2, $3, 'total', 600000)`,
        [roomId, previous.origin_lat, previous.origin_lng],
      );
      await editor.query(
        `update rooms set constraint_version = 2, updated_at = now() where id = $1`,
        [roomId],
      );
      await editor.query('commit');

      await purge;
    } finally {
      await purge?.catch(() => undefined);
      editor.release();
    }

    const rows = await pool.query(
      `select version, origin_text, origin_lat, origin_lng
         from room_constraints where room_id = $1 order by version`,
      [roomId],
    );
    expect(rows.rows).toEqual([
      { version: 1, origin_text: 'Hồ Gươm', origin_lat: null, origin_lng: null },
      { version: 2, origin_text: 'Hồ Gươm', origin_lat: null, origin_lng: null },
    ]);
    // ...because the purge waited for the room lock rather than ran past it.
    expect(state).toBe('blocked');
  }, 30_000);

  it('a room nobody holds is purged as before, and originText stays', async () => {
    const roomId = await finishedRoomWithOrigin();
    const dry = await new PrivacyJobs(db as never).run(true);
    expect(dry.originsCleared).toBeGreaterThanOrEqual(1);
    const report = await new PrivacyJobs(db as never).run(false);
    expect(report.originsCleared).toBeGreaterThanOrEqual(1);
    const rows = await pool.query(
      'select origin_text, origin_lat, origin_lng from room_constraints where room_id = $1',
      [roomId],
    );
    expect(rows.rows).toEqual([{ origin_text: 'Hồ Gươm', origin_lat: null, origin_lng: null }]);
    // A second run finds nothing left to clear for this room.
    const again = await new PrivacyJobs(db as never).run(true);
    expect(again.originsCleared).toBe(0);
  }, 30_000);

  it('a room still in planning is not touched', async () => {
    const roomId = await finishedRoomWithOrigin();
    await pool.query(`update rooms set status = 'collecting' where id = $1`, [roomId]);
    await new PrivacyJobs(db as never).run(false);
    const rows = await pool.query(
      'select origin_lat, origin_lng from room_constraints where room_id = $1',
      [roomId],
    );
    expect(rows.rows).toEqual([{ origin_lat: 21.0287, origin_lng: 105.8524 }]);
  }, 30_000);
});
