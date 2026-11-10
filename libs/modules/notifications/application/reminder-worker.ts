import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { capturePlanPreview } from '../../shared/notification-event-facts';
import { REMINDER_LEAD_SECONDS, syncReminderSchedule } from '../../shared/reminder-schedule';

/** Invoked under startPeriodic's WorkerLease, never advisory locks. All progress
 * lives in PostgreSQL; job -> outbox is atomic and the job ID is the event ID.
 */
export class ReminderWorker {
  constructor(
    private readonly db: Db,
    private readonly metrics?: {
      increment(name: string, labels?: Record<string, string>, by?: number): void;
    },
  ) {}

  async runTick(limit = 50): Promise<number> {
    // Bounded, restartable rollout of schedules that predate PR4. Never rewrite
    // historical payloads. Writers immediately maintain new schedules themselves.
    const missing = await this.db.execute<{ id: string }>(sql`select r.id from rooms r
      join room_constraints rc on rc.room_id = r.id and rc.version = r.constraint_version
      where r.status in ('collecting', 'matching', 'ready') and rc.start_at > now()
        and not exists (select 1 from notification_reminder_jobs j where j.room_id = r.id and j.starts_at = rc.start_at)
      order by rc.start_at, r.id limit ${limit}`);
    for (const { id } of missing.rows)
      await this.db.transaction((tx) => syncReminderSchedule(tx, id));

    const due = await this.db.execute<{ id: string; room_id: string }>(sql`
      select id, room_id from notification_reminder_jobs
      where status = 'pending' and scheduled_for <= now() order by scheduled_for, id limit ${limit}`);
    let emitted = 0;
    for (const candidate of due.rows) {
      const outcome = await this.db.transaction(async (tx) => {
        // Reconcile under the room lock before taking a job lock (same order as writers).
        await syncReminderSchedule(tx, candidate.room_id);
        const jobs = await tx.execute<{ id: string; starts_at: string; scheduled_for: string }>(sql`
          select id, starts_at, scheduled_for from notification_reminder_jobs
          where id = ${candidate.id}::uuid and status = 'pending' and scheduled_for <= clock_timestamp()
          for update skip locked`);
        const job = jobs.rows[0];
        if (!job) return 'cancelled';
        // Keep room/job -> rollout lock order, matching business writers.
        // Same lock as migration 0094's producer trigger. A freeze either wins
        // before this read (leave the job pending) or waits for our atomic
        // job -> outbox commit. It cannot race the insert and abort draining.
        const gate = await tx.execute<{ producers_frozen: boolean }>(sql`
          select producers_frozen from notification_category_rollout where singleton for share`);
        if (!gate.rows[0] || gate.rows[0].producers_frozen) return 'frozen';
        const plans = await tx.execute<{
          id: string;
        }>(sql`select p.id from plans p join rooms r on r.id = p.room_id
          where p.room_id = ${candidate.room_id}::uuid and p.status = 'current'
            and not p.is_stale and p.constraint_version = r.constraint_version limit 1`);
        const preview = plans.rows[0]
          ? await capturePlanPreview(tx, candidate.room_id, plans.rows[0].id)
          : undefined;
        const payload = {
          notificationFacts: {
            reminder: {
              trigger: 'scheduled',
              triggeredAt: new Date().toISOString(),
              scheduledFor: new Date(job.scheduled_for).toISOString(),
              startsAt: new Date(job.starts_at).toISOString(),
              leadTimeSeconds: REMINDER_LEAD_SECONDS,
              scheduleRevision: job.id,
            },
            ...(preview ? { planPreview: preview } : {}),
          },
        };
        await tx.execute(sql`insert into outbox_events(id, event_type, resource_type, resource_id, payload, payload_schema_version)
          values (${job.id}::uuid, 'room.reminder_due', 'room', ${candidate.room_id}::uuid, ${JSON.stringify(payload)}::jsonb, 1)
          on conflict(id) do nothing`);
        await tx.execute(
          sql`update notification_reminder_jobs set status = 'emitted', updated_at = now() where id = ${job.id}::uuid`,
        );
        return 'emitted';
      });
      this.metrics?.increment('notification_reminder_jobs_total', { outcome });
      if (outcome === 'emitted') emitted++;
    }
    return emitted;
  }
}
