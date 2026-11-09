import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { FakePush } from '@gogo/providers';
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
      const facts = (await payloads(f.member.id)).find((r) => r.kind === 'date_reminder')!.payload;
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
    expect(legacy).toHaveLength(2);
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
