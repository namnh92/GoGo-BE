import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import { normalizeVietnamese } from '../../search/domain/normalize';

/**
 * BE-CMS-G1 (#219) — the moderation queue, filtered and paged server-side.
 *
 * `GET /cms/moderation` returned four unfiltered, unpaged, uncounted arrays
 * with a single shared `limit`. The console could only filter the page it had
 * already been handed, and the sidebar badge had to add the four array lengths
 * together — a number that stopped being true the moment the queue was longer
 * than `limit`.
 *
 * One read per queue instead, each with its own filters, its own keyset cursor
 * and its own count. Decisions stay where they were (`CmsOpsService`): this is
 * the read side of the same resource, not a second moderation subsystem.
 */

export const REVIEW_MODERATION_STATUSES = [
  'pending',
  'published',
  'rejected',
  'removed',
  'hidden',
] as const;
export const CHECKIN_MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const REPORT_MODERATION_STATUSES = ['open', 'actioned', 'dismissed'] as const;
export const REPORT_TARGET_TYPES = ['place', 'review', 'member'] as const;

export type ReviewQueueQuery = {
  status?: (typeof REVIEW_MODERATION_STATUSES)[number] | undefined;
  rating?: number | undefined;
  reported?: boolean | undefined;
  placeId?: string | undefined;
  userId?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type ReportQueueQuery = {
  status?: (typeof REPORT_MODERATION_STATUSES)[number] | undefined;
  targetType?: (typeof REPORT_TARGET_TYPES)[number] | undefined;
  targetId?: string | undefined;
  reasonCode?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type CheckinQueueQuery = {
  status?: (typeof CHECKIN_MODERATION_STATUSES)[number] | undefined;
  rating?: number | undefined;
  hasBill?: boolean | undefined;
  placeId?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type CommunityPlaceQueueQuery = {
  q?: string | undefined;
  areaKey?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type ModerationCounts = {
  reviews: number;
  reports: number;
  checkins: number;
  communityPlaces: number;
  total: number;
};

type Page<T> = { items: T[]; nextCursor: string | null; totalCount: number };

type Keyed = { id: string; created_at: Date | string };

@Injectable()
export class ModerationQueueService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The sidebar badge. Four counts of what is genuinely waiting for a human,
   * so the console shows the size of the backlog rather than the size of the
   * page it happens to have loaded.
   */
  async counts(): Promise<ModerationCounts> {
    const { rows } = await this.db.execute(sql`
      select
        (select count(*)::int from reviews where status = 'pending') as reviews,
        (select count(*)::int from reports where status = 'open') as reports,
        (select count(*)::int from stop_checkins where moderation = 'pending') as checkins,
        (select count(*)::int from places where status = 'community_submitted')
          as community_places
    `);
    const row = rows[0] as {
      reviews: number;
      reports: number;
      checkins: number;
      community_places: number;
    };
    const counts = {
      reviews: row.reviews,
      reports: row.reports,
      checkins: row.checkins,
      communityPlaces: row.community_places,
    };
    return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  async reviews(query: ReviewQueueQuery) {
    const where = [sql`r.status = ${query.status ?? 'pending'}`];
    if (query.rating !== undefined) where.push(sql`r.rating = ${query.rating}`);
    if (query.placeId) where.push(sql`r.place_id = ${query.placeId}::uuid`);
    if (query.userId) where.push(sql`r.user_id = ${query.userId}::uuid`);
    this.pushDateRange(where, sql`r.created_at`, query);
    // "Reported" is a fact about other rows, not a column: a review is
    // reported while an undecided report points at it. Filtering on the
    // stored `reports` avoids a denormalised counter that would drift the
    // first time a report was decided outside this path.
    if (query.reported !== undefined) {
      const exists = sql`exists (
        select 1 from reports rep
        where rep.target_type = 'review' and rep.target_id = r.id and rep.status = 'open'
      )`;
      where.push(query.reported ? exists : sql`not ${exists}`);
    }

    return this.page<{
      id: string;
      status: string;
      rating: number;
      text: string | null;
      place_id: string | null;
      place_name: string | null;
      plan_id: string | null;
      user_id: string;
      author_display_name: string | null;
      open_report_count: number;
      moderated_by_admin_id: string | null;
      moderation_reason: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>({
      where,
      limit: query.limit,
      cursor: query.cursor,
      cursorColumns: sql`(r.created_at, r.id)`,
      // Author name, not the account: a moderator needs to see who wrote the
      // text and whether one person is filling the queue. Email and phone are
      // not part of that judgement, so they are not selected at all.
      select: sql`
        select r.id, r.status, r.rating, r.text, r.place_id, p.name as place_name,
               r.plan_id, r.user_id, u.display_name as author_display_name,
               (select count(*)::int from reports rep
                 where rep.target_type = 'review' and rep.target_id = r.id
                   and rep.status = 'open') as open_report_count,
               r.moderated_by_admin_id, r.moderation_reason,
               r.created_at, r.updated_at
        from reviews r
        left join places p on p.id = r.place_id
        left join users u on u.id = r.user_id
      `,
      count: sql`select count(*)::int as n from reviews r`,
      orderBy: sql`order by r.created_at desc, r.id desc`,
      map: (r) => ({
        id: r.id,
        status: r.status,
        rating: r.rating,
        text: r.text ?? undefined,
        placeId: r.place_id ?? undefined,
        placeName: r.place_name ?? undefined,
        planId: r.plan_id ?? undefined,
        authorUserId: r.user_id,
        authorDisplayName: r.author_display_name ?? undefined,
        openReportCount: r.open_report_count,
        moderatedByAdminId: r.moderated_by_admin_id ?? undefined,
        moderationReason: r.moderation_reason ?? undefined,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
      }),
    });
  }

  async reports(query: ReportQueueQuery) {
    const where = [sql`r.status = ${query.status ?? 'open'}`];
    if (query.targetType) where.push(sql`r.target_type = ${query.targetType}`);
    if (query.targetId) where.push(sql`r.target_id = ${query.targetId}::uuid`);
    if (query.reasonCode) where.push(sql`r.reason_code = ${query.reasonCode}`);
    this.pushDateRange(where, sql`r.created_at`, query);

    return this.page<{
      id: string;
      status: string;
      target_type: string;
      target_id: string;
      reason_code: string;
      note: string | null;
      reporter_user_id: string | null;
      reporter_guest_session_id: string | null;
      decided_by_admin_id: string | null;
      decision_reason: string | null;
      decided_at: Date | string | null;
      created_at: Date | string;
    }>({
      where,
      limit: query.limit,
      cursor: query.cursor,
      cursorColumns: sql`(r.created_at, r.id)`,
      select: sql`
        select r.id, r.status, r.target_type, r.target_id, r.reason_code, r.note,
               r.reporter_user_id, r.reporter_guest_session_id,
               r.decided_by_admin_id, r.decision_reason, r.decided_at, r.created_at
        from reports r
      `,
      count: sql`select count(*)::int as n from reports r`,
      orderBy: sql`order by r.created_at desc, r.id desc`,
      map: (r) => ({
        id: r.id,
        status: r.status,
        targetType: r.target_type,
        targetId: r.target_id,
        reasonCode: r.reason_code,
        note: r.note ?? undefined,
        // The guest session id is an internal handle; that a guest reported
        // is the fact a moderator needs, and it is the whole of it.
        reporterKind: r.reporter_user_id
          ? 'user'
          : r.reporter_guest_session_id
            ? 'guest'
            : 'anonymous',
        reporterUserId: r.reporter_user_id ?? undefined,
        decidedByAdminId: r.decided_by_admin_id ?? undefined,
        decisionReason: r.decision_reason ?? undefined,
        decidedAt: r.decided_at ? toIso(r.decided_at) : undefined,
        createdAt: toIso(r.created_at),
      }),
    });
  }

  async checkins(query: CheckinQueueQuery) {
    const where = [sql`c.moderation = ${query.status ?? 'pending'}`];
    if (query.rating !== undefined) where.push(sql`c.rating = ${query.rating}`);
    if (query.hasBill !== undefined) {
      where.push(query.hasBill ? sql`c.bill_total is not null` : sql`c.bill_total is null`);
    }
    if (query.placeId) where.push(sql`ps.place_id = ${query.placeId}::uuid`);
    this.pushDateRange(where, sql`c.created_at`, query);

    const from = sql`
      from stop_checkins c
      join plan_stops ps on ps.id = c.plan_stop_id
      left join places p on p.id = ps.place_id
    `;

    return this.page<{
      id: string;
      moderation: string;
      rating: number | null;
      note: string | null;
      tags: string[];
      photo_count: number;
      has_bill: boolean;
      plan_stop_id: string;
      place_id: string | null;
      place_name: string | null;
      member_id: string;
      created_at: Date | string;
    }>({
      where,
      limit: query.limit,
      cursor: query.cursor,
      cursorColumns: sql`(c.created_at, c.id)`,
      select: sql`
        select c.id, c.moderation, c.rating, c.note, c.tags,
               jsonb_array_length(c.photo_keys) as photo_count,
               (c.bill_total is not null) as has_bill,
               c.plan_stop_id, ps.place_id, p.name as place_name, c.member_id, c.created_at
        ${from}
      `,
      count: sql`select count(*)::int as n ${from}`,
      orderBy: sql`order by c.created_at desc, c.id desc`,
      map: (r) => ({
        id: r.id,
        moderation: r.moderation,
        rating: r.rating ?? undefined,
        note: r.note ?? undefined,
        tags: r.tags ?? [],
        photoCount: Number(r.photo_count),
        hasBill: r.has_bill,
        planStopId: r.plan_stop_id,
        placeId: r.place_id ?? undefined,
        placeName: r.place_name ?? undefined,
        memberId: r.member_id,
        createdAt: toIso(r.created_at),
      }),
    });
  }

  async communityPlaces(query: CommunityPlaceQueueQuery) {
    const where = [sql`p.status = 'community_submitted'`];
    if (query.q) {
      // Normalised on both sides, so a moderator typing "cafe" finds "Cà phê"
      // — and the comparison is the one `places_name_trgm_idx` can serve.
      where.push(sql`p.name_normalized like ${`%${normalizeVietnamese(query.q)}%`}`);
    }
    if (query.areaKey) where.push(sql`p.area_key = ${query.areaKey}`);
    this.pushDateRange(where, sql`p.created_at`, query);

    return this.page<{
      id: string;
      name: string;
      address_text: string | null;
      area_key: string | null;
      created_at: Date | string;
    }>({
      where,
      limit: query.limit,
      cursor: query.cursor,
      cursorColumns: sql`(p.created_at, p.id)`,
      select: sql`
        select p.id, p.name, p.address_text, p.area_key, p.created_at
        from places p
      `,
      count: sql`select count(*)::int as n from places p`,
      orderBy: sql`order by p.created_at desc, p.id desc`,
      map: (r) => ({
        id: r.id,
        name: r.name,
        addressText: r.address_text ?? undefined,
        areaKey: r.area_key ?? undefined,
        createdAt: toIso(r.created_at),
      }),
    });
  }

  private pushDateRange(
    where: SQL[],
    column: SQL,
    query: { dateFrom?: string | undefined; dateTo?: string | undefined },
  ): void {
    if (query.dateFrom) where.push(sql`${column} >= ${query.dateFrom}::timestamptz`);
    // Exclusive upper bound: a half-open range is the only one that tiles, so
    // consecutive day filters neither drop nor double-count a row on the seam.
    if (query.dateTo) where.push(sql`${column} < ${query.dateTo}::timestamptz`);
  }

  /**
   * One page plus the count of the same filtered set.
   *
   * The count is what the badge and the pager need; deriving either from the
   * returned array is what the console had to do before, and it was wrong for
   * every queue longer than one page. Two statements rather than a window
   * function so the page query stays a plain index scan.
   */
  private async page<Row extends Keyed>(spec: {
    where: SQL[];
    limit: number;
    cursor?: string | undefined;
    cursorColumns: SQL;
    select: SQL;
    count: SQL;
    orderBy: SQL;
    map: (row: Row) => unknown;
  }): Promise<Page<unknown>> {
    const filters = [...spec.where];
    const countWhere = sql.join(filters, sql` and `);

    if (spec.cursor) {
      const { at, id } = decodeKeysetCursor(spec.cursor);
      filters.push(sql`${spec.cursorColumns} < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [pageResult, countResult] = await Promise.all([
      this.db.execute(sql`
        ${spec.select}
        where ${sql.join(filters, sql` and `)}
        ${spec.orderBy}
        limit ${spec.limit + 1}
      `),
      this.db.execute(sql`${spec.count} where ${countWhere}`),
    ]);

    const rows = pageResult.rows as Row[];
    const items = rows.slice(0, spec.limit);
    const last = items[items.length - 1];

    return {
      items: items.map(spec.map),
      nextCursor:
        rows.length > spec.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (countResult.rows[0] as { n: number }).n,
    };
  }
}
