import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { FakeCachePurge, FakePush, FakeStorage } from '@gogo/providers';
import { UserContentService } from '../../../libs/modules/reviews/application/user-content.service';
import { CmsUsersService } from '../../../libs/modules/cms/application/cms-users.service';
import { MediaCleanupService } from '../../../libs/modules/profile/application/media-cleanup.service';
import { PlansRepository } from '../../../libs/modules/plans/infrastructure/plans.repository';
import { RoomsRepository } from '../../../libs/modules/rooms/infrastructure/rooms.repository';
import { OutboxDispatcher } from '../../../libs/modules/notifications/application/outbox-dispatcher';
import { NotificationInboxService } from '../../../libs/modules/notifications/application/notification-inbox.service';
import type {
  PlanPreview,
  ReminderFacts,
} from '../../../libs/modules/shared/notification-event-facts';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let inbox: NotificationInboxService;
let plans: PlansRepository;
let rooms: RoomsRepository;
let userContent: UserContentService;
let cleanup: MediaCleanupService;
const start = '2026-11-09T12:00:00.000Z';
const mediaKey = `avatars/${'a'.repeat(32)}.webp`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_event_facts')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  await pool.query('update notification_category_rollout set recipient_keys_enabled=true');
  inbox = new NotificationInboxService(db, {
    AUTH_JWT_SECRET: 'event-facts-integration'.padEnd(48, 'x'),
  });
  plans = new PlansRepository(db);
  rooms = new RoomsRepository(db);
  cleanup = new MediaCleanupService(
    db,
    { private: new FakeStorage(), public: new FakeStorage() },
    new FakeCachePurge(),
    'https://media.gogo.test',
  );
  userContent = new UserContentService(
    db,
    {
      MEDIA_PUBLIC_BASE_URL: 'https://media.gogo.test',
      PRIVACY_SLA_JSON: '{}',
      PRIVACY_RETENTION_MONTHS: 12,
    },
    cleanup,
    null,
  );
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function fixture(confirmedStart: string | null = start) {
  const [host, member] = await db
    .insert(schema.users)
    .values([
      { displayName: 'Inviter at event time', avatarKey: mediaKey },
      { displayName: 'Recipient' },
    ])
    .returning();
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: randomUUID(),
      type: 'group',
      decisionMode: 'host',
      hostUserId: host!.id,
      participantCount: 3,
      status: 'ready',
      constraintVersion: 2,
      // A date-only display field must never become the schedule authority.
      scheduledDate: new Date('2026-11-09T00:00:00Z'),
    })
    .returning();
  const [inviter, recipient] = await db
    .insert(schema.roomMembers)
    .values([
      { roomId: room!.id, userId: host!.id, role: 'host', displayName: host!.displayName },
      { roomId: room!.id, userId: member!.id, role: 'member', displayName: member!.displayName },
    ])
    .returning();
  await db.insert(schema.roomConstraints).values([
    {
      roomId: room!.id,
      version: 1,
      startAt: new Date('2026-01-01T10:00:00Z'),
      budgetMode: 'total',
      budgetAmount: 0,
    },
    {
      roomId: room!.id,
      version: 2,
      startAt: confirmedStart ? new Date(confirmedStart) : null,
      budgetMode: 'total',
      budgetAmount: 0,
    },
  ]);
  const places = await db
    .insert(schema.places)
    .values(
      Array.from({ length: 4 }, (_, i) => ({
        name: i === 0 ? 'Independently sourced venue' : 'Do not copy canonical Google text',
        nameNormalized: `venue-${i}`,
        addressText: i === 0 ? 'Independently collected address' : 'Unproven address',
        status: 'published' as const,
        geom: { x: 106.7, y: 10.7 },
      })),
    )
    .returning();
  await db.insert(schema.placeFieldProvenance).values([
    {
      placeId: places[0]!.id,
      field: 'name',
      sourceType: 'editorial',
      sourceReference: 'Merchant interview in person',
    },
    {
      placeId: places[0]!.id,
      field: 'address_text',
      sourceType: 'community',
      sourceReference: 'Merchant statement, verified on site',
      collectedAt: new Date('2026-11-01T09:00:00Z'),
    },
    {
      placeId: places[1]!.id,
      field: 'name',
      sourceType: 'google_derived',
      sourceReference: 'Google Maps',
    },
    {
      placeId: places[1]!.id,
      field: 'address_text',
      sourceType: 'editorial',
      sourceReference: 'Legacy assertion without collection time',
    },
  ]);
  const mediaId = randomUUID();
  const [upload] = await db
    .insert(schema.mediaUploads)
    .values({
      storageKey: `gogo-owned/${mediaId}.webp`,
      actorType: 'user',
      actorId: host!.id,
      purpose: 'place_image',
      contentType: 'image/webp',
      contentLength: 100,
      status: 'attached',
      attachedToType: 'place',
      attachedToId: places[0]!.id,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    })
    .returning();
  await db.insert(schema.placeMedia).values([
    {
      id: mediaId,
      placeId: places[0]!.id,
      storageKey: upload!.storageKey,
      moderation: 'approved',
      sourceType: 'community',
      mediaUploadId: upload!.id,
      isCover: true,
    },
    {
      placeId: places[1]!.id,
      storageKey: 'provider-photo.webp',
      moderation: 'approved',
      sourceType: 'provider',
      isCover: true,
    },
  ]);
  const stops = places.map((p, position) => ({
    placeId: p.id,
    name: p.name,
    position,
    arriveAt: new Date('2026-11-09T12:15:00Z'),
    departAt: null,
    durationMinutes: 60,
    travelMinutesFromPrev: null,
    travelDistanceMFromPrev: null,
    costMin: null,
    costMax: null,
    isLocked: false,
    isOptional: false,
  }));
  const totals = {
    costMin: 0,
    costMax: 0,
    requiredCostMin: 0,
    requiredCostMax: 0,
    optionalCostMin: 0,
    optionalCostMax: 0,
    currency: 'VND',
    durationMinutes: 240,
    travelDistanceM: 0,
    overBudget: false,
    uncertain: true,
    travelEstimated: true,
  };
  return {
    room: room!,
    host: host!,
    member: member!,
    inviter: inviter!,
    recipient: recipient!,
    places,
    mediaId,
    stops,
    totals,
  };
}
async function publish(f: Awaited<ReturnType<typeof fixture>>, changed = false) {
  return plans.createPlanVersion({
    roomId: f.room.id,
    constraintVersion: 2,
    stops: f.stops,
    totals: f.totals,
    events: [
      {
        eventType: changed ? 'plan.changed' : 'plan.published',
        resourceType: 'room',
        resourceId: f.room.id,
        payload: changed
          ? { action: 'edit', stopCount: 4, optionalStopCount: 0 }
          : { stopCount: 4 },
      },
    ],
  });
}
async function dispatch() {
  const push = new FakePush();
  await new OutboxDispatcher(db, push).dispatchBatch(100);
  return push;
}
async function payloads(userId: string) {
  const page = await inbox.list(userId);
  return page.notifications.map((n) => ({
    kind: n.kind,
    payload: n.payload as Record<string, unknown> & {
      planPreview?: PlanPreview;
      reminder?: ReminderFacts;
    },
  }));
}

describe('producer → outbox → inbox sourced facts (#811 PR3)', () => {
  it('keeps event-time plan versions/text/schedule through delayed fan-out and retry, without Google content', async () => {
    const f = await fixture();
    const first = await publish(f);
    const second = await publish(f, true);
    expect(second.plan.version).toBe(first.plan.version + 1);
    await pool.query("update places set name='Changed after event' where id=$1", [f.places[0]!.id]);
    await pool.query(
      "update room_constraints set start_at='2026-11-10T12:00:00Z' where room_id=$1 and version=2",
      [f.room.id],
    );
    const push = await dispatch();
    const rows = await payloads(f.member.id);
    expect(rows).toHaveLength(2);
    const ready = rows.find((r) => r.kind === 'plan_ready')!.payload.planPreview!;
    const changed = rows.find((r) => r.kind === 'plan_changed')!.payload.planPreview!;
    expect(ready).toMatchObject({
      planId: first.plan.id,
      planVersion: 1,
      constraintVersion: 2,
      startAt: start,
      startAtSource: 'room_constraints',
      stopCount: 4,
    });
    expect(changed).toMatchObject({ planId: second.plan.id, planVersion: 2 });
    expect(ready.stops).toHaveLength(3);
    expect(ready.stops[0]).toMatchObject({
      name: { value: 'Independently sourced venue', originType: 'editorial', sourceType: 'gogo' },
      addressText: { value: 'Independently collected address', originType: 'community' },
      mediaId: f.mediaId,
      arriveAt: '2026-11-09T12:15:00.000Z',
    });
    for (const stop of ready.stops.slice(1)) {
      expect(stop).not.toHaveProperty('name');
      expect(stop).not.toHaveProperty('addressText');
      expect(stop).not.toHaveProperty('mediaId');
    }
    const events = (
      await pool.query('select payload from outbox_events where resource_id=$1', [f.room.id])
    ).rows;
    expect(JSON.stringify(events)).not.toMatch(
      /Do not copy|Unproven address|source_reference|actor_id|106\.7/,
    );
    expect(push.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(push.sent)).not.toMatch(
      /planPreview|Independently sourced|Independently collected/,
    );
    await pool.query('update outbox_events set published_at=null where resource_id=$1', [
      f.room.id,
    ]);
    await dispatch();
    expect(await payloads(f.member.id)).toEqual(rows);
    await pool.query("update place_media set moderation='rejected' where id=$1", [f.mediaId]);
    expect((await payloads(f.member.id))[0]!.payload.planPreview!.stops[0]).not.toHaveProperty(
      'mediaId',
    );
    await pool.query('update room_members set removed_at=now() where id=$1', [f.recipient.id]);
    for (const row of await payloads(f.member.id))
      expect(row.payload).not.toHaveProperty('planPreview');
  });
  it.each([start, null])(
    'captures room_started with current constraint instant %s, never a two-hour schedule',
    async (confirmedStart) => {
      const f = await fixture(confirmedStart);
      await publish(f);
      const event = {
        eventType: 'room.status_active',
        resourceType: 'room',
        resourceId: f.room.id,
        payload: { from: 'ready', to: 'active' },
      };
      expect(await rooms.updateStatus(f.room.id, 'active', event)).toBe(true);
      expect(await rooms.updateStatus(f.room.id, 'active', event)).toBe(false);
      await dispatch();
      // The producer still captures honest room_started facts, but PR4 retires
      // that notification: no start means no reminder, and start cannot send twice.
      expect((await payloads(f.member.id)).filter((r) => r.kind === 'date_reminder')).toEqual([]);
      const captured = await pool.query(
        "select payload from outbox_events where resource_id=$1 and event_type='room.status_active'",
        [f.room.id],
      );
      const facts = captured.rows[0].payload.notificationFacts;
      expect(facts.reminder).toMatchObject({
        trigger: 'room_started',
        scheduledFor: null,
        startsAt: confirmedStart,
      });
      expect(facts.reminder).not.toHaveProperty('leadTimeSeconds');
      expect(facts.reminder).not.toHaveProperty('scheduleRevision');
      expect(Number.isFinite(Date.parse(facts.reminder!.triggeredAt))).toBe(true);
      if (confirmedStart === null) expect(facts.planPreview).not.toHaveProperty('startAt');
      else expect(facts.planPreview!.startAt).toBe(start);
    },
  );
  it('snapshots inviter display and GoGo avatar, omits private identity and revoked/replaced media', async () => {
    const f = await fixture();
    const [newcomer] = await db
      .insert(schema.users)
      .values({ displayName: 'New member' })
      .returning();
    await rooms.addUserMember({
      roomId: f.room.id,
      userId: newcomer!.id,
      displayName: newcomer!.displayName,
      event: {
        eventType: 'member.joined',
        resourceType: 'room',
        resourceId: f.room.id,
        payload: { inviterMemberId: f.inviter.id },
      },
    });
    await pool.query("update room_members set display_name='Changed after join' where id=$1", [
      f.inviter.id,
    ]);
    await dispatch();
    const facts = (await payloads(f.host.id))[0]!.payload;
    expect(facts).toMatchObject({
      inviterName: 'Inviter at event time',
      inviterAvatar: { sourceType: 'gogo', mediaKey },
    });
    expect(facts).not.toHaveProperty('_inviterMemberId');
    await pool.query('update users set avatar_key=null where id=$1', [f.host.id]);
    expect((await payloads(f.host.id))[0]!.payload).not.toHaveProperty('inviterAvatar');
    await pool.query('update room_members set removed_at=now() where id=$1', [f.inviter.id]);
    expect((await payloads(f.host.id))[0]!.payload).not.toHaveProperty('inviterName');
  });
  it('keeps legacy inbox rows and queued events valid without synthesizing new structures', async () => {
    const f = await fixture();
    await publish(f);
    await pool.query(
      "insert into notifications(user_id,kind,payload) values($1,'date_reminder',$2)",
      [f.member.id, { roomId: f.room.id, resourceId: f.room.id }],
    );
    await db.insert(schema.outboxEvents).values({
      eventType: 'room.status_active',
      resourceType: 'room',
      resourceId: f.room.id,
      payload: {},
    });
    await dispatch();
    const legacy = (await payloads(f.member.id)).filter((r) => r.kind === 'date_reminder');
    expect(legacy).toHaveLength(1);
    for (const row of legacy) {
      expect(row.payload).not.toHaveProperty('reminder');
      expect(row.payload).not.toHaveProperty('planPreview');
      expect(row.payload).not.toHaveProperty('inviterAvatar');
    }
  });
  it('rolls back new plan, stops, and snapshot if the originating transaction cannot write its event', async () => {
    const f = await fixture();
    await expect(
      plans.createPlanVersion({
        roomId: f.room.id,
        constraintVersion: 2,
        stops: f.stops,
        totals: f.totals,
        events: [
          {
            eventType: 'plan.published',
            resourceType: null as unknown as string,
            resourceId: f.room.id,
            payload: {},
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      (await pool.query('select id from plans where room_id=$1', [f.room.id])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query('select id from outbox_events where resource_id=$1', [f.room.id])).rows,
    ).toHaveLength(0);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function invitationFixture() {
  const f = await fixture();
  // The inviter is a member; the live recipient is the host targeted by invite.
  await pool.query("update room_members set role='member' where id=$1", [f.inviter.id]);
  await pool.query("update room_members set role='host' where id=$1", [f.recipient.id]);
  await pool.query('update rooms set host_user_id=$1 where id=$2', [f.member.id, f.room.id]);
  return f;
}

async function join(
  f: Awaited<ReturnType<typeof fixture>>,
  tx?: Parameters<RoomsRepository['addUserMember']>[1],
) {
  const [newcomer] = await db.insert(schema.users).values({ displayName: 'New join' }).returning();
  return rooms.addUserMember(
    {
      roomId: f.room.id,
      userId: newcomer!.id,
      displayName: newcomer!.displayName,
      event: {
        eventType: 'member.joined',
        resourceType: 'room',
        resourceId: f.room.id,
        payload: { inviterMemberId: f.inviter.id },
      },
    },
    tx,
  );
}

async function erase(userId: string, source: 'self' | 'cms' = 'self') {
  if (source === 'cms') {
    // These dependencies are unused by the delete operation; erasure itself
    // uses the real CMS -> shared service -> database path and cleanup queue.
    const cms = new CmsUsersService(db, null!, userContent, null!);
    return cms.deleteAccount({ id: userId, reason: 'Account erasure', actorId: randomUUID() });
  }
  return userContent.deleteAccount({ type: 'user', id: userId, sessionId: randomUUID() });
}

async function waitForBlocker(pid: number) {
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            'select exists(select 1 from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))) as blocked',
            [pid],
          )
        ).rows[0].blocked,
    )
    .toBe(true);
}

async function storedInviterFacts(roomId: string) {
  return (
    await pool.query(
      "select payload->'notificationFacts' as facts from outbox_events where resource_id=$1 and event_type='member.joined' and payload ? 'notificationFacts' order by occurred_at",
      [roomId],
    )
  ).rows.map((row) => row.facts as Record<string, unknown>);
}

function expectOmitted(facts: Record<string, unknown>) {
  expect(facts).not.toHaveProperty('inviterName');
  expect(facts).not.toHaveProperty('inviterAvatar');
}

describe('ADR-0023 inviter snapshot erasure (#818 F-01)', () => {
  it.each([
    ['self', false],
    ['self', true],
    ['cms', false],
    ['cms', true],
  ] as const)(
    '%s erasure scrubs queued/published=%s events and other users inboxes, retaining dedupe and unrelated facts',
    async (source, published) => {
      const f = await invitationFixture();
      const other = await invitationFixture();
      // All memberships of the erased account, including removed memberships,
      // must be scrubbed rather than only its active membership in this room.
      await pool.query('update room_members set user_id=$1, removed_at=now() where id=$2', [
        f.host.id,
        other.inviter.id,
      ]);
      await join(f);
      const event = (
        await pool.query('select * from outbox_events where resource_id=$1', [f.room.id])
      ).rows[0];
      const snapshot = event.payload.notificationFacts;
      expect(snapshot).toMatchObject({
        inviterName: f.host.displayName,
        inviterAvatar: { mediaKey },
      });
      await pool.query(
        `update outbox_events set payload = payload || jsonb_build_object('keep', true,
        'notificationFacts', (payload->'notificationFacts') || '{"keep":true}'::jsonb) where id=$1`,
        [event.id],
      );
      if (published) await dispatch();
      // Also cover an already-materialized row owned by a different account.
      const [note] = await db
        .insert(schema.notifications)
        .values({
          userId: f.member.id,
          kind: 'invite',
          dedupeKey: randomUUID(),
          payload: { ...snapshot, keep: true },
        })
        .returning();
      const [second] = await db
        .insert(schema.outboxEvents)
        .values({
          eventType: 'member.joined',
          resourceType: 'room',
          resourceId: other.room.id,
          payload: { notificationFacts: { ...snapshot, _inviterMemberId: other.inviter.id } },
        })
        .returning();
      const [unrelated] = await db
        .insert(schema.notifications)
        .values({
          userId: f.member.id,
          kind: 'invite',
          payload: {
            ...snapshot,
            _inviterMemberId: f.recipient.id,
            inviterName: 'Unrelated inviter',
          },
        })
        .returning();
      const [legacyEvent] = await db
        .insert(schema.outboxEvents)
        .values({
          eventType: 'member.joined',
          resourceType: 'room',
          resourceId: f.room.id,
          payload: { inviterMemberId: f.inviter.id },
        })
        .returning();
      const legacyNotes = await db
        .insert(schema.notifications)
        .values([
          // Both historical dedupe shapes can identify facts without a marker.
          {
            userId: f.member.id,
            kind: 'invite',
            dedupeKey: legacyEvent!.id,
            payload: { inviterName: f.host.displayName, keep: true },
          },
          {
            userId: other.member.id,
            kind: 'invite',
            dedupeKey: `outbox:${legacyEvent!.id}:${other.member.id}`,
            payload: { inviterName: f.host.displayName, keep: true },
          },
        ])
        .returning();
      const before = (
        await pool.query('select published_at from outbox_events where id=$1', [event.id])
      ).rows[0];
      await erase(f.host.id, source);
      const retained = (await pool.query('select * from outbox_events where id=$1', [event.id]))
        .rows[0];
      expect(retained.published_at).toEqual(before.published_at);
      expect(retained.payload).toEqual({
        ...event.payload,
        keep: true,
        notificationFacts: { _inviterMemberId: f.inviter.id, keep: true },
      });
      expectOmitted(
        (await pool.query('select payload from outbox_events where id=$1', [second!.id])).rows[0]
          .payload.notificationFacts,
      );
      const kept = (await pool.query('select * from notifications where id=$1', [note!.id]))
        .rows[0];
      expect(kept).toMatchObject({
        dedupe_key: note!.dedupeKey,
        inbox_sequence: String(note!.inboxSequence),
      });
      expect(kept.payload).toEqual({ _inviterMemberId: f.inviter.id, keep: true });
      for (const legacy of legacyNotes) {
        const row = (
          await pool.query('select payload, dedupe_key from notifications where id=$1', [legacy.id])
        ).rows[0];
        expect(row).toEqual({ payload: { keep: true }, dedupe_key: legacy.dedupeKey });
      }
      expect(
        (await pool.query('select payload from notifications where id=$1', [unrelated!.id])).rows[0]
          .payload,
      ).toEqual(unrelated!.payload);
      await dispatch();
      for (const row of (
        await pool.query(
          "select payload from notifications where user_id=$1 and payload->>'_inviterMemberId'=$2",
          [f.member.id, f.inviter.id],
        )
      ).rows)
        expectOmitted(row.payload);
      // Replay retains the original dedupe records and cannot recreate PII.
      await pool.query(
        'update outbox_events set published_at=null, next_attempt_at=null where id=$1',
        [event.id],
      );
      await dispatch();
      expect(
        (await pool.query('select dedupe_key from notifications where id=$1', [note!.id])).rows[0]
          .dedupe_key,
      ).toBe(note!.dedupeKey);
      for (const facts of await storedInviterFacts(f.room.id)) expectOmitted(facts);
    },
  );

  it('erasure waits for a join that captured first, then scrubs its committed event', async () => {
    const f = await invitationFixture();
    const captured = deferred();
    const release = deferred();
    let pid = 0;
    const joining = db.transaction(async (tx) => {
      pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await join(f, tx);
      captured.resolve();
      await release.promise;
    });
    let deleting: Promise<unknown> | undefined;
    try {
      await captured.promise;
      expect(await storedInviterFacts(f.room.id)).toHaveLength(0);
      deleting = erase(f.host.id);
      await waitForBlocker(pid);
    } finally {
      release.resolve();
      await joining;
      await deleting;
    }
    expect(await storedInviterFacts(f.room.id)).toEqual([{ _inviterMemberId: f.inviter.id }]);
    await dispatch();
    for (const row of await payloads(f.member.id)) expectOmitted(row.payload);
  });

  it('a join waiting behind real erasure captures no inviter profile', async () => {
    const f = await invitationFixture();
    const locked = deferred();
    const release = deferred();
    let pid = 0;
    const original = cleanup.enqueue.bind(cleanup);
    const pause = vi.spyOn(cleanup, 'enqueue').mockImplementation(async (tx, entries, options) => {
      pid = (
        await (tx as Parameters<Parameters<typeof db.transaction>[0]>[0]).execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        )
      ).rows[0]!.pid;
      locked.resolve();
      await release.promise;
      return original(tx, entries, options);
    });
    const deleting = erase(f.host.id);
    let joining: ReturnType<typeof join> | undefined;
    try {
      await locked.promise;
      joining = join(f);
      await waitForBlocker(pid);
    } finally {
      release.resolve();
      await deleting;
      await joining;
      pause.mockRestore();
    }
    expect(await storedInviterFacts(f.room.id)).toEqual([{}]);
    await dispatch();
    for (const row of await payloads(f.member.id)) expectOmitted(row.payload);
  });

  it.each([true, false])(
    'fan-out of a pre-erasure event (snapshot=%s) cannot restore stale facts in another inbox',
    async (snapshot) => {
      const f = await invitationFixture();
      await join(f);
      if (!snapshot)
        await pool.query(
          "update outbox_events set payload=payload-'notificationFacts' where resource_id=$1",
          [f.room.id],
        );
      const loaded = deferred();
      const release = deferred();
      const worker = new OutboxDispatcher(db, new FakePush());
      const seam = worker as unknown as { stageCohort: (...args: unknown[]) => Promise<unknown> };
      const original = seam.stageCohort.bind(worker);
      const pause = vi.spyOn(seam, 'stageCohort').mockImplementation(async (...args) => {
        loaded.resolve();
        await release.promise;
        return original(...args);
      });
      const dispatching = worker.dispatchBatch(100);
      try {
        await loaded.promise;
        await erase(f.host.id);
      } finally {
        release.resolve();
        await dispatching;
        pause.mockRestore();
      }
      const rows = (
        await pool.query('select payload from notifications where user_id=$1', [f.member.id])
      ).rows;
      expect(rows).toHaveLength(1);
      expectOmitted(rows[0].payload);
      expect(await storedInviterFacts(f.room.id)).toEqual(
        snapshot ? [{ _inviterMemberId: f.inviter.id }] : [],
      );
    },
  );
});
