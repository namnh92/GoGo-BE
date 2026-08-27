import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { PushPort } from '@gogo/providers';

type NotificationKind = (typeof schema.notifications.$inferSelect)['kind'];

/** Which domain events fan out to which member notifications (BE-BFF-010). */
const EVENT_TO_NOTIFICATION: Record<
  string,
  { kind: NotificationKind; audience: 'host' | 'members' }
> = {
  'member.joined': { kind: 'invite', audience: 'host' },
  'preferences.completed': { kind: 'preference_reminder', audience: 'host' },
  'plan.published': { kind: 'plan_ready', audience: 'members' },
  'plan.changed': { kind: 'plan_changed', audience: 'members' },
  'room.status_active': { kind: 'date_reminder', audience: 'members' },
};

/**
 * Outbox consumer: at-least-once, idempotent per event (an event is only
 * fanned out once because publishing marks it). Plain class — the worker
 * process wires it without Nest.
 */
export class OutboxDispatcher {
  constructor(
    private readonly db: Db,
    private readonly push: PushPort,
  ) {}

  /** Process one batch. Returns number of events handled. */
  async dispatchBatch(limit = 50): Promise<number> {
    const events = await this.db
      .select()
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.publishedAt))
      .orderBy(asc(schema.outboxEvents.occurredAt))
      .limit(limit);

    for (const event of events) {
      try {
        await this.fanOut(event);
        await this.db
          .update(schema.outboxEvents)
          .set({ publishedAt: sql`now()` })
          .where(eq(schema.outboxEvents.id, event.id));
      } catch (err) {
        await this.db
          .update(schema.outboxEvents)
          .set({
            attempts: sql`${schema.outboxEvents.attempts} + 1`,
            lastError: String(err).slice(0, 500),
          })
          .where(eq(schema.outboxEvents.id, event.id));
      }
    }
    return events.length;
  }

  private async fanOut(event: typeof schema.outboxEvents.$inferSelect): Promise<void> {
    const mapping = EVENT_TO_NOTIFICATION[event.eventType];
    if (!mapping) return; // analytics-only event

    // Resolve the room whichever resource the event hangs off.
    let roomId: string | null = null;
    if (event.resourceType === 'room') roomId = event.resourceId;
    else if (event.resourceType === 'plan') {
      const [plan] = await this.db
        .select({ roomId: schema.plans.roomId })
        .from(schema.plans)
        .where(eq(schema.plans.id, event.resourceId))
        .limit(1);
      roomId = plan?.roomId ?? null;
    }
    if (!roomId) return;

    const members = await this.db
      .select()
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), isNull(schema.roomMembers.removedAt)));
    const targets = members.filter((m) => {
      if (m.userId === null) return false; // guests have no push/in-app inbox
      return mapping.audience === 'host' ? m.role === 'host' : true;
    });
    if (targets.length === 0) return;

    const userIds = targets.map((t) => t.userId!) as string[];
    // FR-USER-004: respect per-kind opt-outs (default enabled).
    const prefs = await this.db
      .select()
      .from(schema.notificationPreferences)
      .where(
        and(
          inArray(schema.notificationPreferences.userId, userIds),
          eq(schema.notificationPreferences.kind, mapping.kind),
        ),
      );
    const optedOutInApp = new Set(
      prefs.filter((p) => p.channel === 'push' && !p.enabled).map((p) => p.userId),
    );

    for (const userId of userIds) {
      await this.db.insert(schema.notifications).values({
        userId,
        kind: mapping.kind,
        payload: { eventType: event.eventType, roomId, resourceId: event.resourceId },
      });
      if (optedOutInApp.has(userId)) continue;
      const tokens = await this.db
        .select()
        .from(schema.deviceTokens)
        .where(eq(schema.deviceTokens.userId, userId));
      for (const t of tokens) {
        // Copy is composed client-side from kind + payload; push carries the
        // routing facts only.
        await this.push.send(t.token, {
          title: 'GoGo',
          body: mapping.kind,
          data: { kind: mapping.kind, roomId },
        });
      }
    }
  }
}
