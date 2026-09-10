import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';

export type PrivacyRunReport = {
  searchTermsPurged: number;
  loginAttemptsPurged: number;
  idempotencyKeysPurged: number;
  guestSessionsAnonymized: number;
  originsCleared: number;
  /**
   * ADR-0022 — presign rows nothing ever attached, a day past their expiry.
   * The bytes under `tmp/` go by bucket lifecycle; this is the row.
   */
  mediaUploadsPurged: number;
  /** #255 — closed privacy requests past retention, hard-deleted. */
  privacyRequestsPurged: number;
  /**
   * #255 — retention holds whose review date has passed. Reported, never
   * auto-released and never auto-deleted: a lapsed review date does not mean
   * the legal basis lapsed with it. Somebody has to look.
   */
  privacyHoldReviewsOverdue: number;
};

/**
 * DB-010 — retention/anonymization jobs. Plain class so the worker schedules
 * it daily without Nest; dryRun produces the report without writing.
 */
export class PrivacyJobs {
  constructor(private readonly db: Db) {}

  async run(dryRun = false): Promise<PrivacyRunReport> {
    const report: PrivacyRunReport = {
      searchTermsPurged: 0,
      loginAttemptsPurged: 0,
      idempotencyKeysPurged: 0,
      guestSessionsAnonymized: 0,
      originsCleared: 0,
      mediaUploadsPurged: 0,
      privacyRequestsPurged: 0,
      privacyHoldReviewsOverdue: 0,
    };

    const count = async (query: string): Promise<number> => {
      const res = await this.db.execute(sql.raw(`select count(*)::int as n from (${query}) q`));
      return (res.rows[0] as { n: number }).n;
    };

    // SE-006 search terms: 90-day retention on the text, not on the counts.
    // The aggregate stays so trends survive; the free-text term is dropped,
    // because a search box can be typed into with anything and there is no
    // reason to keep the words once the period they describe is history.
    const termsQ = `select day, query_normalized from search_query_daily
      where day < current_date - 90 and query_normalized <> ''`;
    report.searchTermsPurged = await count(termsQ);
    if (!dryRun && report.searchTermsPurged > 0) {
      // Folded into the aggregate empty-term row rather than deleted, so the
      // day's totals do not silently shrink when the words go.
      await this.db.execute(sql`
        with expired as (
          delete from search_query_daily
          where day < current_date - 90 and query_normalized <> ''
          returning day, searches, zero_results, results_sum, latency_ms_sum
        ), rolled as (
          select day, sum(searches)::int as searches, sum(zero_results)::int as zero_results,
                 sum(results_sum)::bigint as results_sum,
                 sum(latency_ms_sum)::bigint as latency_ms_sum
          from expired group by day
        )
        insert into search_query_daily
          (day, query_normalized, has_query, searches, zero_results, results_sum, latency_ms_sum)
        select day, '', false, searches, zero_results, results_sum, latency_ms_sum from rolled
        on conflict (day, query_normalized) do update set
          searches = search_query_daily.searches + excluded.searches,
          zero_results = search_query_daily.zero_results + excluded.zero_results,
          results_sum = search_query_daily.results_sum + excluded.results_sum,
          latency_ms_sum = search_query_daily.latency_ms_sum + excluded.latency_ms_sum
      `);
    }

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

    // Upload rows still pending a day past expiry: the presigned URL is long
    // dead and nothing attached the key, so the row is a record of a phone
    // that never PUT, or a request that failed before it could attach. The
    // object, if one exists, is under a lifecycle prefix and leaves on its own.
    const uploadsQ = `select id from media_uploads
      where status = 'pending' and expires_at < now() - interval '1 day'`;
    report.mediaUploadsPurged = await count(uploadsQ);
    if (!dryRun && report.mediaUploadsPurged > 0) {
      await this.db.execute(sql`
        delete from media_uploads
        where status = 'pending' and expires_at < now() - interval '1 day'
      `);
    }

    if (!dryRun) {
      await this.db.execute(sql`
        insert into audit_logs (actor_type, action, resource_type, resource_id, diff)
        values ('system', 'privacy.retention_run', 'system', 'privacy',
          ${JSON.stringify(report)}::jsonb)
      `);
    }
    // #255 — the privacy-request ledger's own retention. HARD delete, not
    // anonymize (product decision on #246): timestamps are quasi-identifiers,
    // operator notes cannot be machine-anonymized with confidence, and a
    // half-scrubbed row is liability without value. The monthly aggregates
    // were written when the events happened and survive this on purpose.
    //
    // `retention_hold_at is null` is the legal-hold mechanism working: a held
    // row is skipped for as long as the hold stands, however old it is.
    const purgeQ = `select id from privacy_requests
      where retention_at is not null
        and retention_at <= now()
        and retention_hold_at is null`;
    report.privacyRequestsPurged = await count(purgeQ);
    if (!dryRun && report.privacyRequestsPurged > 0) {
      await this.db.execute(sql`
        delete from privacy_requests
        where retention_at is not null
          and retention_at <= now()
          and retention_hold_at is null
      `);
    }

    // Holds whose review date has passed. Counted and surfaced — the report
    // is logged and the worker's alerting watches it — but nothing here
    // releases the hold or deletes the row. Review is a human's job.
    report.privacyHoldReviewsOverdue = await count(
      `select id from privacy_requests
        where retention_hold_at is not null
          and released_at is null
          and review_at <= now()`,
    );

    return report;
  }
}
