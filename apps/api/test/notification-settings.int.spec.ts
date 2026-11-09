import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  DEFAULT_CATEGORIES,
  CONFIGURABLE_CATEGORIES,
} from '../../../libs/modules/notifications/domain/notification-registry';
import { mutateNotificationSettings } from '../../../libs/modules/notifications/application/category-preferences';
import {
  enableNotificationRecipientKeys,
  disableNotificationRecipientKeys,
  quiesceNotificationProducers,
  resumeNotificationProducers,
  freezeNotificationPreferenceWrites,
  collapseNotificationCategoriesBatch,
  unfreezeNotificationPreferenceWrites,
} from '@gogo/database';
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
import { FakePush, ProviderUnavailableError } from '@gogo/providers';
import { CampaignDispatcher } from '@gogo/modules';

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
let migrationCategoryCount = -1;
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
      password: 'Sufficiently-long-pw1!',
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
  migrationCategoryCount = (
    await pool.query('select count(*)::int as n from notification_category_preferences')
  ).rows[0].n;
  await pool.query('update notification_category_rollout set recipient_keys_enabled = true');

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
    expect(initial.json()).toMatchObject({
      pushEnabled: true,
      source: 'default',
      updatedAt: null,
      version: '0',
    });

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
    expect(new Set(kinds)).toEqual(new Set([true, false]));
    expect(
      legacyGetPush(await legacyGet(token)).find((r) => r.kind === 'moderation_update')?.enabled,
    ).toBe(false);
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
    expect(exported.json().notificationSettings).toMatchObject({
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
const AFTER_CATEGORY_WRITE = EVERYTHING.filter((k) => k !== 'moderation_update');

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
    expect(await previousReleasePushes(userId)).toEqual(AFTER_CATEGORY_WRITE);
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
    expect(await previousReleasePushes(userId)).toEqual(AFTER_CATEGORY_WRITE);
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
      expect(await previousReleasePushes(userId)).toEqual(allowed ? AFTER_CATEGORY_WRITE : []);
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

const patchSettings = (token: string, payload: unknown, etag?: string, key = randomUUID()) =>
  api().inject({
    method: 'PATCH',
    url: '/v1/me/notification-settings',
    remoteAddress: ip(),
    headers: { ...auth(token), 'idempotency-key': key, ...(etag ? { 'if-match': etag } : {}) },
    payload: payload as Record<string, unknown>,
  });

describe('ADR-0050 category preference mutations', () => {
  it('migrates without reconstructing category consent or enabling a master-off account', async () => {
    expect(migrationCategoryCount).toBe(0);
    const current = await readFile(
      path.resolve(__dirname, '../../../migrations/0094_notification-category-preferences.sql'),
      'utf8',
    );
    expect(current).not.toContain('CREATE INDEX CONCURRENTLY');
    // #817 F-05: no inline validated CHECK on the hot table; the scan runs later.
    expect(current).not.toMatch(/ADD COLUMN version[^;]*CHECK/);
    expect(current).toMatch(
      /ADD CONSTRAINT notification_settings_version_check CHECK \(version >= 0\) NOT VALID/,
    );
    const convalidated = async () =>
      (
        await pool.query(
          "select convalidated from pg_constraint where conname = 'notification_settings_version_check'",
        )
      ).rows[0]?.convalidated;
    expect(await convalidated()).toBe(false);
    await pool.query(
      await readFile(
        path.resolve(__dirname, '../../../scripts/ops/validate-notification-settings-version.sql'),
        'utf8',
      ),
    );
    expect(await convalidated()).toBe(true);
    const account = await register('category-default');
    const initial = await getSettings(account.token);
    expect(initial.json()).toMatchObject({ categories: DEFAULT_CATEGORIES, version: '0' });
    expect(initial.headers.etag).toBe('"notification-settings-0"');
    await putSettings(account.token, { pushEnabled: false });
    expect((await getSettings(account.token)).json()).toMatchObject({
      pushEnabled: false,
      categories: DEFAULT_CATEGORIES,
    });
  });
  it('implements master/category/global-enable and legacy semantics for all five categories', async () => {
    const { token, userId } = await register('category-table');
    for (const category of CONFIGURABLE_CATEGORIES) {
      let before = await getSettings(token);
      const changed = await patchSettings(
        token,
        { categories: { [category]: false } },
        String(before.headers.etag),
      );
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        pushEnabled: true,
        categories: { [category]: false },
      });
      expect(legacyGetPush(await legacyGet(token)).find((r) => r.kind === category)?.enabled).toBe(
        false,
      );
      await legacyPut(token, { channel: 'push', kind: category, enabled: true });
      before = await getSettings(token);
      expect(before.json().categories[category]).toBe(false);
      await patchSettings(token, { pushEnabled: false }, String(before.headers.etag));
      before = await getSettings(token);
      const all = await patchSettings(
        token,
        { categories: DEFAULT_CATEGORIES },
        String(before.headers.etag),
      );
      expect(all.json()).toMatchObject({ pushEnabled: false, categories: DEFAULT_CATEGORIES });
      before = await getSettings(token);
      await patchSettings(
        token,
        { categories: { [category]: false } },
        String(before.headers.etag),
      );
      before = await getSettings(token);
      await patchSettings(token, { pushEnabled: true }, String(before.headers.etag));
      expect((await getSettings(token)).json().categories[category]).toBe(false);
      await putSettings(token, { pushEnabled: false });
      expect((await getSettings(token)).json().categories[category]).toBe(false);
      await putSettings(token, { pushEnabled: true });
      expect((await getSettings(token)).json()).toMatchObject({
        pushEnabled: true,
        categories: DEFAULT_CATEGORIES,
      });
      await legacyPut(token, { channel: 'push', kind: category, enabled: false });
      expect((await getSettings(token)).json().pushEnabled).toBe(false);
      await putSettings(token, { pushEnabled: true });
    }
    const audit = await pool.query(
      "select count(*)::int as n from audit_logs where actor_id=$1 and action='user.notification_settings_updated'",
      [userId],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });
  it('serializes optimistic writes and replays before stale rejection without another version/audit', async () => {
    const { token } = await register('category-concurrent');
    const initial = await getSettings(token);
    const etag = String(initial.headers.etag);
    const firstKey = randomUUID();
    const payload = { categories: { invite: false } };
    const first = await patchSettings(token, payload, etag, firstKey);
    expect(first.statusCode).toBe(200);
    const second = await patchSettings(
      token,
      { categories: { plan_ready: false } },
      String(first.headers.etag),
    );
    expect(second.statusCode).toBe(200);
    const replay = await patchSettings(token, payload, etag, firstKey);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers.etag).toBe(first.headers.etag);
    expect((await getSettings(token)).json()).toEqual(second.json());
    expect((await patchSettings(token, { pushEnabled: false }, etag)).statusCode).toBe(412);
    expect((await patchSettings(token, { pushEnabled: false }, etag, firstKey)).statusCode).toBe(
      422,
    );
    expect((await patchSettings(token, { pushEnabled: false })).statusCode).toBe(428);
    const concurrentEtag = String(second.headers.etag);
    const writers = await Promise.all([
      patchSettings(token, { categories: { plan_changed: false } }, concurrentEtag),
      patchSettings(token, { categories: { date_reminder: false } }, concurrentEtag),
    ]);
    expect(writers.map((r) => r.statusCode).sort()).toEqual([200, 412]);
    const noopBefore = await getSettings(token);
    const noop = await patchSettings(token, { pushEnabled: true }, String(noopBefore.headers.etag));
    expect(noop.json()).toEqual(noopBefore.json());
  });
  it('rejects empty/unknown/category other/weak ETags/missing keys and isolates accounts', async () => {
    const a = await register('category-validation-a');
    const b = await register('category-validation-b');
    const before = await getSettings(a.token);
    for (const payload of [
      {},
      { categories: {} },
      { categories: { other: false } },
      { categories: { invite: 'false' } },
    ])
      expect((await patchSettings(a.token, payload, String(before.headers.etag))).statusCode).toBe(
        400,
      );
    expect(
      (await patchSettings(a.token, { pushEnabled: false }, 'W/' + before.headers.etag)).statusCode,
    ).toBe(412);
    const missingKey = await api().inject({
      method: 'PATCH',
      url: '/v1/me/notification-settings',
      headers: { ...auth(a.token), 'if-match': String(before.headers.etag) },
      payload: { pushEnabled: false },
    });
    expect(missingKey.statusCode).toBe(400);
    await patchSettings(a.token, { categories: { invite: false } }, String(before.headers.etag));
    expect((await getSettings(b.token)).json()).toMatchObject({
      version: '0',
      categories: DEFAULT_CATEGORIES,
    });
    const exported = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(a.token),
    });
    expect(exported.json().notificationSettings.categories.invite).toBe(false);
    await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(a.token),
      payload: {},
    });
    expect(
      (
        await pool.query('select * from notification_category_preferences where user_id=$1', [
          a.userId,
        ])
      ).rows,
    ).toEqual([]);
  });
});

describe('ADR-0050 delivery and rollback safeguards', () => {
  it('blocks recipient-key activation for every unresolved event, including newer dead letters', async () => {
    const id = randomUUID();
    await pool.query(
      "insert into outbox_events(id,event_type,resource_type,resource_id,payload,occurred_at,failed_at) values($1,'plan.published','room',$2,'{}',now() + interval '1 day',now())",
      [id, randomUUID()],
    );
    await quiesceNotificationProducers(db);
    try {
      await expect(enableNotificationRecipientKeys(db, ['plan.published'])).rejects.toThrow(
        'existing provider keys',
      );
      await pool.query('update outbox_events set published_at=now() where id=$1', [id]);
      await enableNotificationRecipientKeys(db, ['plan.published']);
    } finally {
      await resumeNotificationProducers(db);
    }
  });
  it('fences old producers and blocks rollback after partial acceptance until current-key reconciliation', async () => {
    const a = await register('transition-accepted');
    const b = await register('transition-ambiguous');
    const c = await register('transition-suppressed');
    await mutateNotificationSettings(db, c.userId, { categories: { plan_ready: false } });
    const roomId = await roomWith([a.userId, b.userId, c.userId]);
    const [event] = await db
      .insert(schema.outboxEvents)
      .values({
        eventType: 'plan.published',
        resourceType: 'room',
        resourceId: roomId,
        payload: {},
      })
      .returning();
    const calls: { userId: string; key: string | undefined }[] = [];
    const push = new FakePush();
    let ambiguous = true;
    const send = push.sendToUsers.bind(push);
    push.sendToUsers = async (ids, notification) => {
      calls.push({ userId: ids[0]!, key: notification.idempotencyKey });
      if (ids.includes(b.userId) && ambiguous)
        throw new ProviderUnavailableError('acceptance_unknown');
      return send(ids, notification);
    };
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch();
    await quiesceNotificationProducers(db);
    try {
      await expect(
        pool.query(
          "insert into outbox_events(event_type,resource_type,resource_id,payload) values('plan.published','room',$1,'{}')",
          [roomId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(disableNotificationRecipientKeys(db, ['plan.published'])).rejects.toThrow(
        'existing provider keys',
      );
      expect(
        (await pool.query('select recipient_keys_enabled from notification_category_rollout'))
          .rows[0].recipient_keys_enabled,
      ).toBe(true);
      // Opt-in does not resurrect c; only b's unresolved key may be retried.
      await mutateNotificationSettings(db, c.userId, { categories: { plan_ready: true } });
      ambiguous = false;
      await pool.query('update outbox_events set next_attempt_at=null where id=$1', [event!.id]);
      await worker.dispatchBatch();
      expect(calls.filter((call) => call.userId === a.userId)).toHaveLength(1);
      const bCalls = calls.filter((call) => call.userId === b.userId);
      expect(bCalls).toHaveLength(2);
      expect(bCalls[0]!.key).toBe(bCalls[1]!.key);
      expect(calls.some((call) => call.userId === c.userId)).toBe(false);
      await mutateNotificationSettings(db, c.userId, { categories: { invite: false } });
      await disableNotificationRecipientKeys(db, ['plan.published']);
      await expect(resumeNotificationProducers(db)).rejects.toThrow('Complete rollback collapse');
      while (await collapseNotificationCategoriesBatch(db)) {
        /* resumable rollback */
      }
      expect(await worker.dispatchBatch()).toBe(0);
      await resumeNotificationProducers(db);
      // Work produced by the old generation is newer than the initial cutover.
      const id = randomUUID();
      await pool.query(
        "insert into outbox_events(id,event_type,resource_type,resource_id,payload) values($1,'plan.published','room',$2,'{}')",
        [id, roomId],
      );
      await quiesceNotificationProducers(db);
      await expect(enableNotificationRecipientKeys(db, ['plan.published'])).rejects.toThrow(
        'existing provider keys',
      );
      // Represents operator reconciliation with the original event/locale key.
      await pool.query('update outbox_events set published_at=now() where id=$1', [id]);
      await enableNotificationRecipientKeys(db, ['plan.published']);
      const ledger = await pool.query(
        'select user_id,status from notification_push_deliveries where event_id=$1',
        [event!.id],
      );
      expect(ledger.rows).toEqual(
        expect.arrayContaining([
          { user_id: a.userId, status: 'sent' },
          { user_id: b.userId, status: 'sent' },
          { user_id: c.userId, status: 'suppressed' },
        ]),
      );
    } finally {
      await enableNotificationRecipientKeys(db, ['plan.published']);
      await unfreezeNotificationPreferenceWrites(db);
      await resumeNotificationProducers(db);
    }
  });
  it('never enqueues disabled categories, keeps the inbox, and never replays suppressed work', async () => {
    const a = await register('category-worker-disabled');
    await mutateNotificationSettings(db, a.userId, { categories: { plan_ready: false } });
    const push = await publish(await roomWith([a.userId]));
    expect(push.sent).toHaveLength(0);
    const deliveries = await pool.query(
      'select event_id,status from notification_push_deliveries where user_id=$1',
      [a.userId],
    );
    expect(deliveries.rows).toHaveLength(1);
    expect(deliveries.rows[0].status).toBe('suppressed');
    await mutateNotificationSettings(db, a.userId, { categories: { plan_ready: true } });
    await pool.query('update outbox_events set published_at=null where id=$1', [
      deliveries.rows[0].event_id,
    ]);
    await new OutboxDispatcher(db, push).dispatchBatch();
    expect(push.sent).toHaveLength(0);
    expect(
      (await pool.query('select 1 from notifications where user_id=$1', [a.userId])).rows,
    ).toHaveLength(1);
  });
  it('rechecks category consent after enqueue, immediately before provider attempt', async () => {
    const a = await register('category-worker-race');
    const roomId = await roomWith([a.userId]);
    await db.insert(schema.outboxEvents).values({
      eventType: 'plan.published',
      resourceType: 'room',
      resourceId: roomId,
      payload: {},
    });
    let fired = false;
    const intercepted = new Proxy(db, {
      get(target, key) {
        if (key === 'execute')
          return async (query: Parameters<typeof db.execute>[0]) => {
            if (
              !fired &&
              new PgDialect()
                .sqlToQuery(query as never)
                .sql.includes('select u.id, u.locale from users u')
            ) {
              fired = true;
              await mutateNotificationSettings(db, a.userId, { categories: { plan_ready: false } });
            }
            return target.execute(query);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const push = new FakePush();
    await new OutboxDispatcher(intercepted, push).dispatchBatch();
    expect(fired).toBe(true);
    expect(push.sent).toHaveLength(0);
    expect(
      (
        await pool.query('select status from notification_push_deliveries where user_id=$1', [
          a.userId,
        ])
      ).rows,
    ).toEqual([{ status: 'suppressed' }]);
  });
  it('rechecks before retries, uses stable recipient keys and never resends accepted recipients', async () => {
    const a = await register('category-worker-retry-a');
    const b = await register('category-worker-retry-b');
    const roomId = await roomWith([a.userId, b.userId]);
    await db.insert(schema.outboxEvents).values({
      eventType: 'plan.published',
      resourceType: 'room',
      resourceId: roomId,
      payload: {},
    });
    const attempted: { ids: string[]; key: string | undefined }[] = [];
    const push = new FakePush();
    let failed = false;
    const original = push.sendToUsers.bind(push);
    push.sendToUsers = async (ids, notification) => {
      attempted.push({ ids: [...ids], key: notification.idempotencyKey });
      if (ids.includes(b.userId) && !failed) {
        failed = true;
        throw new ProviderUnavailableError('test');
      }
      return original(ids, notification);
    };
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch();
    await mutateNotificationSettings(db, b.userId, { pushEnabled: false });
    await pool.query('update outbox_events set next_attempt_at=null where resource_id=$1', [
      roomId,
    ]);
    await worker.dispatchBatch();
    expect(attempted.filter((a) => a.ids.includes(b.userId))).toHaveLength(1);
    expect(attempted.filter((call) => call.ids.includes(a.userId))).toHaveLength(1);
    expect(attempted.every((call) => call.ids.length === 1)).toBe(true);
    expect(new Set(attempted.map((a) => a.key)).size).toBe(2);
    await mutateNotificationSettings(db, b.userId, { pushEnabled: true });
    await pool.query(
      'update outbox_events set published_at=null,next_attempt_at=null where resource_id=$1',
      [roomId],
    );
    await worker.dispatchBatch();
    expect(attempted).toHaveLength(2);
  });
  it('suppresses a staged recipient who left before the retry and publishes only once the ledger is resolved (#817 F-04)', async () => {
    const a = await register('category-worker-left-a');
    const b = await register('category-worker-left-b');
    const roomId = await roomWith([a.userId, b.userId]);
    const [event] = await db
      .insert(schema.outboxEvents)
      .values({
        eventType: 'plan.published',
        resourceType: 'room',
        resourceId: roomId,
        payload: {},
      })
      .returning();
    const push = new FakePush();
    const original = push.sendToUsers.bind(push);
    let outage = true;
    push.sendToUsers = async (ids, notification) => {
      if (outage) throw new ProviderUnavailableError('test');
      return original(ids, notification);
    };
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch();
    // The whole cohort is staged before the first provider attempt failed.
    const staged = await pool.query(
      "select user_id from notification_push_deliveries where event_id=$1 and status='pending'",
      [event!.id],
    );
    expect(staged.rows.map((row) => row.user_id).sort()).toEqual([a.userId, b.userId].sort());
    await pool.query('update room_members set removed_at=now() where room_id=$1 and user_id=$2', [
      roomId,
      b.userId,
    ]);
    outage = false;
    await pool.query('update outbox_events set next_attempt_at=null where id=$1', [event!.id]);
    await worker.dispatchBatch();
    expect(push.sent.map((call) => call.userIds)).toEqual([[a.userId]]);
    const ledger = await pool.query(
      'select user_id,status from notification_push_deliveries where event_id=$1',
      [event!.id],
    );
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows).toEqual(
      expect.arrayContaining([
        { user_id: a.userId, status: 'sent' },
        { user_id: b.userId, status: 'suppressed' },
      ]),
    );
    expect(
      (await pool.query('select published_at from outbox_events where id=$1', [event!.id])).rows[0]
        .published_at,
    ).toBeTruthy();
  });
  it('drains an empty cohort: a staged recipient whose whole room left is terminally suppressed and the event publishes (#817 F-04)', async () => {
    const a = await register('category-worker-left-all');
    const roomId = await roomWith([a.userId]);
    const [event] = await db
      .insert(schema.outboxEvents)
      .values({
        eventType: 'plan.published',
        resourceType: 'room',
        resourceId: roomId,
        payload: {},
      })
      .returning();
    const push = new FakePush();
    push.unavailable = true;
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch();
    expect(
      (
        await pool.query(
          'select status from notification_push_deliveries where event_id=$1 and user_id=$2',
          [event!.id, a.userId],
        )
      ).rows,
    ).toEqual([{ status: 'pending' }]);
    await pool.query('update room_members set removed_at=now() where room_id=$1', [roomId]);
    push.unavailable = false;
    await pool.query('update outbox_events set next_attempt_at=null where id=$1', [event!.id]);
    await worker.dispatchBatch();
    expect(push.sent).toHaveLength(0);
    expect(
      (
        await pool.query('select status from notification_push_deliveries where event_id=$1', [
          event!.id,
        ])
      ).rows,
    ).toEqual([{ status: 'suppressed' }]);
    expect(
      (await pool.query('select published_at from outbox_events where id=$1', [event!.id])).rows[0]
        .published_at,
    ).toBeTruthy();
    // Nothing pending remains anywhere, so the transition gates can open.
    expect(
      (
        await pool.query(
          "select 1 from notification_push_deliveries where status in ('pending','attempting') limit 1",
        )
      ).rows,
    ).toEqual([]);
  });
  it('freezes old/new writes, collapses conservatively in bounded commits and retains read/category state', async () => {
    const a = await register('category-rollback');
    await mutateNotificationSettings(db, a.userId, { categories: { invite: false } });
    await pool.query(
      "insert into notifications(user_id,kind,payload,read_at) values($1,'invite','{}',now())",
      [a.userId],
    );
    const before = await getSettings(a.token);
    await freezeNotificationPreferenceWrites(db);
    try {
      expect((await putSettings(a.token, { pushEnabled: true })).statusCode).toBe(503);
      expect(
        (
          await patchSettings(
            a.token,
            { categories: DEFAULT_CATEGORIES },
            String(before.headers.etag),
          )
        ).statusCode,
      ).toBe(503);
      expect(
        (await legacyPut(a.token, { channel: 'push', kind: 'invite', enabled: true })).statusCode,
      ).toBe(503);
      await expect(
        pool.query('update notification_settings set push_enabled=true where user_id=$1', [
          a.userId,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      while (await collapseNotificationCategoriesBatch(db)) {
        /* account-sized rollback commits */
      }
      expect((await getSettings(a.token)).json()).toMatchObject({
        pushEnabled: false,
        categories: { invite: false },
      });
      expect(
        (
          await pool.query(
            "select enabled from notification_preferences where user_id=$1 and channel='push'",
            [a.userId],
          )
        ).rows.every((r) => !r.enabled),
      ).toBe(true);
      expect(
        (await pool.query('select read_at from notifications where user_id=$1', [a.userId])).rows[0]
          .read_at,
      ).toBeTruthy();
    } finally {
      await unfreezeNotificationPreferenceWrites(db);
    }
    expect((await getSettings(a.token)).json().pushEnabled).toBe(false);
  });
});

describe('campaign other/master final gate', () => {
  it.each(['platform', 'couple', 'group'] as const)(
    'lets a composer preview outside the %s audience',
    async (audienceType) => {
      const a = await register(`preview-outside-${audienceType}`);
      // The composer uses iOS, with no room membership. The selected audience is
      // Android or a room type they do not belong to.
      await db.insert(schema.pushSubscriptions).values({
        userId: a.userId,
        platform: 'ios',
        subscriptionId: `preview-${randomUUID()}`,
      });
      const [campaign] = await db
        .insert(schema.notificationCampaigns)
        .values({
          name: `preview-${randomUUID()}`,
          title: 'Preview',
          body: 'Preview body',
          audienceType,
          audienceFilter: audienceType === 'platform' ? { platform: 'android' } : {},
          dispatchKey: randomUUID(),
          createdByAdminId: randomUUID(),
          testSendUserId: a.userId,
          testSendRequestedAt: new Date(),
        })
        .returning();
      const push = new FakePush();
      const worker = new CampaignDispatcher(db, push);
      await worker.deliverTestSends();
      expect(push.sent.map((call) => call.userIds)).toEqual([[a.userId]]);
      expect(
        (await pool.query('select status from notification_campaigns where id=$1', [campaign!.id]))
          .rows[0].status,
      ).toBe('draft');
      // Scheduling the same creative still uses real campaign targeting.
      await db
        .update(schema.notificationCampaigns)
        .set({ status: 'scheduled', scheduledAt: new Date() })
        .where(eq(schema.notificationCampaigns.id, campaign!.id));
      await worker.dispatchDue();
      expect(push.sent.filter((call) => call.userIds.includes(a.userId))).toHaveLength(1);
    },
  );
  it.each(['master-off', 'no-subscription', 'deleted'] as const)(
    'does not bypass %s for a composer preview',
    async (reason) => {
      const a = await register(`preview-ineligible-${reason}`);
      if (reason !== 'no-subscription')
        await db.insert(schema.pushSubscriptions).values({
          userId: a.userId,
          platform: 'ios',
          subscriptionId: `preview-${randomUUID()}`,
        });
      if (reason === 'master-off')
        await mutateNotificationSettings(db, a.userId, { pushEnabled: false });
      if (reason === 'deleted')
        await pool.query("update users set status='deleted' where id=$1", [a.userId]);
      await db.insert(schema.notificationCampaigns).values({
        name: `preview-${randomUUID()}`,
        title: 'Preview',
        body: 'Preview body',
        audienceType: 'all',
        audienceFilter: {},
        dispatchKey: randomUUID(),
        createdByAdminId: randomUUID(),
        testSendUserId: a.userId,
        testSendRequestedAt: new Date(),
      });
      const push = new FakePush();
      await new CampaignDispatcher(db, push).deliverTestSends();
      expect(push.sent).toHaveLength(0);
    },
  );
  it('keeps campaigns independent of the five categories and suppresses an opt-out before sending/retrying', async () => {
    const a = await register('category-campaign-final');
    const choices = Object.fromEntries(CONFIGURABLE_CATEGORIES.map((k) => [k, false]));
    await mutateNotificationSettings(db, a.userId, { categories: choices });
    await db.insert(schema.pushSubscriptions).values({
      userId: a.userId,
      platform: 'android',
      subscriptionId: `category-campaign-${randomUUID()}`,
    });
    const audience = await db.execute(
      sql`select u.id from users u where u.id = ${a.userId}::uuid and ${audiencePredicate('platform', { platform: 'android' })} and ${respectsPushPreference()}`,
    );
    expect(audience.rows).toEqual([{ id: a.userId }]);
    const [campaign] = await db
      .insert(schema.notificationCampaigns)
      .values({
        name: `category-campaign-${randomUUID()}`,
        title: 'Test',
        body: 'Test',
        audienceType: 'platform',
        audienceFilter: { platform: 'android' },
        status: 'scheduled',
        scheduledAt: new Date(),
        dispatchKey: randomUUID(),
        createdByAdminId: randomUUID(),
      })
      .returning();
    let fired = false;
    const intercepted = new Proxy(db, {
      get(target, key) {
        if (key === 'execute')
          return async (query: Parameters<typeof db.execute>[0]) => {
            if (
              !fired &&
              new PgDialect().sqlToQuery(query as never).sql.includes('select n.id, n.push_sent_at')
            ) {
              fired = true;
              await mutateNotificationSettings(db, a.userId, { pushEnabled: false });
            }
            return target.execute(query);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const push = new FakePush();
    await new CampaignDispatcher(intercepted, push).dispatchDue();
    expect(fired).toBe(true);
    expect(push.sent).toHaveLength(0);
    const suppressed = await pool.query(
      "select push_suppressed_at from notifications where user_id=$1 and kind='campaign'",
      [a.userId],
    );
    expect(suppressed.rows[0].push_suppressed_at).toBeTruthy();
    await mutateNotificationSettings(db, a.userId, { pushEnabled: true });
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'scheduled', scheduledAt: new Date() })
      .where(eq(schema.notificationCampaigns.id, campaign!.id));
    await new CampaignDispatcher(db, push).dispatchDue();
    expect(push.sent).toHaveLength(0);
  });
  it('rollback collapses an account whose suppressed campaign delivery an old worker could resume, and nothing else (#817 F-01)', async () => {
    const subscribe = (userId: string) =>
      db.insert(schema.pushSubscriptions).values({
        userId,
        platform: 'web',
        subscriptionId: `rollback-campaign-${randomUUID()}`,
      });
    const newCampaign = async (status: 'scheduled' | 'sent' | 'cancelled') =>
      (
        await db
          .insert(schema.notificationCampaigns)
          .values({
            name: `rollback-campaign-${randomUUID()}`,
            title: 'Rollback',
            body: 'Rollback body',
            audienceType: 'platform',
            audienceFilter: { platform: 'web' },
            status,
            scheduledAt: status === 'scheduled' ? new Date() : null,
            dispatchKey: status === 'cancelled' ? null : randomUUID(),
            createdByAdminId: randomUUID(),
          })
          .returning()
      )[0]!;
    const campaignRow = (
      userId: string,
      key: string,
      column: 'push_sent_at' | 'push_suppressed_at',
    ) =>
      pool.query(
        `insert into notifications(user_id,kind,payload,dedupe_key,${column}) values($1,'campaign','{}',$2,now())`,
        [userId, `campaign:${key}:${userId}`],
      );

    // a: the real path — suppressed at the final check of a dispatch that then
    // failed and kept its key, so an old binary's `failed → scheduled` would
    // retry that exact dedupe key. Then a turns push back on, every category true.
    const a = await register('rollback-campaign-hazard');
    await subscribe(a.userId);
    const hazard = await newCampaign('scheduled');
    let fired = false;
    const intercepted = new Proxy(db, {
      get(target, key) {
        if (key === 'execute')
          return async (query: Parameters<typeof db.execute>[0]) => {
            if (
              !fired &&
              new PgDialect().sqlToQuery(query as never).sql.includes('select n.id, n.push_sent_at')
            ) {
              fired = true;
              await mutateNotificationSettings(db, a.userId, { pushEnabled: false });
            }
            return target.execute(query);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const push = new FakePush();
    await new CampaignDispatcher(intercepted, push).dispatchDue();
    expect(fired).toBe(true);
    expect(push.sent).toHaveLength(0);
    const hazardRow = () =>
      pool.query('select push_sent_at, push_suppressed_at from notifications where dedupe_key=$1', [
        `campaign:${hazard.dispatchKey}:${a.userId}`,
      ]);
    expect((await hazardRow()).rows).toMatchObject([
      { push_sent_at: null, push_suppressed_at: expect.anything() },
    ]);
    const hazardState = () =>
      pool.query('select status, dispatch_key from notification_campaigns where id=$1', [
        hazard.id,
      ]);
    expect((await hazardState()).rows).toEqual([
      { status: 'failed', dispatch_key: hazard.dispatchKey },
    ]);
    await mutateNotificationSettings(db, a.userId, { pushEnabled: true });
    expect(await thisReleaseAllows(a.userId)).toBe(true);
    expect(await previousReleasePushes(a.userId)).toEqual(AFTER_CATEGORY_WRITE);

    // Controls an old binary can never resume: b was accepted under the failed
    // dispatch; c was suppressed under a dispatch that ended `sent`; d was
    // suppressed under a dispatch that was cancelled (key cleared).
    const b = await register('rollback-campaign-accepted');
    const c = await register('rollback-campaign-sent-dispatch');
    const d = await register('rollback-campaign-cancelled-dispatch');
    await campaignRow(b.userId, hazard.dispatchKey!, 'push_sent_at');
    await campaignRow(c.userId, (await newCampaign('sent')).dispatchKey!, 'push_suppressed_at');
    await newCampaign('cancelled');
    await campaignRow(d.userId, randomUUID(), 'push_suppressed_at');
    for (const control of [b, c, d]) {
      expect(await previousReleasePushes(control.userId)).toEqual(EVERYTHING);
    }

    await quiesceNotificationProducers(db);
    try {
      // In-flight campaign work blocks either binary transition.
      await pool.query("update notification_campaigns set status='sending' where id=$1", [
        hazard.id,
      ]);
      await expect(disableNotificationRecipientKeys(db, ['plan.published'])).rejects.toThrow(
        'existing provider keys',
      );
      await pool.query("update notification_campaigns set status='failed' where id=$1", [
        hazard.id,
      ]);
      await disableNotificationRecipientKeys(db, ['plan.published']);
      await expect(resumeNotificationProducers(db)).rejects.toThrow('Complete rollback collapse');
      while (await collapseNotificationCategoriesBatch(db)) {
        /* account-sized rollback commits */
      }
      expect(await thisReleaseAllows(a.userId)).toBe(false);
      expect(await previousReleasePushes(a.userId)).toEqual([]);
      for (const control of [b, c, d]) {
        expect(await previousReleasePushes(control.userId)).toEqual(EVERYTHING);
      }
      // The ledger is untouched: suppression stays terminal, the dispatch stays as it was.
      expect((await hazardRow()).rows).toMatchObject([
        { push_sent_at: null, push_suppressed_at: expect.anything() },
      ]);
      expect((await hazardState()).rows).toEqual([
        { status: 'failed', dispatch_key: hazard.dispatchKey },
      ]);
      expect(
        (
          await pool.query(
            "select count(*)::int as n from audit_logs where resource_id=$1 and action='notification.category_rollback_collapsed'",
            [a.userId],
          )
        ).rows[0].n,
      ).toBe(1);
      await resumeNotificationProducers(db);
    } finally {
      await quiesceNotificationProducers(db);
      await enableNotificationRecipientKeys(db, ['plan.published']);
      await unfreezeNotificationPreferenceWrites(db);
      await resumeNotificationProducers(db);
    }
  });
});
