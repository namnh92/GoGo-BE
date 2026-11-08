import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import {
  beginIdempotent,
  completeIdempotentWithin,
  type IdempotencyScope,
} from '../../shared/idempotency.interceptor';
import {
  InboxCursorCodec,
  INBOX_CURSOR_TTL_MS,
  legacyInboxTimestamp,
  type InboxCursor,
} from '../domain/inbox-cursor';
import {
  advanceReadOperation,
  readOperationDto,
  type ReadOperationRow,
} from './inbox-read-operations';

@Injectable()
export class NotificationInboxService {
  private readonly cursors: InboxCursorCodec;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) config: { AUTH_JWT_SECRET: string },
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {
    this.cursors = new InboxCursorCodec(config.AUTH_JWT_SECRET);
  }

  private async snapshot(userId: string, requireReady = true) {
    // One statement, one MVCC snapshot: state cannot expose an uncommitted insert.
    const { rows } = await this.db.execute<{
      ready: boolean;
      cutoff: string;
      unread: number;
      as_of: string;
    }>(sql`
      select r.ready, coalesce((select last_sequence from notification_inbox_state where user_id = ${userId}::uuid), 0)::text as cutoff,
        (select count(*)::int from notifications where user_id = ${userId}::uuid and read_at is null) as unread,
        to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as as_of
      from notification_inbox_rollout r where singleton = true
    `);
    const row = rows[0];
    if (!row || (requireReady && !row.ready))
      throw AppError.serviceUnavailable(
        'NOTIFICATION_INBOX_UNAVAILABLE',
        'Inbox rollout incomplete',
      );
    return row;
  }
  private token(
    userId: string,
    cutoff: string,
    asOf: string,
    type: InboxCursor['type'],
  ): InboxCursor {
    return {
      v: 1,
      account: userId,
      cutoff,
      asOf,
      expires: Date.parse(asOf) + INBOX_CURSOR_TTL_MS,
      type,
      filter: 'all',
    };
  }
  async summary(userId: string) {
    const s = await this.snapshot(userId);
    const readThroughCursor = this.cursors.seal(this.token(userId, s.cutoff, s.as_of, 'through'));
    this.metrics.increment('notification_inbox_summary_total');
    return { unreadCount: s.unread, asOf: s.as_of, readThroughCursor };
  }
  async list(userId: string, cursor?: string) {
    const legacy = cursor ? legacyInboxTimestamp(cursor) : null;
    let token: InboxCursor | null = null;
    if (cursor && !legacy) token = this.cursors.open(cursor, userId, 'page');
    else {
      const s = await this.snapshot(userId, false);
      // Keep the existing inbox callable while historical sequences/indexes
      // are backfilled. Until cutover it issues the old timestamp cursor and
      // includes historical rows with NULL sequences.
      if (s.ready) token = this.token(userId, s.cutoff, s.as_of, 'page');
    }
    const before = token?.before;
    const { rows } = await this.db.execute<{
      id: string;
      kind: string;
      payload: unknown;
      read_at: string | null;
      created_at: string;
      cursor_at: string;
    }>(sql`
      select id, kind, payload, read_at, created_at,
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
      from notifications where user_id = ${userId}::uuid
        ${token ? sql`and inbox_sequence <= ${token.cutoff}::bigint` : sql``}
        ${before ? sql`and (created_at, id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)` : sql``}
        ${legacy ? sql`and created_at < ${legacy}::timestamptz` : sql``}
      order by created_at desc, id desc limit 21
    `);
    const page = rows.slice(0, 20);
    const last = page.at(-1);
    return {
      notifications: page.map((n) => ({
        id: n.id,
        kind: n.kind,
        payload: n.payload,
        // Raw execute timestamps are strings. Date is only for the public DTO;
        // the cursor below retains PostgreSQL's full microsecond cursor_at.
        readAt: n.read_at === null ? undefined : new Date(n.read_at).toISOString(),
        createdAt: new Date(n.created_at).toISOString(),
      })),
      nextCursor:
        rows.length > 20 && last
          ? token
            ? this.cursors.seal({ ...token, before: { createdAt: last.cursor_at, id: last.id } })
            : new Date(last.created_at).toISOString()
          : null,
    };
  }
  async markRead(userId: string, id: string) {
    await this.db.execute(sql`update notifications set read_at = statement_timestamp()
      where id = ${id}::uuid and user_id = ${userId}::uuid and read_at is null`);
    return { read: true };
  }
  async readAll(userId: string, through: string, scope: IdempotencyScope) {
    const result = await this.db.transaction(async (tx) => {
      // Claim + operation + first batch + replay completion commit together.
      // A crash at any point rolls back the claim, so retry can always resume.
      const begin = await beginIdempotent(tx, scope);
      if (begin.kind === 'replay')
        return {
          status: begin.status,
          body: begin.body as ReturnType<typeof readOperationDto>,
          replay: true,
        };
      const token = this.cursors.open(through, userId, 'through');
      const ready = await tx.execute<{ ready: boolean }>(
        sql`select ready from notification_inbox_rollout where singleton`,
      );
      if (!ready.rows[0]?.ready)
        throw AppError.serviceUnavailable(
          'NOTIFICATION_INBOX_UNAVAILABLE',
          'Inbox rollout incomplete',
        );
      const created = await tx.execute<ReadOperationRow>(sql`
        insert into notification_read_operations(user_id, cutoff, action_at)
        values (${userId}::uuid, ${token.cutoff}::bigint, date_trunc('milliseconds', statement_timestamp())) returning *
      `);
      const row = await advanceReadOperation(tx, created.rows[0]!);
      const body = readOperationDto(row);
      const status = row.status === 'completed' ? 200 : 202;
      if (!(await completeIdempotentWithin(tx, begin.claim, status, body)))
        throw AppError.conflict('IDEMPOTENT_REQUEST_IN_FLIGHT', 'Retry the request');
      return { status, body, replay: false };
    });
    this.metrics.increment('notification_read_all_requests_total', {
      status: String(result.status),
    });
    if (!result.replay) {
      this.metrics.increment('notification_read_all_batches_total', { status: result.body.status });
      this.metrics.increment('notification_read_all_changed_total', {}, result.body.changedCount);
    }
    return { status: result.status, body: result.body };
  }
  async operation(userId: string, id: string) {
    const { rows } = await this.db.execute<ReadOperationRow>(sql`
      select * from notification_read_operations where id = ${id}::uuid and user_id = ${userId}::uuid
    `);
    if (!rows[0])
      throw AppError.notFound('NOTIFICATION_READ_OPERATION_NOT_FOUND', 'Read operation not found');
    return readOperationDto(rows[0]);
  }
}
