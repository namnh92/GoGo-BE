import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';

export type PrivacyRunReport = {
  loginAttemptsPurged: number;
  idempotencyKeysPurged: number;
  guestSessionsAnonymized: number;
  originsCleared: number;
};

/**
 * DB-010 — retention/anonymization jobs. Plain class so the worker schedules
 * it daily without Nest; dryRun produces the report without writing.
 */
export class PrivacyJobs {
  constructor(private readonly db: Db) {}

  async run(dryRun = false): Promise<PrivacyRunReport> {
    const report: PrivacyRunReport = {
      loginAttemptsPurged: 0,
      idempotencyKeysPurged: 0,
      guestSessionsAnonymized: 0,
      originsCleared: 0,
    };

    const count = async (query: string): Promise<number> => {
      const res = await this.db.execute(sql.raw(`select count(*)::int as n from (${query}) q`));
      return (res.rows[0] as { n: number }).n;
    };

    // login_attempts: 30-day retention.
    const loginQ = `select id from login_attempts where created_at < now() - interval '30 days'`;
    report.loginAttemptsPurged = await count(loginQ);
    if (!dryRun && report.loginAttemptsPurged > 0) {
      await this.db.execute(
        sql`delete from login_attempts where created_at < now() - interval '30 days'`,
      );
    }

    // idempotency keys past expiry.
    const idemQ = `select key from idempotency_keys where expires_at < now()`;
    report.idempotencyKeysPurged = await count(idemQ);
    if (!dryRun && report.idempotencyKeysPurged > 0) {
      await this.db.execute(sql`delete from idempotency_keys where expires_at < now()`);
    }

    // Expired, unclaimed guest sessions: revoke + anonymize display name
    // (membership rows keep an anonymized label; token hash cleared).
    const guestQ = `select id from guest_sessions
      where expires_at < now() - interval '7 days'
        and claimed_by_user_id is null
        and display_name <> 'Khách ẩn danh'`;
    report.guestSessionsAnonymized = await count(guestQ);
    if (!dryRun && report.guestSessionsAnonymized > 0) {
      await this.db.execute(sql`
        update room_members set display_name = 'Khách ẩn danh'
        where guest_session_id in (${sql.raw(guestQ)})
      `);
      await this.db.execute(sql`
        update guest_sessions set
          display_name = 'Khách ẩn danh',
          token_hash = 'purged:' || id,
          revoked_at = coalesce(revoked_at, now())
        where id in (${sql.raw(guestQ)})
      `);
    }

    // Exact origin coordinates: cleared 30 days after the room finished
    // (privacy rule: exact origin has limited retention). originText stays.
    const originQ = `select rc.id from room_constraints rc
      join rooms r on r.id = rc.room_id
      where r.status in ('completed', 'cancelled', 'expired')
        and r.updated_at < now() - interval '30 days'
        and (rc.origin_lat is not null or rc.origin_lng is not null)`;
    report.originsCleared = await count(originQ);
    if (!dryRun && report.originsCleared > 0) {
      await this.db.execute(sql`
        update room_constraints set origin_lat = null, origin_lng = null
        where id in (${sql.raw(originQ)})
      `);
    }

    if (!dryRun) {
      await this.db.execute(sql`
        insert into audit_logs (actor_type, action, resource_type, resource_id, diff)
        values ('system', 'privacy.retention_run', 'system', 'privacy',
          ${JSON.stringify(report)}::jsonb)
      `);
    }
    return report;
  }
}
