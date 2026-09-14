import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { OutboxDispatcher, audiencePredicate, respectsPushPreference } from '@gogo/modules';
import { FakePush } from '@gogo/providers';

/**
 * NTF-BE-014 (#572), ADR-0025 — one application-level push switch.
 *
 * The database is first migrated to just before 0064 and seeded with per-kind
 * choices as older clients left them, so the backfill is exercised on real
 * rows rather than on an empty table.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let snapshot: string;
const legacy: Record<string, string> = {};

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.64.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(label: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: {
      email: `${label}-${Date.now()}@gogo.id.vn`,
      password: 'sufficiently-long-pw',
      displayName: label,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.accessToken as string, userId: body.userId as string };
}

const getSettings = (token: string) =>
  api().inject({ method: 'GET', url: '/v1/me/notification-settings', headers: auth(token) });
const putSettings = (token: string, payload: unknown) =>
  api().inject({
    method: 'PUT',
    url: '/v1/me/notification-settings',
    remoteAddress: ip(),
    headers: auth(token),
    payload: payload as Record<string, unknown>,
  });
const legacyGet = (token: string) =>
  api().inject({ method: 'GET', url: '/v1/me/notification-preferences', headers: auth(token) });
const legacyPut = (token: string, payload: { channel: string; kind: string; enabled: boolean }) =>
  api().inject({
    method: 'PUT',
    url: '/v1/me/notification-preferences',
    remoteAddress: ip(),
    headers: auth(token),
    payload,
  });

async function storedSettings(userId: string) {
  const { rows } = await pool.query(
    'select push_enabled, source from notification_settings where user_id = $1',
    [userId],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_notification_settings')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });

  // Everything before 0064 in journal order. Dropping only 0064 would apply
  // later migrations (0065, 0066, ...) first, and Drizzle would then skip 0064:
  // it applies only journal entries newer than the last one applied.
  const migrations = path.resolve(__dirname, '../../../migrations');
  snapshot = await mkdtemp(path.join(tmpdir(), 'gogo-before-0064-'));
  await cp(migrations, snapshot, { recursive: true });
  const journalPath = path.join(snapshot, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const at = journal.entries.findIndex(
    (entry: { tag: string }) => entry.tag === '0064_notification-master-switch',
  );
  if (at < 0) throw new Error('0064_notification-master-switch is missing from the journal');
  journal.entries = journal.entries.slice(0, at);
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(db, { migrationsFolder: snapshot });

  const fixtures: Record<string, [string, string, boolean][]> = {
    neverChose: [],
    allOn: [
      ['push', 'invite', true],
      ['push', 'plan_ready', true],
    ],
    mixed: [
      ['push', 'invite', true],
      ['push', 'plan_ready', false],
    ],
    campaignOnlyOff: [['push', 'campaign', false]],
    emailOnlyOff: [['email', 'invite', false]],
    allOff: [
      ['push', 'invite', false],
      ['push', 'date_reminder', false],
    ],
  };
  for (const [label, rows] of Object.entries(fixtures)) {
    const inserted = await pool.query(
      'insert into users (email, display_name) values ($1, $2) returning id',
      [`${label}@legacy.gogo.test`, label],
    );
    const userId = inserted.rows[0].id as string;
    legacy[label] = userId;
    for (const [channel, kind, enabled] of rows) {
      await pool.query(
        'insert into notification_preferences (user_id, channel, kind, enabled) values ($1, $2, $3, $4)',
        [userId, channel, kind, enabled],
      );
    }
  }

  await migrate(db, { migrationsFolder: migrations });

  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://assets-test.local';
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
  if (snapshot) await rm(snapshot, { recursive: true, force: true });
});

describe('migration 0064 backfill (ADR-0025)', () => {
  it('turns off every account that turned any push kind off, and turns on nobody who did', async () => {
    // Never chose, or chose only about email: no row, which already means on.
    expect(await storedSettings(legacy.neverChose!)).toBeNull();
    expect(await storedSettings(legacy.emailOnlyOff!)).toBeNull();
    expect(await storedSettings(legacy.allOn!)).toEqual({ push_enabled: true, source: 'migrated' });
    expect(await storedSettings(legacy.mixed!)).toEqual({
      push_enabled: false,
      source: 'migrated',
    });
    expect(await storedSettings(legacy.campaignOnlyOff!)).toEqual({
      push_enabled: false,
      source: 'migrated',
    });
    expect(await storedSettings(legacy.allOff!)).toEqual({
      push_enabled: false,
      source: 'migrated',
    });

    // Per-kind rows are untouched, so a rolled-back application reads them.
    const { rows } = await pool.query(
      'select kind, enabled from notification_preferences where user_id = $1 order by kind',
      [legacy.mixed],
    );
    expect(rows).toEqual([
      { kind: 'invite', enabled: true },
      { kind: 'plan_ready', enabled: false },
    ]);
  });
});

describe('GET/PUT /v1/me/notification-settings', () => {
  it('is on by default, stores an explicit choice, and belongs to one account only', async () => {
    const a = await register('switch-a');
    const b = await register('switch-b');

    const initial = await getSettings(a.token);
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ pushEnabled: true, source: 'default', updatedAt: null });

    const off = await putSettings(a.token, { pushEnabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ pushEnabled: false, source: 'explicit' });
    expect(Date.parse(off.json().updatedAt)).not.toBeNaN();

    // Signing in as someone else on the same device reads that account's switch.
    expect((await getSettings(b.token)).json()).toMatchObject({
      pushEnabled: true,
      source: 'default',
    });
    expect((await getSettings(a.token)).json()).toMatchObject({ pushEnabled: false });

    // Idempotent: saying it twice changes nothing but the timestamp.
    expect((await putSettings(a.token, { pushEnabled: false })).json()).toMatchObject({
      pushEnabled: false,
      source: 'explicit',
    });
    expect((await putSettings(a.token, { pushEnabled: true })).json()).toMatchObject({
      pushEnabled: true,
      source: 'explicit',
    });
  });

  it('accepts only the switch itself', async () => {
    const { token } = await register('switch-strict');
    expect((await putSettings(token, { pushEnabled: 'yes' })).statusCode).toBe(400);
    expect((await putSettings(token, {})).statusCode).toBe(400);
    expect((await putSettings(token, { pushEnabled: true, kind: 'invite' })).statusCode).toBe(400);
    expect(
      (await api().inject({ method: 'GET', url: '/v1/me/notification-settings' })).statusCode,
    ).toBe(401);
  });

  it('an explicit on is not undone by per-kind rows an older client left behind', async () => {
    const { token, userId } = await register('switch-hidden');
    await db
      .insert(schema.notificationPreferences)
      .values({ userId, channel: 'push', kind: 'plan_ready', enabled: false });
    // Before the switch is touched, the leftover opt-out keeps push off.
    expect((await getSettings(token)).json()).toMatchObject({
      pushEnabled: false,
      source: 'legacy',
    });

    expect((await putSettings(token, { pushEnabled: true })).statusCode).toBe(200);

    const roomId = await roomWith([userId]);
    const push = await publish(roomId);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.userIds).toEqual([userId]);
    // And an older screen reads every push kind as on, which is what happens.
    const kinds = legacyGetPush(await legacyGet(token)).map((row) => row.enabled);
    expect(kinds).toHaveLength(6);
    expect(new Set(kinds)).toEqual(new Set([true]));
  });
});

describe('older per-kind clients', () => {
  it('a push opt-out turns the switch off; an opt-in never turns it back on', async () => {
    const { token } = await register('legacy-writer');

    expect(
      (await legacyPut(token, { channel: 'push', kind: 'invite', enabled: false })).statusCode,
    ).toBe(200);
    expect((await getSettings(token)).json()).toMatchObject({
      pushEnabled: false,
      source: 'legacy',
    });
    const afterOff = legacyGetPush(await legacyGet(token));
    expect(afterOff.map((row) => row.kind).sort()).toEqual([
      'date_reminder',
      'invite',
      'moderation_update',
      'plan_changed',
      'plan_ready',
      'preference_reminder',
    ]);
    expect(afterOff.every((row) => row.enabled === false)).toBe(true);

    expect(
      (await legacyPut(token, { channel: 'push', kind: 'invite', enabled: true })).statusCode,
    ).toBe(200);
    expect((await getSettings(token)).json()).toMatchObject({
      pushEnabled: false,
      source: 'legacy',
    });

    // The switch overrides a legacy off in the other direction too.
    expect((await putSettings(token, { pushEnabled: true })).json()).toMatchObject({
      pushEnabled: true,
      source: 'explicit',
    });
  });

  it('an email opt-out leaves push alone and is returned as stored', async () => {
    const { token } = await register('legacy-email');
    expect(
      (await legacyPut(token, { channel: 'email', kind: 'invite', enabled: false })).statusCode,
    ).toBe(200);
    expect((await getSettings(token)).json()).toMatchObject({
      pushEnabled: true,
      source: 'default',
    });
    const rows = (await legacyGet(token)).json() as {
      channel: string;
      kind: string;
      enabled: boolean;
    }[];
    expect(rows).toContainEqual({ channel: 'email', kind: 'invite', enabled: false });
  });
});

describe('delivery honours the switch', () => {
  it('outbox: the in-app row is always written, the push only for accounts that allow it', async () => {
    const on = await register('deliver-on');
    const off = await register('deliver-off');
    await putSettings(off.token, { pushEnabled: false });

    // One room per person keeps the inbox half about the switch alone; how
    // one event fans out to several recipients is covered by #584's tests.
    const offPush = await publish(await roomWith([off.userId]));
    expect(offPush.sent).toHaveLength(0);
    const onPush = await publish(await roomWith([on.userId]));
    expect(onPush.sent).toHaveLength(1);
    expect(onPush.sent[0]!.userIds).toEqual([on.userId]);
    for (const userId of [on.userId, off.userId]) {
      const inbox = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, userId));
      expect(inbox).toHaveLength(1);
    }

    // One event for both: the push names only the person who allows it.
    const mixed = await publish(await roomWith([on.userId, off.userId]));
    expect(mixed.sent).toHaveLength(1);
    expect(mixed.sent[0]!.userIds).toEqual([on.userId]);
  });

  it('campaign estimate and send use the same switch', async () => {
    const off = await register('campaign-off');
    const onDespiteRow = await register('campaign-on');
    await putSettings(off.token, { pushEnabled: false });
    await putSettings(onDespiteRow.token, { pushEnabled: true });
    // The switch wrote every per-kind row as on; a later off row behind it (for
    // example written by a rolled-back release) still cannot override it here.
    await db
      .insert(schema.notificationPreferences)
      .values({ userId: onDespiteRow.userId, channel: 'push', kind: 'campaign', enabled: false })
      .onConflictDoUpdate({
        target: [
          schema.notificationPreferences.userId,
          schema.notificationPreferences.channel,
          schema.notificationPreferences.kind,
        ],
        set: { enabled: false },
      });
    // A per-kind campaign opt-out written without a switch row — a legacy write
    // racing the deploy — stays off rather than silently back on.
    const racing = await register('campaign-racing');
    await db
      .insert(schema.notificationPreferences)
      .values({ userId: racing.userId, channel: 'push', kind: 'campaign', enabled: false });
    for (const [userId, sub] of [
      [off.userId, 'off'],
      [onDespiteRow.userId, 'on'],
      [racing.userId, 'racing'],
    ] as const) {
      await db
        .insert(schema.pushSubscriptions)
        .values({ userId, platform: 'ios', subscriptionId: `ns-${sub}-${Date.now()}` });
    }

    const { rows } = await db.execute(sql`
      select u.id from users u
      where ${audiencePredicate('all', {})} and ${respectsPushPreference()}
    `);
    const ids = (rows as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(onDespiteRow.userId);
    expect(ids).not.toContain(off.userId);
    expect(ids).not.toContain(racing.userId);
  });
});

describe('privacy', () => {
  it('exports the switch and removes it with the account', async () => {
    const { token, userId } = await register('switch-privacy');
    await putSettings(token, { pushEnabled: false });

    const exported = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().notificationSettings).toEqual({
      pushEnabled: false,
      source: 'explicit',
    });

    const deleted = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    expect(deleted.statusCode).toBe(200);
    expect(await storedSettings(userId)).toBeNull();
  });
});

/**
 * Rollback to the release before this change (ADR-0025, Migration & rollback).
 * These are that release's delivery rules, copied from develop da6a89e:
 *
 * - outbox, `libs/modules/notifications/application/outbox-dispatcher.ts:128-140`:
 *   the push for an event of kind K skips an account holding a `push` row for K
 *   with `enabled = false`;
 * - campaign estimate and send, `libs/modules/notifications/application/campaign-audience.ts:72-78`
 *   (`respectsPushPreference`, called from `campaigns.service.ts:489` and
 *   `campaign-dispatcher.ts:101`).
 */
const PUSH_KINDS = [
  'invite',
  'preference_reminder',
  'plan_ready',
  'plan_changed',
  'date_reminder',
  'moderation_update',
  'campaign',
] as const;

async function previousReleaseOutboxPushes(userId: string, kind: string): Promise<boolean> {
  const { rows } = await pool.query(
    'select channel, enabled from notification_preferences where user_id = any($1::uuid[]) and kind = $2',
    [[userId], kind],
  );
  const optedOutOfPush = (rows as { channel: string; enabled: boolean }[]).some(
    (p) => p.channel === 'push' && !p.enabled,
  );
  return !optedOutOfPush;
}

async function previousReleaseCampaignIncludes(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select not exists (
      select 1 from notification_preferences np
      where np.user_id = u.id and np.channel = 'push'
        and np.kind = 'campaign' and np.enabled = false
    ) as included
    from users u where u.id = $1`,
    [userId],
  );
  return rows[0].included as boolean;
}

/** Every kind the previous release would push to this account, campaigns last. */
async function previousReleasePushes(userId: string): Promise<string[]> {
  const kinds: string[] = [];
  for (const kind of PUSH_KINDS) {
    if (await previousReleaseOutboxPushes(userId, kind)) kinds.push(kind);
  }
  if (await previousReleaseCampaignIncludes(userId)) kinds.push('campaign audience');
  return kinds;
}

const EVERYTHING = [...PUSH_KINDS, 'campaign audience'];

async function thisReleaseAllows(userId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    select u.id from users u where u.id = ${userId}::uuid and ${respectsPushPreference()}
  `);
  return rows.length === 1;
}

describe('rollback to the previous release keeps every opt-out (ADR-0025)', () => {
  it('an explicit off stops every kind and every campaign in the previous release', async () => {
    const { token, userId } = await register('rollback-off');
    expect((await putSettings(token, { pushEnabled: false })).statusCode).toBe(200);
    expect(await thisReleaseAllows(userId)).toBe(false);
    expect(await previousReleasePushes(userId)).toEqual([]);
  });

  it('off, on, off again: the previous release follows the last choice', async () => {
    const { token, userId } = await register('rollback-toggle');
    await putSettings(token, { pushEnabled: false });
    await putSettings(token, { pushEnabled: true });
    expect(await thisReleaseAllows(userId)).toBe(true);
    expect(await previousReleasePushes(userId)).toEqual(EVERYTHING);
    await putSettings(token, { pushEnabled: false });
    expect(await thisReleaseAllows(userId)).toBe(false);
    expect(await previousReleasePushes(userId)).toEqual([]);
  });

  it('a legacy opt-in while push is off changes nothing in either release', async () => {
    const { token, userId } = await register('rollback-legacy-on');
    await putSettings(token, { pushEnabled: false });
    expect(
      (await legacyPut(token, { channel: 'push', kind: 'invite', enabled: true })).statusCode,
    ).toBe(200);
    expect((await getSettings(token)).json()).toMatchObject({ pushEnabled: false });
    expect(await previousReleasePushes(userId)).toEqual([]);
  });

  it('a legacy opt-out of one kind stops every kind in both releases', async () => {
    const { token, userId } = await register('rollback-legacy-off');
    expect(
      (await legacyPut(token, { channel: 'push', kind: 'plan_ready', enabled: false })).statusCode,
    ).toBe(200);
    expect(await thisReleaseAllows(userId)).toBe(false);
    expect(await previousReleasePushes(userId)).toEqual([]);
  });

  it('an explicit on is what the previous release reads too, leftover opt-outs included', async () => {
    const { token, userId } = await register('rollback-on-over-leftover');
    await db
      .insert(schema.notificationPreferences)
      .values({ userId, channel: 'push', kind: 'campaign', enabled: false });
    await putSettings(token, { pushEnabled: true });
    expect(await thisReleaseAllows(userId)).toBe(true);
    expect(await previousReleasePushes(userId)).toEqual(EVERYTHING);
  });

  it('racing writes never leave the previous release pushing where this one does not', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { token, userId } = await register(`rollback-race-${round}`);
      const writes = [
        () => putSettings(token, { pushEnabled: false }),
        () => putSettings(token, { pushEnabled: true }),
        () => legacyPut(token, { channel: 'push', kind: 'invite', enabled: true }),
        () => legacyPut(token, { channel: 'push', kind: 'plan_ready', enabled: false }),
        () => putSettings(token, { pushEnabled: round % 2 === 0 }),
      ];
      const order = round % 2 === 0 ? writes : [...writes].reverse();
      const results = await Promise.all(order.map((write) => write()));
      expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200]);

      const allowed = await thisReleaseAllows(userId);
      expect(await previousReleasePushes(userId)).toEqual(allowed ? EVERYTHING : []);
    }
  });
});

async function roomWith(userIds: string[]): Promise<string> {
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: `ns-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'group',
      decisionMode: 'vote',
      hostUserId: userIds[0]!,
      status: 'ready',
    })
    .returning();
  await db.insert(schema.roomMembers).values(
    userIds.map((userId, index) => ({
      roomId: room!.id,
      userId,
      role: index === 0 ? ('host' as const) : ('member' as const),
      displayName: `Member ${index}`,
    })),
  );
  return room!.id;
}

async function publish(roomId: string): Promise<FakePush> {
  await db
    .insert(schema.outboxEvents)
    .values({ eventType: 'plan.published', resourceType: 'room', resourceId: roomId, payload: {} });
  const push = new FakePush();
  await new OutboxDispatcher(db as never, push).dispatchBatch();
  return push;
}

function legacyGetPush(response: { json(): unknown }) {
  return (response.json() as { channel: string; kind: string; enabled: boolean }[]).filter(
    (row) => row.channel === 'push',
  );
}

describe('rollback boundary for accounts that wrote nothing after the deploy (ADR-0025)', () => {
  const EVERY_KIND_BUT = (...left: string[]) => EVERYTHING.filter((kind) => !left.includes(kind));

  it('a mixed legacy account is off here, and rolls back to its own per-kind choices', async () => {
    expect(await thisReleaseAllows(legacy.mixed!)).toBe(false);
    expect(await previousReleasePushes(legacy.mixed!)).toEqual(EVERY_KIND_BUT('plan_ready'));
  });

  it('a campaign-only opt-out is off here, and rolls back to everything but campaigns', async () => {
    expect(await thisReleaseAllows(legacy.campaignOnlyOff!)).toBe(false);
    expect(await previousReleasePushes(legacy.campaignOnlyOff!)).toEqual(
      EVERY_KIND_BUT('campaign', 'campaign audience'),
    );
  });

  it('the optional rollback hold stops the previous release for every account this one does not push to', async () => {
    const hold = await readFile(
      path.resolve(__dirname, '../../../scripts/ops/ntf-0064-rollback-hold.sql'),
      'utf8',
    );
    const { rows } = await pool.query('select id from users');
    const ids = (rows as { id: string }[]).map((row) => row.id);
    const before = new Map<string, string[]>();
    for (const id of ids) before.set(id, await previousReleasePushes(id));

    await pool.query(hold);
    await pool.query(hold);

    for (const id of ids) {
      const previous = await previousReleasePushes(id);
      if (await thisReleaseAllows(id)) {
        // The hold never touches an account this release pushes to.
        expect({ id, previous }).toEqual({ id, previous: before.get(id) });
      } else {
        expect({ id, previous }).toEqual({ id, previous: [] });
      }
    }
    expect(await previousReleasePushes(legacy.mixed!)).toEqual([]);
    expect(await previousReleasePushes(legacy.campaignOnlyOff!)).toEqual([]);
    expect(await previousReleasePushes(legacy.allOn!)).toEqual(EVERYTHING);
    expect(await previousReleasePushes(legacy.neverChose!)).toEqual(EVERYTHING);
  });
});
