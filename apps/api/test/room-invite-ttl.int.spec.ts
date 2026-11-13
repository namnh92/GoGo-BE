import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, schema } from '@gogo/database';
import { NoopMetrics } from '@gogo/observability';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureHostAuthority, hostedRoom } from './support/hosted-room';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import { InviteCodeReservations } from '../../../libs/modules/rooms/infrastructure/invite-code-reservations';
import { InviteCodeCrypto } from '../../../libs/modules/rooms/application/invite-code-crypto';
import { observeInviteIssuance } from '../../../libs/modules/shared/invite-ttl';

const root = path.resolve(__dirname, '../../..');
const folder = path.join(root, 'migrations');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const metrics = new NoopMetrics();
const emit = vi.spyOn(metrics, 'increment');
const secret = () => randomBytes(32).toString('hex');
const allocator = new InviteCodeReservations(
  new InviteCodeCrypto({
    lookupKey: secret(),
    replayKey: secret(),
    bucketKey: secret(),
    activeEncryptionVersion: 'v1',
    encryptionKeys: { v1: secret() },
  }),
  metrics,
);
let container: StartedPostgreSqlContainer;
let instance: ReturnType<typeof createDb>;
let fresh: ReturnType<typeof createDb>;
let baseline: string;
let oldExpiry: unknown;
let legacyRoomId: string;
const db = () => instance.db;
const repo = () => new RoomsRepository(db(), metrics);
async function fixture(expiresAt: Date | null = null) {
  const [user] = await db().insert(schema.users).values({ displayName: 'TTL host' }).returning();
  const [room] = await hostedRoom(db(), {
    code: randomUUID(),
    hostUserId: user!.id,
    type: 'group',
    decisionMode: 'host',
    status: 'collecting',
    expiresAt,
  });
  const authority = await fixtureHostAuthority(db(), room.id);
  return {
    room,
    authority,
    input: { roomId: room.id, createdByMemberId: authority.memberId, codeHash: secret() },
  };
}
async function issue(f: Awaited<ReturnType<typeof fixture>>) {
  return repo().createInvite({ ...f.input, codeHash: secret() }, f.authority);
}
async function code(f: Awaited<ReturnType<typeof fixture>>) {
  return observeInviteIssuance(metrics, 'code6', () =>
    db().transaction(
      (tx) =>
        allocator.allocate(tx, {
          roomId: f.room.id,
          actorUserId: f.authority.actor.id,
          expectedInvitationEpoch: 0n,
        }),
      { isolationLevel: 'read committed' },
    ),
  );
}
async function setTtl(ttl: number) {
  await db()
    .update(schema.roomInviteSettings)
    .set({ ttlSeconds: ttl })
    .where(eq(schema.roomInviteSettings.id, 1));
}
async function oldRows() {
  return (
    await instance.pool.query(
      `select i.expires_at::text as token_expiry,
    s.expires_at::text as share_expiry,c.expires_at::text as code_expiry
    from room_invites i join share_links s on s.invite_id=i.id
    join room_invite_codes c on c.room_id=i.room_id where i.room_id=$1`,
      [legacyRoomId],
    )
  ).rows;
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
async function waitForBlocked(pid: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await instance.pool.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [
      pid,
    ]);
    if (r.rows[0].blocked) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('expected a database lock wait');
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  instance = createDb(container.getConnectionUri(), { max: 8 });
  baseline = mkdtempSync(path.join(tmpdir(), 'be906-0105-'));
  mkdirSync(path.join(baseline, 'meta'));
  const journal = JSON.parse(read('migrations/meta/_journal.json'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 105);
  for (const e of journal.entries)
    copyFileSync(path.join(folder, `${e.tag}.sql`), path.join(baseline, `${e.tag}.sql`));
  writeFileSync(path.join(baseline, 'meta/_journal.json'), JSON.stringify(journal));
  await migrate(db(), { migrationsFolder: baseline });
  const f = await fixture();
  legacyRoomId = f.room.id;
  await db().transaction(async (tx) => {
    const [invite] = await tx
      .insert(schema.roomInvites)
      .values({
        ...f.input,
        expiresAt: new Date('2026-11-12T01:02:03.456Z'),
        revokedAt: new Date('2026-11-11T00:00:00Z'),
      })
      .returning();
    await tx.insert(schema.shareLinks).values({
      slugHash: secret(),
      type: 'ROOM_INVITE',
      targetId: f.room.id,
      inviteId: invite!.id,
      createdByUserId: f.authority.actor.id,
      expiresAt: invite!.expiresAt,
    });
    await tx.insert(schema.roomInviteCodes).values({
      roomId: f.room.id,
      invitationEpoch: 0n,
      codeLookup: secret(),
      codeCiphertext: randomBytes(34).toString('base64url'),
      encryptionKeyVersion: 'v1',
      issuedAt: new Date('2026-11-11T00:00:00Z'),
      expiresAt: new Date('2026-11-13T00:00:00Z'),
      createdByMemberId: f.authority.memberId,
    });
  });
  oldExpiry = await oldRows();
  await migrate(db(), { migrationsFolder: folder });
  const ops = read('scripts/ops/prepare-invite-foundation.sql');
  for (const statement of ops
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await instance.pool.query(statement);
  await instance.pool.query('create database invite_ttl_fresh');
  fresh = createDb(container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/invite_ttl_fresh$1'), {
    max: 2,
  });
  await migrate(fresh.db, { migrationsFolder: folder });
}, 240000);
afterAll(async () => {
  await instance?.pool.end();
  await fresh?.pool.end();
  await container?.stop();
  if (baseline) rmSync(baseline, { recursive: true, force: true });
});

describe('#906 BE-A data and issuance', () => {
  it('converges fresh/0105 upgrade, seeds once with initialization audit, preserves every old expiry', async () => {
    expect(await oldRows()).toEqual(oldExpiry);
    for (const source of [db(), fresh.db]) {
      expect((await source.select().from(schema.roomInviteSettings))[0]).toMatchObject({
        id: 1,
        ttlSeconds: 86400,
        version: 1n,
        updatedByAdminId: null,
      });
      const audit = await source
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'room_invite_ttl.initialized'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: 'system',
        actorId: null,
        resourceType: 'room_invite_ttl',
        resourceId: 'global',
        diff: { after: { ttlSeconds: 86400, version: '1' } },
      });
      expect(audit[0]!.createdAt).toEqual(
        (await source.select().from(schema.roomInviteSettings))[0]!.updatedAt,
      );
    }
    await db()
      .transaction(async (tx) => {
        await tx.execute(sql`update room_invite_settings set ttl_seconds=300,version=2`);
        const seed = read('migrations/0107_room-invite-settings.sql').slice(
          read('migrations/0107_room-invite-settings.sql').indexOf('WITH seeded'),
        );
        await tx.execute(sql.raw(seed));
        await tx.execute(sql.raw(seed));
        expect((await tx.select().from(schema.roomInviteSettings))[0]!.ttlSeconds).toBe(300);
        expect(
          await tx
            .select()
            .from(schema.auditLogs)
            .where(eq(schema.auditLogs.action, 'room_invite_ttl.initialized')),
        ).toHaveLength(1);
        tx.rollback();
      })
      .catch((e) => {
        if (e.message !== 'Rollback') throw e;
      });
  });
  it('enforces singleton, integer bounds, positive revision, and historical admin without an FK', async () => {
    for (const statement of [
      'insert into room_invite_settings(id) values(2)',
      'update room_invite_settings set ttl_seconds=0',
      'update room_invite_settings set ttl_seconds=-1',
      'update room_invite_settings set ttl_seconds=2147483648',
      'update room_invite_settings set version=0',
    ])
      await expect(instance.pool.query(statement)).rejects.toBeDefined();
    await db()
      .transaction(async (tx) => {
        await tx.execute(
          sql`update room_invite_settings set ttl_seconds=2147483647,updated_by_admin_id=${randomUUID()}`,
        );
        tx.rollback();
      })
      .catch((e) => {
        if (e.message !== 'Rollback') throw e;
      });
  });
  it('observes default +24h, new +5min after update, old unchanged, and TOKEN128 has no 48h/room cap', async () => {
    const f = await fixture(new Date(Date.now() + 60000));
    const old = await issue(f);
    expect(old.expiresAt.getTime() - old.createdAt.getTime()).toBe(86400000);
    try {
      for (const ttl of [300, 2147483647]) {
        await setTtl(ttl);
        const next = await issue(f);
        expect(next.expiresAt.getTime() - next.createdAt.getTime()).toBe(ttl * 1000);
      }
      expect((await repo().listInvites(f.room.id)).find((i) => i.id === old.id)!.expiresAt).toEqual(
        old.expiresAt,
      );
      expect(await oldRows()).toEqual(oldExpiry);
    } finally {
      await setTtl(86400);
    }
  });
  it.each([
    [300, null, 300],
    [172801, null, 172800],
    [2147483647, null, 172800],
    [86400, 60, 60],
  ])(
    'CODE6 ttl=%i room remaining=%s keeps independent caps',
    async (ttl, roomSeconds, expectedSeconds) => {
      const expiry = roomSeconds === null ? null : new Date(Date.now() + roomSeconds * 1000);
      const f = await fixture(expiry);
      try {
        await setTtl(ttl);
        const result = await code(f);
        if (expiry) expect(result.expiresAt).toEqual(expiry);
        else
          expect(result.expiresAt.getTime() - result.issuedAt.getTime()).toBe(
            expectedSeconds * 1000,
          );
      } finally {
        await setTtl(86400);
      }
    },
  );
  it('rejects CODE6 in an expired room and does not revive revoked or expired old credentials', async () => {
    const f = await fixture(new Date(0));
    await expect(code(f)).rejects.toThrow('ROOM_NOT_ELIGIBLE');
    await setTtl(2147483647);
    try {
      expect(await oldRows()).toEqual(oldExpiry);
    } finally {
      await setTtl(86400);
    }
  });
  it('retains the database 48h CHECK even when the configured TTL is larger', async () => {
    const f = await fixture();
    await expect(
      db()
        .insert(schema.roomInviteCodes)
        .values({
          roomId: f.room.id,
          invitationEpoch: 0n,
          codeLookup: secret(),
          codeCiphertext: randomBytes(34).toString('base64url'),
          encryptionKeyVersion: 'v1',
          issuedAt: new Date('2026-11-13T00:00:00Z'),
          expiresAt: new Date('2026-11-15T00:00:01Z'),
          createdByMemberId: f.authority.memberId,
        }),
    ).rejects.toMatchObject({ cause: { constraint: 'room_invite_codes_lifetime' } });
  });
  it.each(['missing', 'invalid'])(
    '%s setting returns non-retryable 503, rolls back token/code writes',
    async (reason) => {
      const f = await fixture();
      for (const kind of ['token', 'code6'] as const) {
        await expect(
          observeInviteIssuance(metrics, kind, () =>
            db().transaction(async (tx) => {
              if (reason === 'missing') await tx.execute(sql`delete from room_invite_settings`);
              else {
                await tx.execute(
                  sql`alter table room_invite_settings drop constraint room_invite_settings_ttl_positive`,
                );
                await tx.execute(sql`update room_invite_settings set ttl_seconds=0`);
              }
              return kind === 'token'
                ? repo().createInvite(f.input, f.authority, tx)
                : allocator.allocate(tx, {
                    roomId: f.room.id,
                    actorUserId: f.authority.actor.id,
                    expectedInvitationEpoch: 0n,
                  });
            }),
          ),
        ).rejects.toMatchObject({
          code: 'INVITE_TTL_SETTING_UNAVAILABLE',
          httpStatus: 503,
          options: { retryable: false },
        });
      }
      expect(await repo().listInvites(f.room.id)).toHaveLength(0);
      expect(
        await db()
          .select()
          .from(schema.roomInviteCodes)
          .where(eq(schema.roomInviteCodes.roomId, f.room.id)),
      ).toHaveLength(0);
    },
  );
  it('turns a setting lock timeout into retryable 503 without a partial grant', async () => {
    const f = await fixture();
    const blocker = await instance.pool.connect();
    await blocker.query('begin');
    await blocker.query('select id from room_invite_settings where id=1 for update');
    emit.mockClear();
    try {
      await expect(
        observeInviteIssuance(metrics, 'token', () =>
          db().transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout='100ms'`);
            return repo().createInvite(f.input, f.authority, tx);
          }),
        ),
      ).rejects.toMatchObject({
        code: 'INVITE_TTL_SETTING_UNAVAILABLE',
        options: { retryable: true },
      });
      expect(await repo().listInvites(f.room.id)).toHaveLength(0);
      expect(emit).toHaveBeenCalledWith('room_invite_issue_total', {
        kind: 'token',
        result: 'rolled_back',
      });
      expect(emit).not.toHaveBeenCalledWith('room_invite_issue_total', {
        kind: 'token',
        result: 'committed',
      });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
  it('issuer SHARE blocks a concurrent TTL UPDATE until issuance commits', async () => {
    const f = await fixture();
    const held = barrier(),
      release = barrier();
    const issuing = db().transaction(async (tx) => {
      const row = await repo().createInvite(f.input, f.authority, tx);
      held.release();
      await release.promise;
      return row;
    });
    await held.promise;
    const writer = await instance.pool.connect();
    const pid = (await writer.query('select pg_backend_pid() as pid')).rows[0].pid;
    const updating = writer.query('update room_invite_settings set ttl_seconds=300 where id=1');
    try {
      await waitForBlocked(pid);
      release.release();
      const row = await issuing;
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(86400000);
      await updating;
      const next = await issue(f);
      expect(next.expiresAt.getTime() - next.createdAt.getTime()).toBe(300000);
    } finally {
      release.release();
      await issuing;
      await updating;
      writer.release();
      await setTtl(86400);
    }
  });
  it.each(['setting', 'room'])(
    'issuer waiting for %s lock reads the new TTL and takes its clock after the wait',
    async (lock) => {
      const f = await fixture();
      const writer = await instance.pool.connect();
      await writer.query('begin');
      if (lock === 'room')
        await writer.query('select id from rooms where id=$1 for update', [f.room.id]);
      await writer.query('update room_invite_settings set ttl_seconds=300 where id=1');
      const started = barrier();
      let pid!: number;
      const issuing = db().transaction(async (tx) => {
        pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
        started.release();
        return repo().createInvite(f.input, f.authority, tx);
      });
      try {
        await started.promise;
        await waitForBlocked(pid);
        const boundary = new Date(
          (await writer.query('select clock_timestamp() as now')).rows[0].now,
        );
        await writer.query('commit');
        const row = await issuing;
        expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(boundary.getTime());
        expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(300000);
      } finally {
        await writer.query('rollback');
        writer.release();
        await issuing;
        await setTtl(86400);
      }
    },
  );
  it('reauthorizes state and host version before reading the setting', async () => {
    const f = await fixture();
    await db()
      .update(schema.rooms)
      .set({ status: 'cancelled' })
      .where(eq(schema.rooms.id, f.room.id));
    emit.mockClear();
    await expect(issue(f)).rejects.toMatchObject({ code: 'ROOM_NOT_JOINABLE' });
    expect(emit).not.toHaveBeenCalledWith('room_invite_ttl_read_total', expect.anything());
    await db()
      .update(schema.rooms)
      .set({ status: 'collecting', hostVersion: 2 })
      .where(eq(schema.rooms.id, f.room.id));
    await expect(issue(f)).rejects.toMatchObject({ code: 'HOST_VERSION_CONFLICT' });
  });
  it('rehearses guarded down only before activation, preserving initialization audit and journal', async () => {
    const down = read('scripts/rollback/0107-room-invite-settings.sql');
    const connection = await fresh.pool.connect();
    try {
      await connection.query('update room_invite_settings set version=2');
      await expect(connection.query(down)).rejects.toThrow('roll forward');
      await connection.query('rollback');
      await connection.query('update room_invite_settings set version=1');
      const journal = (
        await connection.query('select * from drizzle.__drizzle_migrations order by id')
      ).rows;
      await connection.query(down);
      expect(
        (
          await connection.query(
            "select * from audit_logs where action='room_invite_ttl.initialized'",
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (await connection.query('select * from drizzle.__drizzle_migrations order by id')).rows,
      ).toEqual(journal);
    } finally {
      await connection.query('rollback');
      connection.release();
    }
  });
});
