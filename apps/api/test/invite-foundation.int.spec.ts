import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb } from '@gogo/database';
import { NoopMetrics } from '@gogo/observability';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  InviteCodeCrypto,
  type InviteKeyConfig,
} from '../../../libs/modules/rooms/application/invite-code-crypto';
import { InviteCodeReservations } from '../../../libs/modules/rooms/infrastructure/invite-code-reservations';
import { assertInviteFoundationReady } from '../../../libs/modules/rooms/infrastructure/invite-foundation-readiness';

const root = path.resolve(__dirname, '../../..');
const folder = path.join(root, 'migrations');
const ops = readFileSync(path.join(root, 'scripts/ops/prepare-invite-foundation.sql'), 'utf8');
const down = readFileSync(path.join(root, 'scripts/rollback/0104-invite-foundation.sql'), 'utf8');
const metrics = new NoopMetrics();
const key = () => randomBytes(32).toString('hex');
const keys: InviteKeyConfig = {
  lookupKey: key(),
  replayKey: key(),
  bucketKey: key(),
  activeEncryptionVersion: 'v1',
  encryptionKeys: { v1: key() },
};
const pools: Pool[] = [];
let container: StartedPostgreSqlContainer;
let upgraded: ReturnType<typeof createDb>;
let fresh: ReturnType<typeof createDb>;
let rollbackDb: ReturnType<typeof createDb>;
let lockedSnapshot: ReturnType<typeof createDb>;
let baselineFolder: string;
let legacy: { roomId: string; userId: string; memberId: string; inviteId: string; linkId: string };
let legacyBefore: unknown;

async function database(name: string, template?: string) {
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  // All names here are fixed test constants, never request input.
  try {
    await admin.query(`create database ${name}${template ? ` template ${template}` : ''}`);
  } finally {
    await admin.end();
  }
  const instance = createDb(container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, `/${name}$1`), {
    max: 8,
  });
  pools.push(instance.pool);
  return instance;
}
async function prepare(pool: Pool) {
  // CONCURRENTLY must be sent separately, outside an implicit multi-statement transaction.
  for (const statement of ops
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await pool.query(statement);
}
async function seed(db: ReturnType<typeof createDb>['db']) {
  const userId = randomUUID(),
    roomId = randomUUID(),
    memberId = randomUUID(),
    inviteId = randomUUID(),
    linkId = randomUUID();
  // Keep the historical INSERT shape, but commit room + host together for 0105.
  // Transactions also work on the populated 0103 snapshot before that trigger exists.
  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into users(id,display_name) values(${userId},'synthetic host')`);
    await tx.execute(sql`insert into rooms(id,code,type,decision_mode,host_user_id,expires_at)
      values(${roomId},${randomBytes(9).toString('base64url')},'group','host',${userId},now()+interval '1 day')`);
    await tx.execute(
      sql`insert into room_members(id,room_id,user_id,role,display_name) values(${memberId},${roomId},${userId},'host','synthetic host')`,
    );
    await tx.execute(sql`insert into room_invites(id,room_id,code_hash,created_by_member_id,expires_at,max_uses,use_count,revoked_at)
      values(${inviteId},${roomId},${key()},${memberId},now()-interval '1 hour',1,1,now()-interval '2 hours')`);
    await tx.execute(sql`insert into share_links(id,slug_hash,type,target_id,invite_id,created_by_user_id,expires_at,revoked_at)
      select ${linkId},${key()},'ROOM_INVITE',${roomId},${inviteId},${userId},expires_at,revoked_at from room_invites where id=${inviteId}`);
  });
  return { userId, roomId, memberId, inviteId, linkId };
}
async function legacyRows(db: ReturnType<typeof createDb>['db']) {
  return (
    await db.execute(sql`select r.code,r.expires_at as room_expiry,i.code_hash,i.expires_at,i.revoked_at,i.use_count,i.max_uses,s.slug_hash
    from rooms r join room_invites i on i.room_id=r.id join share_links s on s.invite_id=i.id where r.id=${legacy.roomId}`)
  ).rows;
}
async function foundationShape(db: ReturnType<typeof createDb>['db']) {
  const columns =
    await db.execute(sql`select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns
    where table_schema='public' and table_name in ('rooms','users','room_invites','share_links','room_invite_codes') order by table_name,column_name`);
  const indexes = await db.execute(sql`select tablename,indexname,indexdef from pg_indexes
    where schemaname='public' and (tablename='room_invite_codes' or indexname='users_host_share_id_unique') order by indexname`);
  return { columns: columns.rows, indexes: indexes.rows };
}
const allocationInput = (s: Awaited<ReturnType<typeof seed>>) => ({
  roomId: s.roomId,
  actorUserId: s.userId,
  expectedInvitationEpoch: 0n,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('invite_admin')
    .start();
  baselineFolder = mkdtempSync(path.join(tmpdir(), 'be889-baseline-'));
  mkdirSync(path.join(baselineFolder, 'meta'));
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 103);
  for (const entry of journal.entries)
    copyFileSync(
      path.join(folder, `${entry.tag}.sql`),
      path.join(baselineFolder, `${entry.tag}.sql`),
    );
  writeFileSync(path.join(baselineFolder, 'meta/_journal.json'), JSON.stringify(journal));
  const baseline = await database('invite_snapshot_0103');
  await migrate(baseline.db, { migrationsFolder: baselineFolder });
  legacy = await seed(baseline.db);
  legacyBefore = await legacyRows(baseline.db);
  // Frozen, populated 0103 database copied using PostgreSQL's real snapshot/template mechanism.
  await baseline.pool.end();
  upgraded = await database('invite_upgraded', 'invite_snapshot_0103');
  rollbackDb = await database('invite_rollback', 'invite_snapshot_0103');
  fresh = await database('invite_fresh');
  lockedSnapshot = await database('invite_locked_snapshot', 'invite_snapshot_0103');
  for (const instance of [upgraded, rollbackDb, fresh]) {
    await migrate(instance.db, { migrationsFolder: folder });
    await expect(assertInviteFoundationReady(instance.db, metrics)).rejects.toThrow(
      'SCHEMA_NOT_READY',
    );
    await prepare(instance.pool);
    await assertInviteFoundationReady(instance.db, metrics);
  }
}, 240_000);
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  await container?.stop();
  if (baselineFolder) rmSync(baselineFolder, { recursive: true, force: true });
});

describe('I03 snapshot-safe expand and internal primitives', () => {
  it('converges from empty/0103, preserves historical credentials and accepts old writers with safe defaults', async () => {
    expect(await foundationShape(upgraded.db)).toEqual(await foundationShape(fresh.db));
    expect(await legacyRows(upgraded.db)).toEqual(legacyBefore);
    const state = await upgraded.db
      .execute(sql`select r.invitation_epoch,r.automatic_invites_suppressed,r.code6_backfill_completed_at,
      i.invitation_epoch as invite_epoch,s.path_version,s.host_share_id,s.invitation_epoch as link_epoch
      from rooms r join room_invites i on i.room_id=r.id join share_links s on s.invite_id=i.id where r.id=${legacy.roomId}`);
    expect(state.rows[0]).toMatchObject({
      invitation_epoch: '0',
      automatic_invites_suppressed: false,
      code6_backfill_completed_at: null,
      invite_epoch: '0',
      link_epoch: '0',
      path_version: 'LEGACY',
      host_share_id: null,
    });
    // Legacy insert SQL omits every new field (expand compatibility).
    const old = await seed(upgraded.db);
    expect(
      (
        await upgraded.db.execute(
          sql`select invitation_epoch from room_invites where id=${old.inviteId}`,
        )
      ).rows[0],
    ).toMatchObject({ invitation_epoch: '0' });
    const count = await upgraded.db.execute(sql`select count(*)::int as n from room_invite_codes`);
    expect(count.rows[0]).toMatchObject({ n: 0 });
  });
  it('bounds DDL lock acquisition on a populated snapshot and cleanly retries after releasing a writer', async () => {
    const writer = await lockedSnapshot.pool.connect();
    try {
      await writer.query('begin');
      await writer.query('select id from rooms for update');
      const started = Date.now();
      await expect(migrate(lockedSnapshot.db, { migrationsFolder: folder })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(
        (
          await lockedSnapshot.db.execute(
            sql`select to_regclass('room_invite_codes') as table_name`,
          )
        ).rows[0],
      ).toMatchObject({ table_name: null });
    } finally {
      await writer.query('rollback');
      writer.release();
    }
    await migrate(lockedSnapshot.db, { migrationsFolder: folder });
    await prepare(lockedSnapshot.pool);
    await assertInviteFoundationReady(lockedSnapshot.db, metrics);
  });
  it('enforces reservation CHECKs, immutable generations and atomic backfill completion', async () => {
    const a = await seed(upgraded.db);
    const service = new InviteCodeReservations(new InviteCodeCrypto(keys));
    // Use a new eligible room without actively revoked legacy grants for this automatic case.
    await upgraded.db.execute(sql`delete from room_invites where room_id=${a.roomId}`);
    await expect(
      upgraded.db.transaction(async (tx) => {
        await service.allocate(tx, { ...allocationInput(a), automatic: true });
        throw new Error('simulate completion failure');
      }),
    ).rejects.toThrow('simulate completion failure');
    expect(
      (
        await upgraded.db.execute(
          sql`select code6_backfill_completed_at from rooms where id=${a.roomId}`,
        )
      ).rows[0],
    ).toMatchObject({ code6_backfill_completed_at: null });
    const generation = await upgraded.db.transaction((tx) =>
      service.allocate(tx, { ...allocationInput(a), automatic: true }),
    );
    for (const change of [
      sql`revoked_at=now()`,
      sql`released_at=now()`,
      sql`reservation_state='CLOSED'`,
      sql`expires_at=issued_at+interval '49 hours'`,
      sql`invitation_epoch=-1`,
      sql`code_lookup='plaintext'`,
    ]) {
      await expect(
        upgraded.db.execute(sql`update room_invite_codes set ${change} where id=${generation.id}`),
      ).rejects.toThrow();
    }
    await expect(
      upgraded.db.execute(
        sql`update rooms set code6_backfill_completed_at=null where id=${a.roomId}`,
      ),
    ).rejects.toThrow();
    const removed = await seed(upgraded.db);
    await expect(
      upgraded.db.transaction((tx) =>
        service.allocate(tx, { ...allocationInput(removed), automatic: true }),
      ),
    ).rejects.toThrow('AUTOMATIC_ISSUANCE_SUPPRESSED');
  });
  it('serializes same-room allocators and resolves cross-room code collisions without deadlocks', async () => {
    const one = await seed(upgraded.db);
    const service = new InviteCodeReservations(new InviteCodeCrypto(keys));
    const same = await Promise.allSettled(
      [1, 2].map(() => upgraded.db.transaction((tx) => service.allocate(tx, allocationInput(one)))),
    );
    expect(same.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(same.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'OPEN_GENERATION_EXISTS' },
    });
    const a = await seed(upgraded.db),
      b = await seed(upgraded.db);
    const ca = new InviteCodeCrypto(keys),
      cb = new InviteCodeCrypto(keys);
    vi.spyOn(ca, 'generateCode').mockReturnValueOnce('222222').mockReturnValue('333333');
    vi.spyOn(cb, 'generateCode').mockReturnValueOnce('222222').mockReturnValue('444444');
    const result = await Promise.all([
      upgraded.db.transaction((tx) =>
        new InviteCodeReservations(ca).allocate(tx, allocationInput(a)),
      ),
      upgraded.db.transaction((tx) =>
        new InviteCodeReservations(cb).allocate(tx, allocationInput(b)),
      ),
    ]);
    expect(new Set(result.map((r) => r.code)).size).toBe(2);
    expect(
      [ca.generateCode, cb.generateCode].reduce((n, fn) => n + vi.mocked(fn).mock.calls.length, 0),
    ).toBe(3);
  });
  it('bounds real unique failures with savepoints, leaves the outer transaction usable, and retains CLOSED history across reuse', async () => {
    const a = await seed(upgraded.db),
      b = await seed(upgraded.db);
    const crypto = new InviteCodeCrypto(keys);
    vi.spyOn(crypto, 'generateCode').mockReturnValue('000000');
    const service = new InviteCodeReservations(crypto);
    const original = await upgraded.db.transaction((tx) =>
      service.allocate(tx, allocationInput(a)),
    );
    await upgraded.db.transaction(async (tx) => {
      await expect(service.allocate(tx, allocationInput(b))).rejects.toThrow(
        'COLLISIONS_EXHAUSTED',
      );
      expect((await tx.execute(sql`select 1 as alive`)).rows[0]).toMatchObject({ alive: 1 });
    });
    await upgraded.db.execute(
      sql`update room_invite_codes set reservation_state='CLOSED',released_at=clock_timestamp(),release_reason='ROTATE' where id=${original.id}`,
    );
    const reused = await upgraded.db.transaction((tx) => service.allocate(tx, allocationInput(b)));
    expect(reused.code).toBe('000000');
    expect(reused.id).not.toBe(original.id);
    expect(
      (
        await upgraded.db.execute(
          sql`select id from room_invite_codes where id=${original.id} and reservation_state='CLOSED'`,
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      upgraded.db.execute(
        sql`update room_invite_codes set reservation_state='OPEN',released_at=null,release_reason=null where id=${original.id}`,
      ),
    ).rejects.toThrow();
  });
  it('returns the committed alias in same-user races and retries alias namespace collisions', async () => {
    const a = await seed(upgraded.db),
      b = await seed(upgraded.db);
    const crypto = new InviteCodeCrypto(keys);
    const service = new InviteCodeReservations(crypto);
    const aliases = await Promise.all(
      [1, 2].map(() => upgraded.db.transaction((tx) => service.allocateHostAlias(tx, a.userId))),
    );
    expect(aliases[0]).toBe(aliases[1]);
    const spy = vi
      .spyOn(crypto, 'generateHostShareId')
      .mockReturnValueOnce(aliases[0]!)
      .mockReturnValue(randomBytes(16).toString('base64url'));
    const second = await upgraded.db.transaction((tx) => service.allocateHostAlias(tx, b.userId));
    expect(second).not.toBe(aliases[0]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('requires validated schema, exact unique index semantics and enabled durable-fence triggers', async () => {
    await upgraded.db
      .transaction(async (tx) => {
        await tx.execute(sql`drop index users_host_share_id_unique`);
        await tx.execute(sql`create index users_host_share_id_unique on users(host_share_id)`);
        await expect(assertInviteFoundationReady(tx, metrics)).rejects.toThrow('SCHEMA_NOT_READY');
        tx.rollback();
      })
      .catch((error: Error) => {
        if (error.message !== 'Rollback') throw error;
      });
    await assertInviteFoundationReady(upgraded.db, metrics);
    await upgraded.db
      .transaction(async (tx) => {
        await tx.execute(sql`alter table rooms disable trigger rooms_invitation_fence_monotonic`);
        await expect(assertInviteFoundationReady(tx, metrics)).rejects.toThrow('SCHEMA_NOT_READY');
        tx.rollback();
      })
      .catch((error: Error) => {
        if (error.message !== 'Rollback') throw error;
      });
  });
  it('keeps epoch/suppression/backfill markers monotonic and refuses automatic resurrection', async () => {
    const a = await seed(upgraded.db);
    const service = new InviteCodeReservations(new InviteCodeCrypto(keys));
    await upgraded.db.execute(
      sql`update rooms set invitation_epoch=1,automatic_invites_suppressed=true,legacy_invites_revoked_at=now() where id=${a.roomId}`,
    );
    await expect(
      upgraded.db.execute(sql`update rooms set invitation_epoch=0 where id=${a.roomId}`),
    ).rejects.toThrow();
    await expect(
      upgraded.db.execute(
        sql`update rooms set automatic_invites_suppressed=false where id=${a.roomId}`,
      ),
    ).rejects.toThrow();
    await expect(
      upgraded.db.execute(
        sql`update rooms set legacy_invites_revoked_at=null where id=${a.roomId}`,
      ),
    ).rejects.toThrow();
    await expect(
      upgraded.db.transaction((tx) => service.allocate(tx, allocationInput(a))),
    ).rejects.toThrow('INVITATION_STATE_CHANGED');
    await expect(
      upgraded.db.transaction((tx) =>
        service.allocate(tx, {
          ...allocationInput(a),
          expectedInvitationEpoch: 1n,
          automatic: true,
          reissueAfterRevocation: true,
        }),
      ),
    ).rejects.toThrow('AUTOMATIC_ISSUANCE_SUPPRESSED');
    const explicit = await upgraded.db.transaction((tx) =>
      service.allocate(tx, {
        ...allocationInput(a),
        expectedInvitationEpoch: 1n,
        reissueAfterRevocation: true,
      }),
    );
    expect(explicit.invitationEpoch).toBe(1n);
    expect(
      (
        await upgraded.db.execute(
          sql`select automatic_invites_suppressed from rooms where id=${a.roomId}`,
        )
      ).rows[0],
    ).toMatchObject({ automatic_invites_suppressed: true });
  });
  it('rolls back the additive expansion only before any durable state, otherwise refuses the down path', async () => {
    // PostgreSQL sends a failed explicit transaction back in aborted state; ROLLBACK before releasing client.
    await rollbackDb.pool.query(down);
    expect(
      (await rollbackDb.db.execute(sql`select to_regclass('room_invite_codes') as table_name`))
        .rows[0],
    ).toMatchObject({ table_name: null });
    const client = await upgraded.pool.connect();
    try {
      await expect(client.query(down)).rejects.toThrow('durable state');
      await client.query('rollback');
    } finally {
      client.release();
    }
    await assertInviteFoundationReady(upgraded.db, metrics);
  });
});
