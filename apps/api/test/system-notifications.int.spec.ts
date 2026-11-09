import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { cmsAccessHeaders } from './support/cms-access';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: NestFastifyApplication;
let snapshot: string;
const api = () => app.getHttpAdapter().getInstance();
const PUBLIC = '/v1/system-notifications';
const CMS = '/v1/cms/system-notifications';
const actors: Record<string, { id: string; token: string }> = {};
const copy = { kind: 'maintenance', title: 'Bảo trì', body: 'Thông báo do quản trị viên soạn.' };
let ipc = 0;
const ip = () => `10.81.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
function auth(role = 'ops_admin') {
  return { authorization: `Bearer ${actors[role]!.token}` };
}
const get = (url = PUBLIC, headers = {}) =>
  api().inject({ method: 'GET', url, headers, remoteAddress: ip() });
function write(
  method: 'POST' | 'PATCH',
  url: string,
  payload?: object,
  role = 'ops_admin',
  headers = {},
) {
  return api().inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { ...auth(role), ...headers },
    ...(payload ? { payload } : {}),
  });
}
async function create(payload: object = copy, role = 'ops_admin', key = randomUUID()) {
  const res = await write('POST', CMS, payload, role, { 'idempotency-key': key });
  expect(res.statusCode).toBe(201);
  return res.json();
}
async function seed(
  input: {
    status?: string;
    publishedAt?: string | null;
    expiresAt?: string | null;
    kind?: string;
  } = {},
) {
  const { rows } = await pool.query(
    `insert into system_announcements
    (kind,title,body,status,published_at,expires_at,created_by,updated_by)
    values ($1,'T','B',$2,$3,$4,$5,$5) returning id`,
    [
      input.kind ?? 'general',
      input.status ?? 'published',
      input.publishedAt === undefined ? '2026-01-01T10:00:00.123456Z' : input.publishedAt,
      input.expiresAt ?? null,
      actors.ops_admin!.id,
    ],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('system_notifications')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  const db = drizzle(pool, { schema });
  const migrations = path.resolve(__dirname, '../../../migrations');
  snapshot = await mkdtemp(path.join(tmpdir(), 'gogo-before-announcements-'));
  await cp(migrations, snapshot, { recursive: true });
  const journalFile = path.join(snapshot, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  await writeFile(
    journalFile,
    JSON.stringify({
      ...journal,
      entries: journal.entries.filter((e: { idx: number }) => e.idx < 93),
    }),
  );
  await migrate(db, { migrationsFolder: snapshot });
  // Existing staff data survives upgrading the actual 0092 snapshot to 0093.
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
    const [row] = await db
      .insert(schema.adminUsers)
      .values({ email: `system-${role}@gogo.test`, displayName: role, role, passwordHash })
      .returning();
    actors[role] = { id: row!.id, token: '' };
  }
  await migrate(db, { migrationsFolder: migrations });
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.TRUST_PROXY = 'false';
  process.env.CMS_PASSWORD_LOGIN_ENABLED = 'true';
  process.env.CMS_SUPER_ADMIN_SSO_ONLY = 'false';
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.AUTH_JWT_SECRET = 'system-notifications-integration-secret'.padEnd(48, 'x');
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  for (const role of Object.keys(actors)) {
    const email = `system-${role}@gogo.test`;
    const login = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      headers: cmsAccessHeaders(email),
      payload: { email, password: 'admin-password-123' },
    });
    expect(login.statusCode).toBe(201);
    actors[role]!.token = login.json().accessToken;
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
  if (snapshot) await rm(snapshot, { recursive: true, force: true });
});
beforeEach(async () => {
  await pool.query('delete from system_announcements');
  await pool.query("delete from audit_logs where resource_type = 'system_announcement'");
  await pool.query("delete from idempotency_keys where endpoint like '%cms/system-notifications%'");
});

describe.sequential('public system notifications (#815)', () => {
  it('is anonymous, filters drafts, archives, future publications and expired rows, and exposes facts only', async () => {
    const visible = await seed({ kind: 'future_kind' });
    await seed({ status: 'draft', publishedAt: null });
    await seed({ status: 'archived' });
    await seed({ expiresAt: '2026-01-02T00:00:00Z' });
    await seed({ publishedAt: '2099-01-01T00:00:00Z' });
    const expiring = await seed({ expiresAt: '2099-01-01T00:00:00Z' });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(
      res
        .json()
        .items.map((r: { id: string }) => r.id)
        .sort(),
    ).toEqual([visible, expiring].sort());
    expect(Object.keys(res.json().items[0]).sort()).toEqual(
      ['id', 'kind', 'title', 'body', 'deepLink', 'publishedAt', 'expiresAt'].sort(),
    );
    // Public responses are independent of stale/invalid account credentials.
    const signed = await get(PUBLIC, auth());
    expect(signed.body).toBe(res.body);
    expect((await get(PUBLIC, { authorization: 'Bearer expired' })).body).toBe(res.body);
  });

  it('paginates equal timestamps and sub-millisecond boundaries without skips or repeats', async () => {
    const ids = [];
    for (const fraction of ['123456', '123456', '123455', '123001', '122999'])
      ids.push(await seed({ publishedAt: `2026-01-01T10:00:00.${fraction}Z` }));
    const expected = (
      await pool.query('select id from system_announcements order by published_at desc,id desc')
    ).rows.map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(`${PUBLIC}?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((r: { id: string }) => r.id));
      cursor = res.json().nextCursor;
      if (seen.length === 2) await seed({ publishedAt: '2026-02-01T00:00:00Z' });
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(ids.length);
    expect((await get(`${PUBLIC}?cursor=invalid`)).statusCode).toBe(400);
    expect((await get(`${PUBLIC}?limit=101`)).statusCode).toBe(400);
  });

  it('honors ETag lists, weak tags and wildcard; changes tags after edit, publish, archive and expiry', async () => {
    const draft = await create();
    const empty = await get();
    await write('POST', `${CMS}/${draft.id}/publish`);
    const live = await get(PUBLIC, { 'if-none-match': empty.headers.etag as string });
    expect(live.statusCode).toBe(200);
    for (const condition of [live.headers.etag, `"other", W/${live.headers.etag}`, '*']) {
      const fresh = await get(PUBLIC, { 'if-none-match': condition as string });
      expect(fresh.statusCode).toBe(304);
      expect(fresh.body).toBe('');
      expect(fresh.headers.etag).toBe(live.headers.etag);
      expect(fresh.headers['cache-control']).toBe('public, max-age=60');
    }
    expect(
      (await write('PATCH', `${CMS}/${draft.id}`, { body: 'Nội dung đã sửa' })).statusCode,
    ).toBe(200);
    const edited = await get(PUBLIC, { 'if-none-match': live.headers.etag as string });
    expect(edited.statusCode).toBe(200);
    expect(edited.headers.etag).not.toBe(live.headers.etag);
    await write('POST', `${CMS}/${draft.id}/archive`);
    const archived = await get(PUBLIC, { 'if-none-match': edited.headers.etag as string });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().items).toEqual([]);
    const id = await seed();
    const before = await get();
    await pool.query(
      "update system_announcements set expires_at = '2026-01-02T00:00:00Z' where id=$1",
      [id],
    );
    const expired = await get(PUBLIC, { 'if-none-match': before.headers.etag as string });
    expect(expired.statusCode).toBe(200);
    expect(expired.json().items).toEqual([]);
  });

  it('enforces the per-IP 60/min action limit even for conditional requests and spoofed forwarding headers', async () => {
    const remoteAddress = '10.81.250.1';
    const first = await api().inject({ method: 'GET', url: PUBLIC, remoteAddress });
    for (let i = 1; i < 60; i++) {
      const res = await api().inject({
        method: 'GET',
        url: PUBLIC,
        remoteAddress,
        headers: {
          'if-none-match': first.headers.etag as string,
          'x-forwarded-for': `192.0.2.${i}`,
        },
      });
      expect(res.statusCode).toBe(304);
    }
    const limited = await api().inject({ method: 'GET', url: PUBLIC, remoteAddress });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['cache-control']).not.toBe('public, max-age=60');
    expect((await get()).statusCode).toBe(200);
  });
});

describe.sequential('CMS announcement lifecycle and audit', () => {
  it.each(['editor', 'moderator'])(
    'denies every CMS operation to %s before mutation',
    async (role) => {
      const id = await seed();
      expect((await get(CMS, auth(role))).statusCode).toBe(403);
      for (const [method, url, payload] of [
        ['POST', CMS, copy],
        ['PATCH', `${CMS}/${id}`, { title: 'Denied' }],
        ['POST', `${CMS}/${id}/publish`, undefined],
        ['POST', `${CMS}/${id}/archive`, undefined],
      ] as const)
        expect(
          (await write(method, url, payload, role, { 'idempotency-key': randomUUID() })).statusCode,
        ).toBe(403);
      expect(
        (await pool.query("select * from audit_logs where resource_type='system_announcement'"))
          .rowCount,
      ).toBe(0);
      expect((await get(CMS)).statusCode).toBe(401);
    },
  );

  it.each(['ops_admin', 'super_admin'])(
    'allows %s and atomically records create/edit/publish/archive without inbox duplication',
    async (role) => {
      const personalBefore = (await pool.query('select count(*) from notifications')).rows[0].count;
      const draft = await create(copy, role);
      expect(draft).toMatchObject({
        status: 'draft',
        publishedAt: null,
        locale: 'vi',
        createdBy: actors[role]!.id,
      });
      const updated = await write(
        'PATCH',
        `${CMS}/${draft.id}`,
        { deepLink: 'gogo://notifications', body: 'Bản mới' },
        role,
      );
      expect(updated.statusCode).toBe(200);
      const published = await write('POST', `${CMS}/${draft.id}/publish`, undefined, role);
      expect(published.statusCode).toBe(200);
      expect(published.json().publishedAt).toBeTruthy();
      const repeated = await write('POST', `${CMS}/${draft.id}/publish`, undefined, role);
      expect(repeated.json().publishedAt).toBe(published.json().publishedAt);
      expect((await get()).json().items).toHaveLength(1);
      expect((await write('POST', `${CMS}/${draft.id}/archive`, undefined, role)).statusCode).toBe(
        200,
      );
      expect((await write('POST', `${CMS}/${draft.id}/archive`, undefined, role)).statusCode).toBe(
        200,
      );
      expect((await get()).json().items).toEqual([]);
      expect((await write('POST', `${CMS}/${draft.id}/publish`, undefined, role)).statusCode).toBe(
        409,
      );
      expect(
        (await write('PATCH', `${CMS}/${draft.id}`, { title: 'Changed' }, role)).statusCode,
      ).toBe(409);
      const listed = await get(`${CMS}?status=archived&limit=1`, auth(role));
      expect(listed.json().items[0]).toMatchObject({
        id: draft.id,
        status: 'archived',
        updatedBy: actors[role]!.id,
      });
      expect(listed.headers['cache-control']).toBe('private, no-store');
      const audit = await pool.query(
        "select * from audit_logs where resource_type='system_announcement' order by created_at,id",
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'system_announcement.created',
        'system_announcement.updated',
        'system_announcement.published',
        'system_announcement.archived',
      ]);
      expect(
        audit.rows.every((r) => r.actor_id === actors[role]!.id && r.resource_id === draft.id),
      ).toBe(true);
      expect(audit.rows[1].diff).toMatchObject({
        before: { body: copy.body },
        after: { body: 'Bản mới' },
      });
      expect(audit.rows.every((r) => r.request_id)).toBe(true);
      expect((await pool.query('select count(*) from notifications')).rows[0].count).toBe(
        personalBefore,
      );
    },
  );

  it('requires create idempotency, replays original response after edits and rejects a different body', async () => {
    expect((await write('POST', CMS, copy)).statusCode).toBe(400);
    const key = randomUUID();
    const [first, replay] = await Promise.all([
      create(copy, 'ops_admin', key),
      create(copy, 'ops_admin', key),
    ]);
    expect(replay).toEqual(first);
    await write('PATCH', `${CMS}/${first.id}`, { title: 'Edited' });
    expect(await create(copy, 'ops_admin', key)).toEqual(first);
    expect(
      (
        await write('POST', CMS, { ...copy, title: 'Different' }, 'ops_admin', {
          'idempotency-key': key,
        })
      ).statusCode,
    ).toBe(422);
    expect((await pool.query('select count(*)::int n from system_announcements')).rows[0].n).toBe(
      1,
    );
    expect(
      (
        await pool.query(
          "select count(*)::int n from audit_logs where action='system_announcement.created'",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('rolls back creation and idempotency when audit insertion fails, then permits a retry', async () => {
    await pool.query(`create function fail_announcement_audit() returns trigger language plpgsql as $$
      begin if NEW.resource_type = 'system_announcement' then raise exception 'audit unavailable'; end if; return NEW; end $$`);
    await pool.query(
      'create trigger fail_announcement_audit before insert on audit_logs for each row execute function fail_announcement_audit()',
    );
    const key = randomUUID();
    try {
      expect(
        (await write('POST', CMS, copy, 'ops_admin', { 'idempotency-key': key })).statusCode,
      ).toBe(500);
      expect((await pool.query('select * from system_announcements')).rowCount).toBe(0);
      expect(
        (
          await pool.query(
            "select * from idempotency_keys where endpoint like '%cms/system-notifications%'",
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await pool.query('drop trigger fail_announcement_audit on audit_logs');
      await pool.query('drop function fail_announcement_audit()');
    }
    await create(copy, 'ops_admin', key);
  });

  it('serializes concurrent publication and validates expiry, immutable fields, destinations and missing IDs', async () => {
    const draft = await create();
    const responses = await Promise.all([
      write('POST', `${CMS}/${draft.id}/publish`),
      write('POST', `${CMS}/${draft.id}/publish`),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(responses[0].json().publishedAt).toBe(responses[1].json().publishedAt);
    expect(
      (await pool.query("select * from audit_logs where action='system_announcement.published'"))
        .rowCount,
    ).toBe(1);
    const expired = await create({ ...copy, expiresAt: '2026-01-01T00:00:00Z' });
    expect((await write('POST', `${CMS}/${expired.id}/publish`)).statusCode).toBe(400);
    expect(
      (await write('PATCH', `${CMS}/${draft.id}`, { expiresAt: '2026-01-01T00:00:00Z' }))
        .statusCode,
    ).toBe(400);
    for (const payload of [
      { status: 'published' },
      { deepLink: 'https://example.com' },
      {},
      { locale: 'en' },
    ])
      expect((await write('PATCH', `${CMS}/${draft.id}`, payload)).statusCode).toBe(400);
    expect(
      (
        await write(
          'PATCH',
          `${CMS}/${draft.id}`,
          { expiresAt: null, deepLink: null },
          'super_admin',
        )
      ).statusCode,
    ).toBe(200);
    expect((await write('PATCH', `${CMS}/${randomUUID()}`, { title: 'Missing' })).statusCode).toBe(
      404,
    );
    expect((await write('POST', `${CMS}/${randomUUID()}/archive`)).statusCode).toBe(404);
  });

  it('pages the CMS list independently using creation tuples and a status filter', async () => {
    const first = await create();
    const second = await create();
    const page = await get(`${CMS}?limit=1&status=draft`, auth());
    expect(page.json().items[0].id).toBe(second.id);
    const next = await get(`${CMS}?limit=1&status=draft&cursor=${page.json().nextCursor}`, auth());
    expect(next.json().items[0].id).toBe(first.id);
    expect(next.json().nextCursor).toBeNull();
    expect((await get(`${PUBLIC}?cursor=${page.json().nextCursor}`)).statusCode).toBe(400);
  });
});
