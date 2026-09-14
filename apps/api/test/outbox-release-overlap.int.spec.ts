import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { OutboxDispatcher } from '@gogo/modules';
import { FakePush } from '@gogo/providers';

/**
 * #584 (NTF-BE-015) — the release before this change and this release writing
 * inbox rows for the same outbox event.
 *
 * Two releases touch one event when a deploy or a rollback replaces the worker
 * while an event is unpublished: a fan-out that was killed before
 * `published_at` is redelivered by whichever release runs next. They run at the
 * same time only if a worker loses its lease mid-batch.
 *
 * `previousReleaseInsertLoop` is the inbox loop of the previous release, copied
 * verbatim from `libs/modules/notifications/application/outbox-dispatcher.ts`
 * lines 142–153 on develop `da6a89e` (the member lookup above it is unchanged
 * and reproduced by the callers). Its `onConflictDoNothing()` has no target, so
 * both unique indexes arbitrate: `notifications_dedupe_idx (user_id,
 * dedupe_key)` from 0017 and the global `notifications_dedupe_unique
 * (dedupe_key)` from 0026.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_outbox_overlap')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

type OutboxEvent = typeof schema.outboxEvents.$inferSelect;
const KIND = 'plan_ready' as const;

let seq = 0;
async function roomOf(recipients: number) {
  const tag = `ov${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const userIds: string[] = [];
  for (let i = 0; i < recipients; i++) {
    const inserted = await pool.query(
      'insert into users (email, display_name) values ($1, $2) returning id',
      [`${tag}-${i}@overlap.gogo.test`, `${tag}-${i}`],
    );
    userIds.push(inserted.rows[0].id as string);
  }
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: `OV${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      type: 'group',
      decisionMode: 'vote',
      participantCount: recipients,
      status: 'collecting',
      hostUserId: userIds[0]!,
    })
    .returning();
  for (const [i, userId] of userIds.entries()) {
    await db.insert(schema.roomMembers).values({
      roomId: room!.id,
      userId,
      role: i === 0 ? 'host' : 'member',
      displayName: `M${i}`,
    });
  }
  const [event] = await db
    .insert(schema.outboxEvents)
    .values({
      eventType: 'plan.published',
      resourceType: 'room',
      resourceId: room!.id,
      payload: {},
    })
    .returning();
  return { roomId: room!.id, userIds, event: event! };
}

/** Develop `da6a89e`, outbox-dispatcher.ts:142–153, verbatim apart from `this.`. */
async function previousReleaseInsertLoop(
  event: OutboxEvent,
  roomId: string,
  userIds: string[],
  options: { stopAfter?: number; order?: string[] } = {},
) {
  const mapping = { kind: KIND };
  let written = 0;
  for (const userId of options.order ?? userIds) {
    if (written >= (options.stopAfter ?? Infinity)) throw new Error('worker killed');
    written += 1;
    await db
      .insert(schema.notifications)
      .values({
        userId,
        kind: mapping.kind,
        payload: { eventType: event.eventType, roomId, resourceId: event.resourceId },
        dedupeKey: event.id,
      })
      // Redelivery must not put the same notification in an inbox twice.
      .onConflictDoNothing();
  }
}

/** A previous-release worker that fans out and is killed before marking the event. */
async function previousReleaseKilledBeforeMark(
  event: OutboxEvent,
  roomId: string,
  userIds: string[],
  options: { stopAfter?: number; order?: string[] } = {},
) {
  await previousReleaseInsertLoop(event, roomId, userIds, options).catch(() => undefined);
}

async function markUnpublished(eventId: string) {
  await db
    .update(schema.outboxEvents)
    .set({ publishedAt: null, nextAttemptAt: null, attempts: 0 })
    .where(eq(schema.outboxEvents.id, eventId));
}

/** This release, with its inbox writes failing after `allow` successful ones. */
function thisReleaseKilledAfter(allow: number) {
  let inserts = 0;
  const flaky = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === 'insert') {
        return (...args: unknown[]) => {
          inserts += 1;
          if (inserts > allow) throw new Error('worker killed');
          return (db.insert as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return new OutboxDispatcher(flaky as never, new FakePush());
}

/** This release, pausing before its n-th inbox insert until `resume(n)`. */
function thisReleaseGated() {
  const waiters = new Map<number, () => void>();
  const hits = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  const hit = (n: number) => {
    if (!hits.has(n)) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      hits.set(n, { promise, resolve });
    }
    return hits.get(n)!;
  };
  const gate = (n: number) => {
    hit(n).resolve();
    return new Promise<void>((resolve) => waiters.set(n, resolve));
  };
  let inserts = 0;
  const gated = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          const n = ++inserts;
          return {
            values: (values: unknown) => ({
              onConflictDoNothing: () => ({
                then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
                  return gate(n)
                    .then(() =>
                      (
                        db.insert as (t: unknown) => {
                          values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> };
                        }
                      )(table)
                        .values(values)
                        .onConflictDoNothing(),
                    )
                    .then(resolve, reject);
                },
              }),
            }),
          };
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return {
    dispatcher: new OutboxDispatcher(gated as never, new FakePush()),
    /** Resolves once the dispatcher is paused before insert n. */
    reached(n: number) {
      return hit(n).promise;
    },
    resume(n: number) {
      waiters.get(n)?.();
    },
    resumeAll() {
      for (const resolve of waiters.values()) resolve();
    },
  };
}

async function inbox(eventId: string, roomId: string, userIds: string[]) {
  const rows = await db
    .select({ userId: schema.notifications.userId, dedupeKey: schema.notifications.dedupeKey })
    .from(schema.notifications)
    .where(sql`${schema.notifications.payload}->>'resourceId' = ${roomId}`);
  void eventId;
  return userIds.map((id) => rows.filter((row) => row.userId === id).length);
}

const noDuplicates = (counts: number[]) => counts.every((c) => c <= 1);

describe('previous release and this release on one outbox event (#584)', () => {
  it('(a) this release fans out, is killed before marking, and the previous release retries after a rollback', async () => {
    const { roomId, userIds, event } = await roomOf(3);
    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();
    await markUnpublished(event.id);

    await previousReleaseKilledBeforeMark(event, roomId, userIds);

    expect(await inbox(event.id, roomId, userIds)).toEqual([1, 1, 1]);
  });

  it('(b) the previous release fans out, is killed before marking, and this release retries after the deploy', async () => {
    const { roomId, userIds, event } = await roomOf(3);
    await previousReleaseKilledBeforeMark(event, roomId, userIds);

    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();

    expect(await inbox(event.id, roomId, userIds)).toEqual([1, 1, 1]);
  });

  it('(c) both releases on one event at the same time, at every point of this release’s fan-out', async () => {
    for (const pauseAt of [1, 2, 3]) {
      const { roomId, userIds, event } = await roomOf(3);
      const gated = thisReleaseGated();
      const running = gated.dispatcher.dispatchBatch();
      await gated.reached(1);
      // Let this release through its first pauseAt-1 inserts, then run the
      // previous release in full at that point.
      for (let n = 1; n < pauseAt; n++) {
        gated.resume(n);
        await gated.reached(n + 1);
      }
      await previousReleaseKilledBeforeMark(event, roomId, userIds, {
        order: [...userIds].reverse(),
      });
      gated.resumeAll();
      // Later inserts are gated too; keep releasing until the batch finishes.
      const drain = setInterval(() => gated.resumeAll(), 5);
      await running;
      clearInterval(drain);

      const counts = await inbox(event.id, roomId, userIds);
      expect({ pauseAt, counts }).toEqual({ pauseAt, counts: [1, 1, 1] });
    }
  });

  it('(c) both releases racing freely on many events never duplicate a row', async () => {
    const rooms = await Promise.all(Array.from({ length: 12 }, () => roomOf(3)));
    await Promise.all([
      new OutboxDispatcher(db as never, new FakePush()).dispatchBatch(100),
      ...rooms.map(({ roomId, userIds, event }, i) =>
        previousReleaseKilledBeforeMark(event, roomId, userIds, {
          order: i % 2 === 0 ? userIds : [...userIds].reverse(),
        }),
      ),
    ]);
    for (const { roomId, userIds, event } of rooms) {
      const counts = await inbox(event.id, roomId, userIds);
      expect(noDuplicates(counts)).toBe(true);
    }
    // Whatever the race left, this release redelivering completes every inbox.
    for (const { event } of rooms) await markUnpublished(event.id);
    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch(100);
    for (const { roomId, userIds, event } of rooms) {
      expect(await inbox(event.id, roomId, userIds)).toEqual([1, 1, 1]);
    }
  });

  it('(d) this release is killed after one insert and the previous release retries after a rollback', async () => {
    const { roomId, userIds, event } = await roomOf(3);
    await thisReleaseKilledAfter(1).dispatchBatch();
    await markUnpublished(event.id);

    await previousReleaseKilledBeforeMark(event, roomId, userIds);

    const counts = await inbox(event.id, roomId, userIds);
    // Never a duplicate. The previous release cannot deliver past its first
    // recipient — that is the defect #584 fixes — so a rollback that retries
    // an unfinished event leaves the others without a row until this release
    // runs it again.
    expect(noDuplicates(counts)).toBe(true);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);

    await markUnpublished(event.id);
    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();
    expect(await inbox(event.id, roomId, userIds)).toEqual([1, 1, 1]);
  });

  it('(e) the previous release is killed after one insert and this release retries after the deploy', async () => {
    const { roomId, userIds, event } = await roomOf(3);
    await previousReleaseKilledBeforeMark(event, roomId, userIds, { stopAfter: 1 });

    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();

    expect(await inbox(event.id, roomId, userIds)).toEqual([1, 1, 1]);
  });

  it('the legacy key already belongs to a recipient the previous release reached out of order', async () => {
    const { roomId, userIds, event } = await roomOf(3);
    await previousReleaseKilledBeforeMark(event, roomId, userIds, { order: [userIds[2]!] });

    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();
    await markUnpublished(event.id);
    await previousReleaseKilledBeforeMark(event, roomId, userIds);
    await markUnpublished(event.id);
    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();

    expect(await inbox(event.id, roomId, userIds)).toEqual([1, 1, 1]);
  });
  it('(f) the bare-key owner deletes their account before a retry: nobody gets a second row', async () => {
    const { roomId, userIds, event } = await roomOf(3);
    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();
    const [owner] = await db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.dedupeKey, event.id));
    // What account deletion does to this event: the person's notifications go
    // (user-content.service.ts) and they are no longer a member.
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, owner!.userId));
    await db
      .update(schema.roomMembers)
      .set({ removedAt: new Date() })
      .where(
        and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.userId, owner!.userId)),
      );
    await markUnpublished(event.id);

    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();

    const remaining = userIds.filter((id) => id !== owner!.userId);
    expect(await inbox(event.id, roomId, remaining)).toEqual([1, 1]);
    expect(await inbox(event.id, roomId, [owner!.userId])).toEqual([0]);
  });
});
