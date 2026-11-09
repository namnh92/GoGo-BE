import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import type { Tx } from '../../shared/outbox';
import {
  beginIdempotent,
  completeIdempotentWithin,
  type IdempotencyScope,
} from '../../shared/idempotency.interceptor';
import {
  matchesSystemNotificationEtag,
  parseSystemNotificationCursor,
  systemNotificationCursor,
  type SystemAnnouncementInput,
  type SystemAnnouncementPatch,
  type SystemNotificationQuery,
} from '../domain/system-announcement';

type AnnouncementRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  locale: 'vi';
  deep_link: string | null;
  status: 'draft' | 'published' | 'archived';
  published_at: string | null;
  expires_at: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};
// Explicit UTC text preserves microseconds both for keysets and replay DTOs.
const columns = sql`id, kind, title, body, locale, deep_link, status, created_by, updated_by,
  to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at,
  to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

function publicDto(row: AnnouncementRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    publishedAt: row.published_at!,
    expiresAt: row.expires_at,
  };
}
function cmsDto(row: AnnouncementRow) {
  return {
    ...publicDto(row),
    publishedAt: row.published_at,
    locale: row.locale,
    status: row.status,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class SystemNotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async listPublic(query: SystemNotificationQuery, ifNoneMatch?: string) {
    const body = await this.page(query, 'public');
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`;
    const notModified = matchesSystemNotificationEtag(ifNoneMatch, etag);
    this.metrics.increment('system_notifications_reads_total', {
      status: notModified ? '304' : '200',
    });
    return { body, etag, notModified };
  }

  listCms(query: SystemNotificationQuery) {
    return this.page(query, 'cms');
  }

  private async page(query: SystemNotificationQuery, purpose: 'public' | 'cms') {
    // Qualify the source column: ORDER BY an output to_char alias would force
    // a text sort instead of using the timestamp keyset index.
    const order = purpose === 'public' ? sql`sa.published_at` : sql`sa.created_at`;
    const filters =
      purpose === 'public'
        ? [
            sql`status = 'published' and published_at <= statement_timestamp()
          and (expires_at is null or expires_at > statement_timestamp())`,
          ]
        : [query.status ? sql`status = ${query.status}` : sql`true`];
    if (query.cursor) {
      const { at, id } = parseSystemNotificationCursor(query.cursor, purpose);
      filters.push(sql`(${order}, id) < (${at}::timestamptz, ${id}::uuid)`);
    }
    const { rows } = await this.db.execute<AnnouncementRow>(sql`
      select ${columns} from system_announcements sa
      where ${sql.join(filters, sql` and `)} order by ${order} desc, id desc limit ${query.limit + 1}
    `);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => (purpose === 'public' ? publicDto(row) : cmsDto(row))),
      nextCursor:
        rows.length > query.limit && last
          ? systemNotificationCursor(
              purpose === 'public' ? last.published_at! : last.created_at,
              last.id,
              purpose,
            )
          : null,
    };
  }

  async create(adminId: string, input: SystemAnnouncementInput, scope: IdempotencyScope) {
    const result = await this.db.transaction(async (tx) => {
      const begun = await beginIdempotent(tx, scope);
      if (begun.kind === 'replay') return { ...begun, changed: false };
      const [row] = await tx
        .insert(schema.systemAnnouncements)
        .values({
          kind: input.kind,
          title: input.title,
          body: input.body,
          locale: input.locale ?? 'vi',
          deepLink: input.deepLink ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdBy: adminId,
          updatedBy: adminId,
        })
        .returning({ id: schema.systemAnnouncements.id });
      const after = cmsDto(await this.requireRow(tx, row!.id));
      await this.audit(tx, adminId, row!.id, 'created', { after });
      if (!(await completeIdempotentWithin(tx, begun.claim, 201, after))) {
        throw AppError.conflict('IDEMPOTENT_REQUEST_IN_FLIGHT', 'Idempotency claim lost');
      }
      return { status: 201, body: after, changed: true };
    });
    if (result.changed) this.changed('created');
    return { status: result.status, body: result.body };
  }

  async patch(adminId: string, id: string, input: SystemAnnouncementPatch) {
    const result = await this.db.transaction(async (tx) => {
      const before = await this.requireRow(tx, id, true);
      if (before.status === 'archived')
        throw AppError.conflict(
          'INVALID_STATUS_TRANSITION',
          'Archived announcements cannot be edited',
        );
      const expiresAt = input.expiresAt === undefined ? before.expires_at : input.expiresAt;
      if (
        expiresAt &&
        before.published_at &&
        new Date(expiresAt) <= new Date(before.published_at)
      ) {
        throw AppError.badRequest('INVALID_EXPIRY', 'Expiry must follow publication');
      }
      await tx
        .update(schema.systemAnnouncements)
        .set({
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.deepLink !== undefined ? { deepLink: input.deepLink } : {}),
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }
            : {}),
          updatedBy: adminId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(sql`id = ${id}::uuid`);
      const after = cmsDto(await this.requireRow(tx, id));
      await this.audit(tx, adminId, id, 'updated', { before: cmsDto(before), after });
      return after;
    });
    this.changed('updated');
    return result;
  }

  async setStatus(adminId: string, id: string, status: 'published' | 'archived') {
    const result = await this.db.transaction(async (tx) => {
      const before = await this.requireRow(tx, id, true);
      if (before.status === status) return { body: cmsDto(before), changed: false };
      if (before.status === 'archived')
        throw AppError.conflict(
          'INVALID_STATUS_TRANSITION',
          'Archived announcements cannot be published',
        );
      // One statement time for both the expiry predicate and publishedAt:
      // expiry cannot cross between a preflight check and the actual update.
      const updated = await tx
        .update(schema.systemAnnouncements)
        .set({
          status,
          updatedBy: adminId,
          updatedAt: sql`statement_timestamp()`,
          ...(status === 'published' ? { publishedAt: sql`statement_timestamp()` } : {}),
        })
        .where(
          sql`id = ${id}::uuid ${
            status === 'published'
              ? sql`and (expires_at is null or expires_at > statement_timestamp())`
              : sql``
          }`,
        )
        .returning({ id: schema.systemAnnouncements.id });
      if (!updated.length)
        throw AppError.badRequest('INVALID_EXPIRY', 'Expired announcements cannot be published');
      const after = cmsDto(await this.requireRow(tx, id));
      await this.audit(tx, adminId, id, status, { before: cmsDto(before), after });
      return { body: after, changed: true };
    });
    if (result.changed) this.changed(status);
    return result.body;
  }

  private async requireRow(tx: Tx, id: string, lock = false) {
    const { rows } = await tx.execute<AnnouncementRow>(sql`
      select ${columns} from system_announcements where id = ${id}::uuid ${lock ? sql`for update` : sql``}
    `);
    if (!rows[0])
      throw AppError.notFound('SYSTEM_NOTIFICATION_NOT_FOUND', 'Announcement not found');
    return rows[0];
  }

  private audit(tx: Tx, adminId: string, id: string, action: string, diff: unknown) {
    return writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: `system_announcement.${action}`,
      resourceType: 'system_announcement',
      resourceId: id,
      diff,
    });
  }
  private changed(action: string) {
    this.metrics.increment('system_notifications_writes_total', { action });
  }
}
