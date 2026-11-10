import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  schema,
  enableNotificationRecipientKeys,
  disableNotificationRecipientKeys,
  quiesceNotificationProducers,
} from '@gogo/database';
import { CampaignDispatcher } from '../../../libs/modules/notifications/application/campaign-dispatcher';
import { FakePush, ProviderUnavailableError } from '@gogo/providers';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import { PlansRepository } from '../../../libs/modules/plans/infrastructure/plans.repository';
import { ReminderWorker } from '../../../libs/modules/notifications/application/reminder-worker';
import { OutboxDispatcher } from '../../../libs/modules/notifications/application/outbox-dispatcher';
import {
  mutateNotificationSettings,
  readNotificationSettings,
} from '../../../libs/modules/notifications/application/category-preferences';
import { quietHoursEnd } from '../../../libs/modules/notifications/domain/quiet-hours';
import { syncReminderSchedule } from '../../../libs/modules/shared/reminder-schedule';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let rooms: RoomsRepository;
const event = (roomId: string) => ({
  eventType: 'room.constraints_updated',
  resourceType: 'room',
  resourceId: roomId,
  payload: {},
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_notification_schedules')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  // Production builds hot-table indexes after transactional migrations, too.
  for (const ddl of (
    await readFile(
      path.resolve(__dirname, '../../../scripts/ops/index-notification-deferred.sql'),
      'utf8',
    )
  )
    .split(';')
    .filter((s) => s.trim()))
    await pool.query(ddl);
  await pool.query('update notification_category_rollout set recipient_keys_enabled=true');
  rooms = new RoomsRepository(db);
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function fixture(minutes: number | null = 60) {
  const [user] = await db.insert(schema.users).values({ displayName: 'Schedule test' }).returning();
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: randomUUID(),
      type: 'group',
      decisionMode: 'host',
      hostUserId: user!.id,
      participantCount: 3,
      status: 'ready',
      scheduledDate: new Date(),
    })
    .returning();
  const [member] = await db
    .insert(schema.roomMembers)
    .values({ roomId: room!.id, userId: user!.id, role: 'host', displayName: 'Host' })
    .returning();
  const start = minutes === null ? null : new Date(Date.now() + minutes * 60_000);
  await db
    .insert(schema.roomConstraints)
    .values({ roomId: room!.id, version: 1, startAt: start, budgetMode: 'total', budgetAmount: 0 });
  await db.transaction((tx) => syncReminderSchedule(tx, room!.id));
  return { userId: user!.id, roomId: room!.id, memberId: member!.id, start, version: 1 };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function change(f: Fixture, startAt: Date | null) {
  f.version = await rooms.applyConstraintVersion({
    roomId: f.roomId,
    expectedVersion: f.version,
    memberId: f.memberId,
    constraint: { startAt, budgetMode: 'total', budgetAmount: 0 },
    event: event(f.roomId),
  });
  expect(f.version).toBeGreaterThan(1);
}
const jobs = async (f: Fixture) =>
  (
    await pool.query(
      'select * from notification_reminder_jobs where room_id=$1 order by created_at',
      [f.roomId],
    )
  ).rows;
const ledger = async (f: Fixture) =>
  (
    await pool.query(
      "select d.* from notification_push_deliveries d join outbox_events e on e.id=d.event_id where e.resource_id=$1 and e.event_type='room.reminder_due'",
      [f.roomId],
    )
  ).rows;
const quietZone = () => {
  const zone = Array.from(
    { length: 25 },
    (_, i) => `Etc/GMT${i < 12 ? '-' : '+'}${Math.abs(i - 12)}`,
  ).find((timezone) => quietHoursEnd(new Date(), { enabled: true, timezone }));
  expect(zone).toBeTruthy();
  return zone!;
};
const totals = {
  costMin: 0,
  costMax: 0,
  requiredCostMin: 0,
  requiredCostMax: 0,
  optionalCostMin: 0,
  optionalCostMax: 0,
  currency: 'VND',
  durationMinutes: 0,
  travelDistanceM: 0,
  overBudget: false,
  uncertain: false,
  travelEstimated: false,
};

describe('campaign inbox binary reconciliation (F-04)', () => {
  it.each(['quiet', 'ambiguous timeout'])(
    'blocks both transitions for a future draft test send after %s and reuses its provider key',
    async (reason) => {
      const f = await fixture(null);
      await db.insert(schema.pushSubscriptions).values({
        userId: f.userId,
        platform: 'ios',
        subscriptionId: randomUUID(),
      });
      await mutateNotificationSettings(db, f.userId, {
        quietHours: { enabled: true, timezone: quietZone() },
      });
      const [campaign] = await db
        .insert(schema.notificationCampaigns)
        .values({
          name: randomUUID(),
          title: 'Preview',
          body: 'Preview body',
          audienceType: 'all',
          audienceFilter: {},
          dispatchKey: randomUUID(),
          createdByAdminId: randomUUID(),
          testSendUserId: f.userId,
          testSendRequestedAt: new Date(),
        })
        .returning();
      const push = new FakePush();
      const worker = new CampaignDispatcher(db, push);
      await worker.deliverTestSends();
      const row = (
        await pool.query("select * from notifications where user_id=$1 and kind='campaign'", [
          f.userId,
        ])
      ).rows[0];
      expect(row.push_deferred_until).not.toBeNull();
      const keys: string[] = [];
      const original = push.sendToUser.bind(push);
      vi.spyOn(push, 'sendToUser').mockImplementation(async (user, message) => {
        keys.push(message.idempotencyKey!);
        if (reason === 'ambiguous timeout' && keys.length === 1) {
          await original(user, message);
          throw new ProviderUnavailableError('fake.push', 'timeout after acceptance');
        }
        return original(user, message);
      });
      if (reason === 'ambiguous timeout') {
        await mutateNotificationSettings(db, f.userId, { quietHours: { enabled: false } });
        await worker.dispatchDeferred();
      }
      expect(
        (await pool.query('select status from notification_campaigns where id=$1', [campaign!.id]))
          .rows[0].status,
      ).toBe('draft');
      const unresolved = (await pool.query('select * from notifications where id=$1', [row.id]))
        .rows[0];
      expect(unresolved.push_sent_at).toBeNull();
      expect(unresolved.push_suppressed_at).toBeNull();
      expect(new Date(unresolved.push_deferred_until).getTime()).toBeGreaterThan(Date.now());
      await quiesceNotificationProducers(db);
      try {
        for (const transition of [
          enableNotificationRecipientKeys,
          disableNotificationRecipientKeys,
        ]) {
          await expect(transition(db, ['room.reminder_due'])).rejects.toThrow(
            'existing provider keys',
          );
          expect(
            (
              await pool.query(
                'select recipient_keys_enabled, writes_frozen from notification_category_rollout',
              )
            ).rows[0],
          ).toMatchObject({ recipient_keys_enabled: true, writes_frozen: false });
        }
        await mutateNotificationSettings(db, f.userId, { quietHours: { enabled: false } });
        await pool.query('update notifications set push_deferred_until=now() where id=$1', [
          row.id,
        ]);
        await worker.dispatchDeferred();
        const done = (await pool.query('select * from notifications where id=$1', [row.id]))
          .rows[0];
        expect(done.push_sent_at).not.toBeNull();
        expect(done.dedupe_key).toBe(row.dedupe_key);
        expect(new Set(keys).size).toBe(1);
        expect(keys).toHaveLength(reason === 'quiet' ? 1 : 2);
        await enableNotificationRecipientKeys(db, ['room.reminder_due']);
        await disableNotificationRecipientKeys(db, ['room.reminder_due']);
      } finally {
        await pool.query(
          'update notification_category_rollout set producers_frozen=false, recipient_keys_enabled=true, writes_frozen=false',
        );
        await pool.query('delete from notifications where id=$1', [row.id]);
      }
    },
  );
});

describe('durable advance reminders and send-time quiet hours', () => {
  it('schedules exactly two hours before start; date-only and past starts create no work', async () => {
    const f = await fixture(240);
    expect(new Date((await jobs(f))[0].scheduled_for).getTime()).toBe(
      f.start!.getTime() - 120 * 60_000,
    );
    expect(await jobs(await fixture(null))).toEqual([]);
    expect(await jobs(await fixture(-1))).toEqual([]);
  });
  it('reschedules and removes the confirmed start in the room transaction', async () => {
    const f = await fixture(240);
    const old = (await jobs(f))[0];
    await change(f, new Date(Date.now() + 300 * 60_000));
    expect((await jobs(f)).find((j) => j.id === old.id).status).toBe('cancelled');
    expect((await jobs(f)).filter((j) => j.status === 'pending')).toHaveLength(1);
    await change(f, null);
    expect((await jobs(f)).every((j) => j.status === 'cancelled')).toBe(true);
  });
  it('newly confirmed inside the window emits once across concurrent ticks and restarts', async () => {
    const f = await fixture(60);
    await Promise.all([new ReminderWorker(db).runTick(), new ReminderWorker(db).runTick()]);
    await new ReminderWorker(db).runTick();
    const result = await pool.query('select payload from outbox_events where id=$1', [
      (await jobs(f))[0].id,
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].payload.notificationFacts.reminder).toMatchObject({
      trigger: 'scheduled',
      startsAt: f.start!.toISOString(),
      leadTimeSeconds: 7200,
      scheduleRevision: (await jobs(f))[0].id,
    });
    const push = new FakePush();
    await new OutboxDispatcher(db, push).dispatchBatch(1000);
    await new OutboxDispatcher(db, push).dispatchBatch(1000);
    await rooms.updateStatus(f.roomId, 'active', {
      ...event(f.roomId),
      eventType: 'room.status_active',
    });
    await new OutboxDispatcher(db, push).dispatchBatch(1000);
    expect(push.sent.filter((s) => s.userIds.includes(f.userId))).toHaveLength(1);
    expect((await ledger(f))[0].status).toBe('sent');
  });
  it('does not cancel a new schedule while a due tick races its room edit', async () => {
    const f = await fixture(60);
    const next = new Date(Date.now() + 300 * 60_000);
    await Promise.all([new ReminderWorker(db).runTick(), change(f, next)]);
    expect(
      (await jobs(f)).find((j) => new Date(j.starts_at).getTime() === next.getTime()).status,
    ).toBe('pending');
  });
  it('plan edits at the same start preserve the emitted schedule identity', async () => {
    const f = await fixture(60);
    await new ReminderWorker(db).runTick();
    const id = (await jobs(f))[0].id;
    const plans = new PlansRepository(db);
    for (let i = 0; i < 2; i++)
      await plans.createPlanVersion({
        roomId: f.roomId,
        constraintVersion: 1,
        stops: [],
        totals,
        events: [],
      });
    await new ReminderWorker(db).runTick();
    expect((await jobs(f)).map((j) => [j.id, j.status])).toEqual([[id, 'emitted']]);
  });
  it('cancels pending jobs when the room starts and skips overdue jobs', async () => {
    const f = await fixture(240);
    await rooms.updateStatus(f.roomId, 'active', {
      ...event(f.roomId),
      eventType: 'room.status_active',
    });
    expect((await jobs(f))[0].status).toBe('cancelled');
    // An already-staged room-started delivery from PR3 must be suppressed,
    // rather than creating a second reminder at start time.
    const oldEvent = (
      await pool.query(
        "select id from outbox_events where resource_id=$1 and event_type='room.status_active'",
        [f.roomId],
      )
    ).rows[0];
    await pool.query(
      "insert into notification_push_deliveries(event_id,user_id,status) values($1,$2,'pending')",
      [oldEvent.id, f.userId],
    );
    const push = new FakePush();
    await new OutboxDispatcher(db, push).dispatchBatch(1000);
    expect(push.sent.filter((s) => s.userIds.includes(f.userId))).toHaveLength(0);
    expect(
      (
        await pool.query('select status from notification_push_deliveries where event_id=$1', [
          oldEvent.id,
        ])
      ).rows[0].status,
    ).toBe('suppressed');
    const late = await fixture(60);
    await pool.query(
      "update room_constraints set start_at=now()-interval '1 minute' where room_id=$1",
      [late.roomId],
    );
    await new ReminderWorker(db).runTick();
    expect((await jobs(late))[0].status).toBe('cancelled');
  });
  it('rolls back job movement with the business transaction', async () => {
    const f = await fixture(240);
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(schema.rooms)
          .set({ status: 'cancelled' })
          .where(eq(schema.rooms.id, f.roomId));
        await syncReminderSchedule(tx, f.roomId);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await jobs(f))[0].status).toBe('pending');
  });
  it('defaults quiet hours off and validates a stored timezone without enabling master', async () => {
    const f = await fixture(null);
    expect((await readNotificationSettings(db, f.userId)).quietHours).toEqual({
      enabled: false,
      timezone: null,
    });
    await expect(
      mutateNotificationSettings(db, f.userId, { quietHours: { enabled: true } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      mutateNotificationSettings(db, f.userId, { quietHours: { timezone: 'Bad/Zone' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await mutateNotificationSettings(db, f.userId, {
      pushEnabled: false,
      quietHours: { enabled: true, timezone: 'Asia/Ho_Chi_Minh' },
    });
    await mutateNotificationSettings(db, f.userId, { pushEnabled: true }, { legacyPut: true });
    expect((await readNotificationSettings(db, f.userId)).quietHours).toEqual({
      enabled: true,
      timezone: 'Asia/Ho_Chi_Minh',
    });
  });
  it('creates inbox immediately, publishes outbox while deferred, and wakes on opt-out of quiet hours', async () => {
    const f = await fixture(60);
    await mutateNotificationSettings(db, f.userId, {
      quietHours: { enabled: true, timezone: quietZone() },
    });
    await new ReminderWorker(db).runTick();
    const push = new FakePush();
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch(1000);
    expect(push.sent.filter((s) => s.userIds.includes(f.userId))).toHaveLength(0);
    expect((await ledger(f))[0].status).toBe('deferred');
    expect(
      (
        await pool.query("select * from notifications where user_id=$1 and kind='date_reminder'", [
          f.userId,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query('select published_at from outbox_events where id=$1', [
          (await jobs(f))[0].id,
        ])
      ).rows[0].published_at,
    ).not.toBeNull();
    await mutateNotificationSettings(db, f.userId, { quietHours: { enabled: false } });
    await new OutboxDispatcher(db, push).dispatchDeferredBatch(1000);
    expect((await ledger(f))[0].status).toBe('sent');
    expect(push.sent.filter((s) => s.userIds.includes(f.userId))).toHaveLength(1);
  });
  it.each(['reschedule', 'expired', 'opt_out', 'removed'])(
    'suppresses a deferred reminder after %s',
    async (reason) => {
      const f = await fixture(60);
      await mutateNotificationSettings(db, f.userId, {
        quietHours: { enabled: true, timezone: quietZone() },
      });
      await new ReminderWorker(db).runTick();
      const push = new FakePush();
      await new OutboxDispatcher(db, push).dispatchBatch(1000);
      if (reason === 'reschedule') await change(f, new Date(Date.now() + 240 * 60_000));
      if (reason === 'expired')
        await pool.query(
          "update room_constraints set start_at=now()-interval '1 minute' where room_id=$1",
          [f.roomId],
        );
      if (reason === 'opt_out')
        await mutateNotificationSettings(db, f.userId, { categories: { date_reminder: false } });
      if (reason === 'removed')
        await pool.query('update room_members set removed_at=now() where id=$1', [f.memberId]);
      await mutateNotificationSettings(db, f.userId, { quietHours: { enabled: false } });
      await new OutboxDispatcher(db, push).dispatchDeferredBatch(1000);
      expect((await ledger(f))[0].status).toBe('suppressed');
      expect(push.sent.filter((s) => s.userIds.includes(f.userId))).toHaveLength(0);
      expect(
        (await pool.query('select count(*)::int n from notifications where user_id=$1', [f.userId]))
          .rows[0].n,
      ).toBeGreaterThan(0);
    },
  );
  it('retries a provider timeout with a stable recipient key and bounded dead letter', async () => {
    const f = await fixture(60);
    await new ReminderWorker(db).runTick();
    const push = new FakePush();
    const attempts: string[] = [];
    vi.spyOn(push, 'sendToUsers').mockImplementation(async (users, message) => {
      if (users.includes(f.userId)) {
        attempts.push(message.idempotencyKey!);
        throw new ProviderUnavailableError('fake.push', 'timeout');
      }
      return {
        providerMessageId: 'accepted',
        providerMessageIds: ['accepted'],
        unknownUserIds: [],
        emptyResponses: 0,
      };
    });
    const worker = new OutboxDispatcher(db, push);
    await worker.dispatchBatch(1000);
    for (let i = 0; i < 6; i++) {
      await pool.query(
        "update notification_push_deliveries set deferred_until=now() where user_id=$1 and status='deferred'",
        [f.userId],
      );
      await new OutboxDispatcher(db, push).dispatchDeferredBatch(1000);
    }
    expect(attempts).toHaveLength(6);
    expect(new Set(attempts).size).toBe(1);
    expect((await ledger(f))[0]).toMatchObject({ status: 'failed', deferred_attempts: 6 });
  });
});

describe('SA scheduling regressions', () => {
  it.each(['before tick', 'racing due selection'])(
    'keeps due reminders pending while fenced and drains existing deliveries: %s (F-01)',
    async (freeze) => {
      const draining = await fixture(60);
      await new ReminderWorker(db).runTick();
      const pending = await fixture(60);
      const push = new FakePush();
      const original = db.transaction.bind(db);
      let frozen = false;
      const spy = vi.spyOn(db, 'transaction').mockImplementation(async (run, config) => {
        // Freeze after the due-job read but before its production transaction.
        if (freeze === 'racing due selection' && !frozen) {
          await quiesceNotificationProducers(db);
          frozen = true;
        }
        return original(run, config);
      });
      try {
        if (freeze === 'before tick') await quiesceNotificationProducers(db);
        await expect(new ReminderWorker(db).runTick()).resolves.toBe(0);
        await new OutboxDispatcher(db, push).dispatchBatch(1000);
        await new OutboxDispatcher(db, push).dispatchDeferredBatch(1000);
        await new CampaignDispatcher(db, push).tick();
        expect((await jobs(pending))[0].status).toBe('pending');
        expect(push.sent.some((call) => call.userIds.includes(draining.userId))).toBe(true);
      } finally {
        spy.mockRestore();
        await pool.query('update notification_category_rollout set producers_frozen=false');
      }
    },
  );

  it('publishes a reminder and delivers later recipients while the first exhausts only its ledger budget (F-02)', async () => {
    const f = await fixture(60);
    const [later] = await db
      .insert(schema.users)
      .values({ displayName: 'Later member' })
      .returning();
    await db
      .insert(schema.roomMembers)
      .values({ roomId: f.roomId, userId: later!.id, role: 'member', displayName: 'Later' });
    await new ReminderWorker(db).runTick();
    const push = new FakePush();
    const keys: string[] = [];
    // Whichever UUID orders first must fail, reproducing starvation of the next row.
    const first = [f.userId, later!.id].sort()[0];
    const second = first === f.userId ? later!.id : f.userId;
    const original = push.sendToUsers.bind(push);
    vi.spyOn(push, 'sendToUsers').mockImplementation(async (users, message) => {
      if (users.includes(first!)) {
        keys.push(message.idempotencyKey!);
        throw new ProviderUnavailableError('fake.push', 'timeout');
      }
      return original(users, message);
    });
    await new OutboxDispatcher(db, push).dispatchBatch(1000);
    const eventId = (await jobs(f))[0].id;
    expect(
      (
        await pool.query(
          'select published_at, attempts, failed_at from outbox_events where id=$1',
          [eventId],
        )
      ).rows[0],
    ).toMatchObject({ published_at: expect.any(Date), attempts: 0, failed_at: null });
    expect(push.sent.filter((call) => call.userIds.includes(second))).toHaveLength(1);
    for (let attempt = 1; attempt < 6; attempt++) {
      await pool.query(
        "update notification_push_deliveries set deferred_until=now() where event_id=$1 and status='deferred'",
        [eventId],
      );
      await new OutboxDispatcher(db, push).dispatchDeferredBatch(1000);
    }
    expect((await ledger(f)).find((row) => row.user_id === first)).toMatchObject({
      status: 'failed',
      deferred_attempts: 6,
    });
    expect((await ledger(f)).find((row) => row.user_id === second)).toMatchObject({
      status: 'sent',
    });
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(1);
  });

  it('preserves a quiet recipient through a later provider failure and rescheduling of the same dispatch (F-03)', async () => {
    const users = await db
      .insert(schema.users)
      .values([{ displayName: 'A' }, { displayName: 'B' }])
      .returning();
    users.sort((a, b) => a.id.localeCompare(b.id));
    const [a, b] = users;
    await db.insert(schema.pushSubscriptions).values(
      users.map((u) => ({
        userId: u.id,
        platform: 'android' as const,
        subscriptionId: randomUUID(),
      })),
    );
    await mutateNotificationSettings(db, a!.id, {
      quietHours: { enabled: true, timezone: quietZone() },
    });
    const [campaign] = await db
      .insert(schema.notificationCampaigns)
      .values({
        name: randomUUID(),
        title: 'Campaign',
        body: 'Body',
        audienceType: 'platform',
        audienceFilter: { platform: 'android' },
        dispatchKey: randomUUID(),
        createdByAdminId: randomUUID(),
        status: 'scheduled',
        scheduledAt: new Date(),
      })
      .returning();
    const push = new FakePush();
    const original = push.sendToUser.bind(push);
    vi.spyOn(push, 'sendToUser').mockImplementation(async (user, message) => {
      if (user === b!.id) throw new ProviderUnavailableError('fake.push', 'timeout');
      return original(user, message);
    });
    const worker = new CampaignDispatcher(db, push);
    await worker.dispatchDue();
    expect(
      (await pool.query('select status from notification_campaigns where id=$1', [campaign!.id]))
        .rows[0].status,
    ).toBe('failed');
    const key = `campaign:${campaign!.dispatchKey}:${a!.id}`;
    await mutateNotificationSettings(db, a!.id, { quietHours: { enabled: false } });
    for (const status of ['failed', 'scheduled']) {
      await pool.query('update notification_campaigns set status=$2 where id=$1', [
        campaign!.id,
        status,
      ]);
      await pool.query('update notifications set push_deferred_until=now() where dedupe_key=$1', [
        key,
      ]);
      await worker.dispatchDeferred();
      expect(
        (await pool.query('select * from notifications where dedupe_key=$1', [key])).rows[0],
      ).toMatchObject({
        push_sent_at: null,
        push_suppressed_at: null,
        push_deferred_until: expect.any(Date),
        push_deferred_attempts: 0,
      });
    }
    vi.mocked(push.sendToUser).mockImplementation(original);
    await worker.dispatchDue();
    expect(
      (await pool.query('select * from notifications where dedupe_key=$1', [key])).rows[0],
    ).toMatchObject({ push_sent_at: expect.any(Date), push_suppressed_at: null, dedupe_key: key });
    expect(push.sent.filter((call) => call.userIds.includes(a!.id))).toHaveLength(1);
    await worker.dispatchDeferred();
    expect(push.sent.filter((call) => call.userIds.includes(a!.id))).toHaveLength(1);
  });
});
