import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { ProviderUnavailableError, type NotificationProviderPort } from '@gogo/providers';

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
 * Exponential backoff with a ceiling: 5s, 20s, 80s, 320s, 20m, 20m…
 *
 * Retrying a broken event every 5 seconds is not resilience — it burns the
 * batch on the same failure while newer events wait behind it.
 */
export const RETRY_BACKOFF_SECONDS = (attempts: number): number =>
  Math.min(5 * 4 ** attempts, 1200);

/**
 * After this many failures the event is dead-lettered: it stops being selected
 * and stops blocking the queue. Something that has failed six times with
 * backoff is not going to succeed on the seventh; it needs a person.
 */
export const MAX_DELIVERY_ATTEMPTS = 6;

/**
 * #584 — the inbox dedupe key names the recipient as well as the event. The
 * unique index on `notifications.dedupe_key` is global (0026, shared with
 * campaigns), so one key for every recipient let only the first row in.
 */
export const outboxDedupeKey = (eventId: string, userId: string): string =>
  `outbox:${eventId}:${userId}`;

/**
 * Outbox consumer: at-least-once, so fan-out has to be repeatable rather than
 * merely rare. Every notification carries the event and its recipient as a
 * dedupe key, which makes a redelivery a no-op instead of a duplicate in
 * someone's inbox, and every push carries the event id as the provider's
 * idempotency key for the same reason.
 *
 * Plain class — the worker process wires it without Nest.
 */
export class OutboxDispatcher {
  constructor(
    private readonly db: Db,
    private readonly push: NotificationProviderPort,
    private readonly metrics?: {
      increment(name: string, labels?: Record<string, string>, by?: number): void;
    },
  ) {}

  /** Process one batch. Returns number of events handled. */
  async dispatchBatch(limit = 50): Promise<number> {
    // Due, unpublished, not dead-lettered. Before `next_attempt_at` existed
    // this selected the same failing event on every tick.
    const events = await this.db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          isNull(schema.outboxEvents.publishedAt),
          isNull(schema.outboxEvents.failedAt),
          sql`(${schema.outboxEvents.nextAttemptAt} is null
               or ${schema.outboxEvents.nextAttemptAt} <= now())`,
        ),
      )
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
        const attempts = event.attempts + 1;
        const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
        await this.db
          .update(schema.outboxEvents)
          .set({
            attempts,
            lastError: String(err).slice(0, 500),
            nextAttemptAt: exhausted
              ? null
              : sql`now() + make_interval(secs => ${RETRY_BACKOFF_SECONDS(attempts)})`,
            ...(exhausted ? { failedAt: sql`now()` } : {}),
          })
          .where(eq(schema.outboxEvents.id, event.id));
        this.metrics?.increment(
          exhausted ? 'outbox_event_dead_lettered_total' : 'outbox_event_retry_total',
          { event_type: event.eventType },
        );
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
    const optedOutOfPush = new Set(
      prefs.filter((p) => p.channel === 'push' && !p.enabled).map((p) => p.userId),
    );

    // Rows written before #584 carry the bare event id and belong to one
    // recipient. A retry across the deploy must not give that person a second
    // row under the new key.
    const legacyRows = await this.db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.dedupeKey, event.id));
    const alreadyInInbox = new Set(legacyRows.map((row) => row.userId));

    for (const userId of userIds) {
      if (alreadyInInbox.has(userId)) continue;
      await this.db
        .insert(schema.notifications)
        .values({
          userId,
          kind: mapping.kind,
          payload: { eventType: event.eventType, roomId, resourceId: event.resourceId },
          dedupeKey: outboxDedupeKey(event.id, userId),
        })
        // Redelivery must not put the same notification in an inbox twice.
        .onConflictDoNothing();
    }

    // #193: one provider call for the whole event, addressed by user id. The
    // provider owns the device list (spec §26), so there is no per-token loop
    // and no `device_tokens` read on this path any more.
    const recipients = userIds.filter((id) => !optedOutOfPush.has(id));
    if (recipients.length === 0) return;
    try {
      const result = await this.push.sendToUsers(recipients, {
        // Placeholder copy until the template layer lands (NTF-BE-005, #196):
        // the payload contract below is what clients route on. Nothing on the
        // lock screen may carry private content — ids and a kind only.
        headings: { en: 'GoGo' },
        contents: { en: mapping.kind },
        data: { kind: mapping.kind, roomId, eventType: event.eventType },
        // The event id, so a retry of this fan-out is a replay at the provider
        // rather than a second push (30-day window).
        idempotencyKey: event.id,
      });
      // Review fix (#193): "sent" is a message the provider created. A 200
      // with no message id means nobody in the request was subscribed — counted
      // apart, so a fleet of never-logged-in users cannot look like delivery.
      if (result.providerMessageIds.length > 0) {
        this.metrics?.increment(
          'push_delivery_sent_total',
          { kind: mapping.kind },
          result.providerMessageIds.length,
        );
      }
      if (result.emptyResponses > 0) {
        this.metrics?.increment(
          'push_delivery_no_target_total',
          { kind: mapping.kind },
          result.emptyResponses,
        );
      }
      if (result.unknownUserIds.length > 0) {
        this.metrics?.increment(
          'push_delivery_unknown_user_total',
          { kind: mapping.kind },
          result.unknownUserIds.length,
        );
      }
    } catch (err) {
      // Transient (the resilience wrapper gave up): let the outbox back off and
      // try the event again. The notification rows above are idempotent and the
      // provider key makes the re-send a replay, so the retry is safe.
      if (err instanceof ProviderUnavailableError) throw err;
      // Permanent (refused credential, rejected payload): retrying produces the
      // same answer. Count it, keep the in-app notification as the durable
      // half, and let the event publish.
      this.metrics?.increment('push_delivery_failed_total', { kind: mapping.kind });
    }
  }
}
