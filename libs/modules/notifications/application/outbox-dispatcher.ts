import { NOTIFICATION_REGISTRY, registration } from '../domain/notification-registry';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import {
  ProviderUnavailableError,
  idempotencyKeyFrom,
  type NotificationProviderPort,
  type UserNotification,
} from '@gogo/providers';
import {
  inboxTarget,
  opensPlan,
  pushLocaleOf,
  pushTarget,
  renderPushNotification,
  type PushKind,
} from './notification-templates';
import { kindPushAllowed } from './push-preference';
import { notificationFacts } from './notification-payload';
import { deferPushDuringQuiet } from './quiet-hours';

/** Invalid/missing event identity reaches nobody and never falls back to current host. */
function transferredMemberId(payload: unknown): string | null {
  const id =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).newHostMemberId
      : null;
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : null;
}

/** Which domain events fan out to which member notifications (BE-BFF-010). */
export const EVENT_TO_NOTIFICATION = {
  ...Object.fromEntries(
    Object.entries(NOTIFICATION_REGISTRY).flatMap(([kind, entry]) =>
      'audience' in entry && entry.producer
        ? [[entry.producer, { kind: kind as PushKind, audience: entry.audience }]]
        : [],
    ),
  ),
  // Drain already-staged legacy work to suppression, without new inbox or push.
  // Historical room_started facts remain readable; only the advance job reminds.
  'room.status_active': { kind: 'date_reminder', audience: 'members' },
} as Record<string, { kind: PushKind; audience: 'host' | 'members' | 'transferred_member' }>;

/** Stable UUID provider key, independent of locale and changing recipient cohorts. */
export function recipientPushKey(eventId: string, userId: string): string {
  return idempotencyKeyFrom(`gogo:notification:${eventId}:${userId}`);
}

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
 *
 * One recipient per event still carries the bare event id, the key the previous
 * release wrote (see `fanOut`). Everyone else carries this one.
 */
export const outboxDedupeKey = (eventId: string, userId: string): string =>
  `outbox:${eventId}:${userId}`;

/**
 * Outbox consumer: at-least-once, so fan-out has to be repeatable rather than
 * merely rare. Every notification carries the event and its recipient as a
 * dedupe key, which makes a redelivery a no-op instead of a duplicate in
 * someone's inbox. Push state and provider keys are per event/recipient
 * after the explicit legacy-key drain gate (ADR-0050).
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
    const gate = await this.db.execute<{ recipient_keys_enabled: boolean; writes_frozen: boolean }>(
      sql`select recipient_keys_enabled, writes_frozen from notification_category_rollout where singleton`,
    );
    if (!gate.rows[0]?.recipient_keys_enabled || gate.rows[0].writes_frozen) return 0;
    // Due, unpublished, not dead-lettered. Before `next_attempt_at` existed
    // this selected the same failing event on every tick.
    const events = await this.db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          sql`${schema.outboxEvents.eventType} <> 'assistant.cost_reconcile'`,
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
            lastError:
              err instanceof ProviderUnavailableError
                ? 'provider_unavailable'
                : 'notification_dispatch_failed',
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

  async dispatchDeferredBatch(limit = 50): Promise<number> {
    const gate = await this.db.execute(sql`select 1 from notification_category_rollout
      where singleton and recipient_keys_enabled and not writes_frozen`);
    if (!gate.rows[0]) return 0;
    const due = await this.db.execute<{ event_id: string }>(sql`select distinct event_id
      from notification_push_deliveries where
        (status = 'deferred' and deferred_until <= now()) or
        (status = 'attempting' and lease_until < now())
      order by event_id limit ${limit}`);
    for (const row of due.rows) {
      const [event] = await this.db
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, row.event_id));
      if (!event) continue;
      const mapping = Object.hasOwn(EVENT_TO_NOTIFICATION, event.eventType)
        ? EVENT_TO_NOTIFICATION[event.eventType]
        : undefined;
      if (!mapping) continue;
      const roomId =
        event.resourceType === 'room'
          ? event.resourceId
          : ((
              await this.db
                .select({ roomId: schema.plans.roomId })
                .from(schema.plans)
                .where(eq(schema.plans.id, event.resourceId))
            )[0]?.roomId ?? null);
      try {
        await this.drainDeliveries(event, mapping, roomId, null);
      } catch {
        // No re-fanout, no reset of event retry budget while merely waiting.
        // Failed deferred attempts retry with the SAME event/recipient provider key.
        this.metrics?.increment('notification_deferred_retry_total', {
          kind: mapping.kind,
          category: registration(mapping.kind).category,
        });
      }
    }
    return due.rows.length;
  }

  private async fanOut(event: typeof schema.outboxEvents.$inferSelect): Promise<void> {
    const mapping = Object.hasOwn(EVENT_TO_NOTIFICATION, event.eventType)
      ? EVENT_TO_NOTIFICATION[event.eventType]
      : undefined;
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
    // #817 F-04 — two sets, deliberately. The cohort this attempt stages is
    // whoever is a live member now. The recipients this attempt must resolve are
    // whoever the ledger holds for the event: a recipient an earlier attempt
    // staged who has since left the room or been erased is still owed a terminal
    // row, and the event publishes only when every ledger row is terminal.
    const relevant =
      event.eventType !== 'room.status_active' &&
      (event.eventType !== 'room.reminder_due' ||
        (
          await this.db.execute(sql`
      select 1 from notification_reminder_jobs j join rooms r on r.id = j.room_id
      join room_constraints rc on rc.room_id = r.id and rc.version = r.constraint_version
      where j.id = ${event.id}::uuid and j.status = 'emitted' and rc.start_at = j.starts_at
        and r.status in ('collecting', 'matching', 'ready') and j.starts_at > clock_timestamp()`)
        ).rows.length > 0);
    const staged = roomId && relevant ? await this.stageCohort(event, mapping, roomId) : null;
    await this.drainDeliveries(event, mapping, roomId, staged);
  }

  /**
   * Inbox rows and pending push work for the current cohort. Null when the event
   * reaches nobody now; ledger rows from earlier attempts are drained regardless.
   */
  private async stageCohort(
    event: typeof schema.outboxEvents.$inferSelect,
    mapping: (typeof EVENT_TO_NOTIFICATION)[string],
    roomId: string,
  ): Promise<{
    localeOf: Map<string, ReturnType<typeof pushLocaleOf>>;
    currentPlanId: string | null;
  } | null> {
    const [room] = await this.db
      .select({ title: schema.rooms.title })
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .limit(1);

    const members = await this.db
      .select()
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), isNull(schema.roomMembers.removedAt)));
    const targets = members.filter((m) => {
      if (m.userId === null) return false; // guests have no push/in-app inbox
      if (mapping.audience === 'transferred_member')
        return m.id === transferredMemberId(event.payload);
      return mapping.audience === 'host' ? m.role === 'host' : true;
    });
    if (targets.length === 0) return null;

    const memberIds = targets.map((t) => t.userId!) as string[];
    // Master and category gate push work independently of the inbox below.
    // #594: the same read carries each recipient's account locale, which
    // decides the copy below (spec §39).
    const pushRows = await this.db
      .select({
        id: schema.users.id,
        locale: schema.users.locale,
      })
      .from(schema.users)
      .where(and(inArray(schema.users.id, memberIds), sql`${schema.users.status} <> 'deleted'`));
    // Erasure retains room memberships. Only live accounts may receive inbox
    // rows or push, including when an old event is retried after deletion.
    const liveIds = new Set(pushRows.map((row) => row.id));
    const userIds = memberIds.filter((id) => liveIds.has(id));
    if (userIds.length === 0) return null;
    const localeOf = new Map(pushRows.map((row) => [row.id, pushLocaleOf(row.locale)]));

    // A plan kind opens the room's current plan. An edit or a regenerate writes
    // a new plan row, so the plan id an event names may already be superseded.
    let currentPlanId: string | null = null;
    let currentPlanCounts: { stopCount: number; optionalStopCount: number } | null = null;
    if (opensPlan(mapping.kind)) {
      const [current] = await this.db
        .select({
          id: schema.plans.id,
          stopCount: sql<number>`(
            select count(*)::int from ${schema.planStops}
            where ${schema.planStops.planId} = ${schema.plans.id}
          )`,
          optionalStopCount: sql<number>`(
            select count(*)::int from ${schema.planStops}
            where ${schema.planStops.planId} = ${schema.plans.id}
              and ${schema.planStops.isOptional} = true
          )`,
        })
        .from(schema.plans)
        .where(and(eq(schema.plans.roomId, roomId), eq(schema.plans.status, 'current')))
        .limit(1);
      currentPlanId = current?.id ?? null;
      currentPlanCounts = current
        ? { stopCount: current.stopCount, optionalStopCount: current.optionalStopCount }
        : null;
    }

    // #584 — one inbox row per recipient, whichever release writes it.
    //
    // The previous release wrote every recipient under the bare event id, so
    // only its first insert landed. It can still run this event: after a
    // rollback, or when a worker it lost its lease to is still finishing. So one
    // recipient keeps the bare event id, written first. Once that row exists,
    // every insert the previous release makes for this event conflicts on the
    // global index and writes nothing, and whoever owns the row — this release's
    // pick or the previous release's first recipient — is that person's row.
    // Everyone else gets a key of their own.
    //
    // #609: the row also carries where it opens, in the same shape as the push
    // data (`route`, `entityType`, `entityId`), so the inbox and a tapped push
    // route one way. `resourceId` stays for clients that already read it.
    const payload: Record<string, unknown> = {
      eventType: event.eventType,
      roomId,
      resourceId: event.resourceId,
      ...inboxTarget(pushTarget(mapping.kind, roomId, currentPlanId)),
      ...notificationFacts(mapping.kind, {
        roomName: room?.title ?? null,
        members,
        currentPlanCounts,
        eventPayload: event.payload as Record<string, unknown>,
      }),
    };
    for (const fact of ['reminder', 'planPreview', 'inviterAvatar'] as const) {
      this.metrics?.increment('notification_event_facts_total', {
        kind: mapping.kind,
        fact,
        present: String(Object.hasOwn(payload, fact)),
      });
    }
    // Keep independently durable inbox writes for events without inviter PII:
    // a failed fan-out can leave a prefix for the next attempt to complete.
    const writeInbox = async (db: Pick<Db, 'select' | 'insert'>) => {
      const existing = await db
        .select({ userId: schema.notifications.userId })
        .from(schema.notifications)
        .where(
          inArray(schema.notifications.dedupeKey, [
            event.id,
            ...userIds.map((userId) => outboxDedupeKey(event.id, userId)),
          ]),
        );
      const withRow = new Set(existing.map((row) => row.userId));
      // Never someone who already has a row: the bare key must not become a
      // second row for them.
      const legacyCandidate = userIds.find((userId) => !withRow.has(userId));
      if (legacyCandidate) {
        await db
          .insert(schema.notifications)
          .values({ userId: legacyCandidate, kind: mapping.kind, payload, dedupeKey: event.id })
          .onConflictDoNothing();
      }
      const [legacyOwner] = await db
        .select({ userId: schema.notifications.userId })
        .from(schema.notifications)
        .where(eq(schema.notifications.dedupeKey, event.id))
        .limit(1);

      for (const userId of userIds) {
        if (userId === legacyOwner?.userId) continue;
        await db
          .insert(schema.notifications)
          .values({
            userId,
            kind: mapping.kind,
            payload,
            dedupeKey: outboxDedupeKey(event.id, userId),
          })
          // Redelivery must not put the same notification in an inbox twice.
          .onConflictDoNothing();
      }
    };
    const eventPayload = event.payload as Record<string, unknown>;
    const inviterMemberId =
      mapping.kind === 'invite'
        ? ((eventPayload.notificationFacts as { _inviterMemberId?: string } | undefined)
            ?._inviterMemberId ??
          (typeof eventPayload.inviterMemberId === 'string'
            ? eventPayload.inviterMemberId
            : undefined))
        : undefined;
    if (inviterMemberId) {
      // A worker may have loaded the event before erasure scrubbed its stored
      // snapshot. Lock accounts before inbox rows in stable order and recheck
      // the inviter under capture/erasure's fence, only through inbox writes.
      await this.db.transaction(async (tx) => {
        const accounts = await tx.execute<{ id: string; status: string }>(sql`
          select id, status from users
          where id in (${sql.join(
            userIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) or id = (select user_id from room_members where id = ${inviterMemberId}::uuid)
          order by id for share
        `);
        const inviter = await tx.execute<{ user_id: string | null }>(sql`
          select user_id from room_members where id = ${inviterMemberId}::uuid
        `);
        const userId = inviter.rows[0]?.user_id;
        if (userId && !accounts.rows.some((row) => row.id === userId && row.status !== 'deleted')) {
          delete payload.inviterName;
          delete payload.inviterAvatar;
        }
        await writeInbox(tx);
      });
    } else if (mapping.audience === 'transferred_member') {
      await this.db.transaction(async (tx) => {
        const live =
          await tx.execute(sql`select u.id from users u join room_members rm on rm.user_id = u.id
          where rm.id = ${transferredMemberId(event.payload)}::uuid
            and rm.room_id = ${roomId}::uuid and rm.removed_at is null and u.status <> 'deleted' for share of u, rm`);
        if (live.rows.length) await writeInbox(tx);
      });
    } else {
      await writeInbox(this.db);
    }

    for (const userId of userIds) {
      // Preference gating happens before pending delivery work is created. A
      // suppression is durable, so a later opt-in cannot resurrect a retry.
      const staged = await this.db.transaction(async (tx) => {
        const live = await tx.execute(
          sql`select id from users where id = ${userId}::uuid and status <> 'deleted' for share`,
        );
        if (!live.rows[0]) return;
        if (mapping.audience === 'transferred_member') {
          const member =
            await tx.execute(sql`select id from room_members where id = ${transferredMemberId(event.payload)}::uuid
            and room_id = ${roomId}::uuid and user_id = ${userId}::uuid and removed_at is null for share`);
          if (!member.rows.length) return;
        }
        const inserted = await tx.execute<{
          status: string;
        }>(sql`insert into notification_push_deliveries(event_id, user_id, status)
          select ${event.id}::uuid, ${userId}::uuid,
            case when ${kindPushAllowed(sql`${userId}::uuid`, mapping.kind)} then 'pending' else 'suppressed' end
          on conflict do nothing returning status`);
        return inserted.rows[0]?.status;
      });
      if (staged)
        this.metrics?.increment('notification_push_enqueue_total', {
          kind: mapping.kind,
          category: registration(mapping.kind).category,
          outcome: staged,
        });
      if (staged === 'suppressed')
        this.metrics?.increment('notification_push_suppressed_total', {
          kind: mapping.kind,
          category: registration(mapping.kind).category,
          reason: 'preference',
        });
    }
    // The entire cohort is staged before the first provider attempt: an early
    // outage must not allow a later opt-in to resurrect another recipient.
    return { localeOf, currentPlanId };
  }

  /**
   * Every pending recipient of the event, whichever attempt staged it, is
   * claimed, rechecked and closed here. A recipient outside today's cohort
   * fails the membership check and ends `suppressed`, which is terminal: the
   * ledger never keeps a row the gates would have to wait for.
   */
  private async drainDeliveries(
    event: typeof schema.outboxEvents.$inferSelect,
    mapping: (typeof EVENT_TO_NOTIFICATION)[string],
    roomId: string | null,
    staged: Awaited<ReturnType<OutboxDispatcher['stageCohort']>>,
  ): Promise<void> {
    const ledger = await this.db.execute<{
      user_id: string;
      deferred_until: string | null;
    }>(sql`select user_id, deferred_until from notification_push_deliveries
      where event_id = ${event.id}::uuid and (status in ('pending', 'attempting') or (status = 'deferred' and deferred_until <= now())) order by user_id`);
    for (const { user_id: userId, deferred_until: deferredUntil } of ledger.rows) {
      const claimed = await this.db.execute(sql`update notification_push_deliveries
        set status = 'attempting', lease_until = now() + interval '2 minutes', updated_at = now()
        where event_id = ${event.id}::uuid and user_id = ${userId}::uuid and
          (status = 'pending' or (status = 'deferred' and deferred_until <= now()) or (status = 'attempting' and lease_until < now())) returning user_id`);
      if (!claimed.rows[0]) {
        const active = await this.db.execute(sql`select 1 from notification_push_deliveries
          where event_id = ${event.id}::uuid and user_id = ${userId}::uuid and status = 'attempting'`);
        if (active.rows[0]) throw new ProviderUnavailableError('notification_delivery_in_flight');
        continue;
      }
      // Final eligibility snapshot immediately before the provider call, on every
      // retry. No transaction/lock is held across the external request. A
      // recipient outside this attempt's cohort reads its locale here; without a
      // room there is no membership to hold, so nobody is eligible.
      const eligible = roomId
        ? await this.db.execute<{
            id: string;
            locale: string | null;
          }>(sql`select u.id, u.locale from users u
          where u.id = ${userId}::uuid and u.status <> 'deleted'
            and ${kindPushAllowed(sql`u.id`, mapping.kind)}
            and ${event.eventType !== 'room.status_active'}
            ${
              event.eventType === 'room.reminder_due'
                ? sql`and exists (
              select 1 from notification_reminder_jobs j join rooms r on r.id = j.room_id
              join room_constraints rc on rc.room_id = r.id and rc.version = r.constraint_version
              where j.id = ${event.id}::uuid and j.status = 'emitted' and rc.start_at = j.starts_at
                and r.status in ('collecting', 'matching', 'ready') and j.starts_at > clock_timestamp()
            )`
                : sql``
            }
            and exists (select 1 from room_members rm where rm.user_id = u.id
              and rm.room_id = ${roomId}::uuid and rm.removed_at is null
              ${mapping.audience === 'host' ? sql`and rm.role = 'host'` : mapping.audience === 'transferred_member' ? sql`and rm.id = ${transferredMemberId(event.payload)}::uuid` : sql``})`)
        : { rows: [] as { id: string; locale: string | null }[] };
      let status = 'suppressed';
      try {
        const recipient = eligible.rows[0];
        if (recipient && roomId) {
          const until = await deferPushDuringQuiet(this.db, userId, (tx, until) =>
            tx.execute(sql`update notification_push_deliveries
              set status = 'deferred', deferred_until = ${until.toISOString()}::timestamptz,
                lease_until = null, updated_at = now()
              where event_id = ${event.id}::uuid and user_id = ${userId}::uuid and status = 'attempting'`),
          );
          if (until) {
            this.metrics?.increment('notification_push_deferred_total', {
              kind: mapping.kind,
              category: registration(mapping.kind).category,
              reason: 'quiet_hours',
            });
            continue;
          }
          const locale = staged?.localeOf.get(userId) ?? pushLocaleOf(recipient.locale);
          const currentPlanId =
            staged?.currentPlanId ??
            (
              await this.db
                .select({ id: schema.plans.id })
                .from(schema.plans)
                .where(and(eq(schema.plans.roomId, roomId), eq(schema.plans.status, 'current')))
                .limit(1)
            )[0]?.id ??
            null;
          status = await this.sendPush([userId], mapping.kind, {
            ...renderPushNotification({
              kind: mapping.kind,
              locale,
              event,
              roomId,
              currentPlanId,
            }),
            idempotencyKey: recipientPushKey(event.id, userId),
          });
        } else
          this.metrics?.increment('notification_push_suppressed_total', {
            kind: mapping.kind,
            category: registration(mapping.kind).category,
            reason: 'final_eligibility',
          });
      } catch (error) {
        // Existing producers retain the event's retry/backoff budget until work
        // has actually entered quiet-hour deferral. A provider outage alone must
        // not move their pending cohort behind a second, independent timer
        // (#817 F-04). PR4 advance reminders and already-deferred deliveries own
        // their bounded retries in the ledger, including after outbox publication.
        if (event.eventType !== 'room.reminder_due' && deferredUntil == null) {
          await this.db.execute(sql`update notification_push_deliveries
            set status = 'pending', lease_until = null, updated_at = now()
            where event_id = ${event.id}::uuid and user_id = ${userId}::uuid and status = 'attempting'`);
          throw error;
        }
        const failed = await this.db.execute<{
          status: string;
        }>(sql`update notification_push_deliveries
          set deferred_attempts = deferred_attempts + 1,
            status = case when deferred_attempts + 1 >= ${MAX_DELIVERY_ATTEMPTS} then 'failed' else 'deferred' end,
            deferred_until = now() + make_interval(secs => least(1200, 20 * power(4, deferred_attempts))::int),
            lease_until = null, updated_at = now()
          where event_id = ${event.id}::uuid and user_id = ${userId}::uuid and status = 'attempting' returning status`);
        if (failed.rows[0]?.status === 'failed')
          this.metrics?.increment('notification_deferred_dead_letter_total', {
            kind: mapping.kind,
            category: registration(mapping.kind).category,
          });
        else
          this.metrics?.increment('notification_deferred_retry_total', {
            kind: mapping.kind,
            category: registration(mapping.kind).category,
          });
        // The durable ledger owns these retries. Finish staging/draining the
        // remaining recipients and publish without spending the event budget.
        continue;
      }
      this.metrics?.increment('notification_push_outcome_total', {
        kind: mapping.kind,
        category: registration(mapping.kind).category,
        outcome: status,
      });
      await this.db
        .execute(sql`update notification_push_deliveries set status = ${status}, lease_until = null, updated_at = now()
        where event_id = ${event.id}::uuid and user_id = ${userId}::uuid and status = 'attempting'`);
    }
    // Inbox fan-out is complete. Deferred work is owned by its durable ledger,
    // so waiting for morning does not consume the outbox failure budget. Pending
    // or leased work still prevents publication until its staging attempt ends.
    const unresolved = await this.db.execute(sql`select 1 from notification_push_deliveries
      where event_id = ${event.id}::uuid and status in ('pending', 'attempting') limit 1`);
    if (unresolved.rows[0]) throw new ProviderUnavailableError('notification_delivery_in_flight');
  }

  private async sendPush(
    recipients: string[],
    pushKind: PushKind,
    notification: UserNotification,
  ): Promise<'sent' | 'failed' | 'no_target'> {
    try {
      const result = await this.push.sendToUsers(recipients, notification);
      // Review fix (#193): "sent" is a message the provider created. A 200
      // with no message id means nobody in the request was subscribed — counted
      // apart, so a fleet of never-logged-in users cannot look like delivery.
      if (result.providerMessageIds.length > 0) {
        this.metrics?.increment(
          'push_delivery_sent_total',
          { kind: pushKind },
          result.providerMessageIds.length,
        );
      }
      if (result.emptyResponses > 0) {
        this.metrics?.increment(
          'push_delivery_no_target_total',
          { kind: pushKind },
          result.emptyResponses,
        );
      }
      if (result.unknownUserIds.length > 0) {
        this.metrics?.increment(
          'push_delivery_unknown_user_total',
          { kind: pushKind },
          result.unknownUserIds.length,
        );
      }
      return result.providerMessageIds.length > 0 && !result.unknownUserIds.includes(recipients[0]!)
        ? 'sent'
        : 'no_target';
    } catch (err) {
      // Transient (the resilience wrapper gave up): let the outbox back off and
      // try the event again. The notification rows above are idempotent and the
      // provider key makes the re-send a replay, so the retry is safe.
      if (err instanceof ProviderUnavailableError) throw err;
      // Permanent (refused credential, rejected payload): retrying produces the
      // same answer. Count it, keep the in-app notification as the durable
      // half, and let the event publish.
      this.metrics?.increment('push_delivery_failed_total', { kind: pushKind });
      return 'failed';
    }
  }
}
