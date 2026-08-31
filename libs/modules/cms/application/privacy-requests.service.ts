import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type PrivacyLedgerConfig } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import {
  bumpPrivacyMetrics,
  dueDates,
  monthKey,
  retentionDate,
  slaConfigFrom,
  type PrivacyRequestKind,
  type SlaConfig,
} from '../../shared/privacy-ledger';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import { UserContentService } from '../../reviews/application/user-content.service';

type Row = typeof schema.privacyRequests.$inferSelect;

export type SlaState = 'ON_TRACK' | 'DUE_SOON' | 'OVERDUE' | 'COMPLETED';

/** "Due soon" means inside the last quarter of the window, floored at 24h. */
function slaState(row: Row, now = new Date()): SlaState {
  if (row.status === 'closed') return 'COMPLETED';
  const due = row.extendedDueAt ?? row.fulfillmentDueAt;
  if (now >= due) return 'OVERDUE';
  const windowMs = due.getTime() - row.receivedAt.getTime();
  const soonMs = Math.max(24 * 3_600_000, windowMs / 4);
  return due.getTime() - now.getTime() <= soonMs ? 'DUE_SOON' : 'ON_TRACK';
}

function toDto(row: Row) {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    status: row.status,
    outcome: row.outcome ?? undefined,
    subject: {
      subjectType: row.subjectType,
      userId: row.userId ?? undefined,
      contactEmail: row.contactEmail ?? undefined,
      externalReference: row.externalReference ?? undefined,
      identityStatus: row.identityStatus,
    },
    receivedAt: toIso(row.receivedAt),
    ackDueAt: toIso(row.ackDueAt),
    acknowledgedAt: row.acknowledgedAt ? toIso(row.acknowledgedAt) : undefined,
    fulfillmentDueAt: toIso(row.fulfillmentDueAt),
    extendedDueAt: row.extendedDueAt ? toIso(row.extendedDueAt) : undefined,
    extensionReason: row.extensionReason ?? undefined,
    executedAt: row.executedAt ? toIso(row.executedAt) : undefined,
    completedAt: row.completedAt ? toIso(row.completedAt) : undefined,
    closedAt: row.closedAt ? toIso(row.closedAt) : undefined,
    deliveryMethod: row.deliveryMethod ?? undefined,
    deliveredAt: row.deliveredAt ? toIso(row.deliveredAt) : undefined,
    retentionAt: row.retentionAt ? toIso(row.retentionAt) : undefined,
    retentionHold: row.retentionHoldAt
      ? {
          heldAt: toIso(row.retentionHoldAt),
          heldBy: row.retentionHoldBy!,
          reason: row.retentionHoldReason!,
          legalBasis: row.legalBasis!,
          reviewAt: toIso(row.reviewAt!),
          holdUntil: row.holdUntil ? toIso(row.holdUntil) : undefined,
          reviewOverdue: row.reviewAt! <= new Date(),
        }
      : undefined,
    reasonCode: row.reasonCode ?? undefined,
    ticketReference: row.ticketReference ?? undefined,
    operatorNote: row.operatorNote ?? undefined,
    sla: slaState(row),
  };
}

/**
 * BE-CMS-G12 (#255) — the privacy-request compliance ledger.
 *
 * The audit log answers "who did what". This answers "what did we receive,
 * where is it, what is the deadline, how did it end". Full design: ADR-0011.
 */
@Injectable()
export class PrivacyRequestsService {
  private readonly sla: SlaConfig;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: PrivacyLedgerConfig,
    private readonly userContent: UserContentService,
  ) {
    this.sla = slaConfigFrom(config.PRIVACY_SLA_JSON);
  }

  /**
   * A request arriving through support or the console. The subject is
   * structured — user id, email, or an external reference — never one
   * free-text field, which would become a PII dumping ground the first time
   * a conversation was pasted into it.
   */
  async create(input: {
    type: PrivacyRequestKind;
    subjectType: 'user' | 'email' | 'external';
    userId?: string | undefined;
    contactEmail?: string | undefined;
    externalReference?: string | undefined;
    reasonCode?: string | undefined;
    ticketReference?: string | undefined;
    operatorNote?: string | undefined;
    actorId: string;
  }) {
    if (input.subjectType === 'user') {
      const [user] = await this.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, input.userId ?? ''))
        .limit(1);
      if (!user) throw AppError.notFound('USER_NOT_FOUND', 'No such account');
    }

    const now = new Date();
    const { ackDueAt, fulfillmentDueAt } = dueDates(this.sla, input.type, now);
    const [row] = await this.db
      .insert(schema.privacyRequests)
      .values({
        type: input.type,
        source: 'support',
        subjectType: input.subjectType,
        userId: input.subjectType === 'user' ? input.userId : null,
        contactEmail: input.contactEmail ?? null,
        externalReference: input.externalReference ?? null,
        // A user subject is matched by construction; anything else starts
        // unverified and says so, rather than borrowing credibility.
        identityStatus: input.subjectType === 'user' ? 'matched' : 'unverified',
        receivedAt: now,
        ackDueAt,
        fulfillmentDueAt,
        reasonCode: input.reasonCode ?? null,
        ticketReference: input.ticketReference ?? null,
        operatorNote: input.operatorNote ?? null,
        createdByAdminId: input.actorId,
      })
      .returning();

    await bumpPrivacyMetrics(this.db, monthKey(now), [
      input.type === 'export'
        ? 'export_received'
        : input.type === 'delete'
          ? 'delete_received'
          : 'correction_received',
    ]);
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: input.actorId,
      action: 'privacy_request.created',
      resourceType: 'privacy_request',
      resourceId: row!.id,
      diff: { type: input.type, subjectType: input.subjectType },
    });
    return toDto(row!);
  }

  async list(query: {
    status?: Row['status'] | undefined;
    type?: PrivacyRequestKind | undefined;
    outcome?: NonNullable<Row['outcome']> | undefined;
    sla?: 'overdue' | 'due_soon' | undefined;
    userId?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const where: SQL[] = [];
    if (query.status) where.push(sql`p.status = ${query.status}::privacy_request_status`);
    if (query.type) where.push(sql`p.type = ${query.type}::privacy_request_type`);
    if (query.outcome) where.push(sql`p.outcome = ${query.outcome}::privacy_request_outcome`);
    if (query.userId) where.push(sql`p.user_id = ${query.userId}::uuid`);
    // SLA filters are computed against the same stored dates slaState uses,
    // so the list a person filters and the badge they see cannot disagree.
    if (query.sla === 'overdue') {
      where.push(
        sql`p.status <> 'closed' and coalesce(p.extended_due_at, p.fulfillment_due_at) <= now()`,
      );
    }
    if (query.sla === 'due_soon') {
      where.push(sql`p.status <> 'closed'
        and coalesce(p.extended_due_at, p.fulfillment_due_at) > now()
        and coalesce(p.extended_due_at, p.fulfillment_due_at) - now() <= greatest(
          interval '24 hours',
          (coalesce(p.extended_due_at, p.fulfillment_due_at) - p.received_at) / 4
        )`);
    }

    const countWhere = where.length ? sql.join(where, sql` and `) : sql`true`;
    const pageWhere = [...where];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageWhere.push(sql`(p.received_at, p.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select p.* from privacy_requests p
        where ${pageWhere.length ? sql.join(pageWhere, sql` and `) : sql`true`}
        order by p.received_at desc, p.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(sql`select count(*)::int as n from privacy_requests p where ${countWhere}`),
    ]);

    const rows = (page.rows as unknown as Row[]).map(normalizeRow);
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toDto),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.receivedAt, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }

  async detail(id: string) {
    return toDto(await this.load(id));
  }

  async acknowledge(input: { id: string; actorId: string }) {
    const row = await this.load(input.id);
    if (row.status !== 'open') {
      throw AppError.conflict('NOT_OPEN', 'Only an open request can be acknowledged');
    }
    const [updated] = await this.db
      .update(schema.privacyRequests)
      .set({ status: 'acknowledged', acknowledgedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(schema.privacyRequests.id, input.id))
      .returning();
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: input.actorId,
      action: 'privacy_request.acknowledged',
      resourceType: 'privacy_request',
      resourceId: input.id,
    });
    return toDto(updated!);
  }

  /**
   * Runs the operation for THIS request and closes it. The link is explicit:
   * `same user` is not `same request` — one person can have an export, a
   * delete, a duplicate and a rejected request open at once, and a CMS action
   * that merely happens on the same user must not mark any of them fulfilled.
   * That is why `POST /cms/users/{id}/delete` does not touch this table.
   */
  async execute(input: { id: string; actorId: string; actorRole: string }) {
    const row = await this.load(input.id);
    if (row.status === 'closed') {
      throw AppError.conflict('ALREADY_CLOSED', 'This request is already closed');
    }
    // Same bar as the direct user delete (#246): erasing somebody else's
    // account is the one irreversible action here, and it is super_admin's.
    if (row.type === 'delete' && input.actorRole !== 'super_admin') {
      throw AppError.forbidden('ROLE_DENIED', 'Executing a delete request requires super_admin');
    }
    if (row.type === 'correction') {
      // Corrections are recorded and worked by hand; there is no automated
      // operation to run, and pretending to run one would close the request
      // without anything having happened.
      throw AppError.conflict('NOT_EXECUTABLE', 'Correction requests are fulfilled manually');
    }
    if (row.identityStatus !== 'matched' || !row.userId) {
      throw AppError.conflict(
        'IDENTITY_NOT_MATCHED',
        'Match the request to an account before executing it',
      );
    }

    const now = new Date();
    if (row.type === 'export') {
      const data = await this.userContent.exportForUser(row.userId, {
        actorType: 'admin',
        actorId: input.actorId,
        reason: `privacy_request:${row.id}`,
      });
      await this.closeExecuted(row, input.actorId, now, 'export_completed');
      // The payload goes to the caller and nowhere else. The ledger keeps
      // delivery *metadata* once the operator records it — never the bytes.
      return { request: await this.detail(row.id), data };
    }

    await this.userContent.deleteForUser(row.userId, {
      actorType: 'admin',
      actorId: input.actorId,
      reason: `privacy_request:${row.id}`,
    });
    await this.closeExecuted(row, input.actorId, now, 'delete_completed');
    return { request: await this.detail(row.id) };
  }

  private async closeExecuted(
    row: Row,
    actorId: string,
    now: Date,
    metric: 'export_completed' | 'delete_completed',
  ): Promise<void> {
    const due = row.extendedDueAt ?? row.fulfillmentDueAt;
    await this.db
      .update(schema.privacyRequests)
      .set({
        status: 'closed',
        outcome: 'completed',
        executedAt: now,
        executedByAdminId: actorId,
        completedAt: now,
        closedAt: now,
        retentionAt: retentionDate(now, this.config.PRIVACY_RETENTION_MONTHS),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.privacyRequests.id, row.id));
    await bumpPrivacyMetrics(this.db, monthKey(now), [
      metric,
      ...(now > due ? (['sla_breached'] as const) : []),
    ]);
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId,
      action: 'privacy_request.executed',
      resourceType: 'privacy_request',
      resourceId: row.id,
      diff: { type: row.type, slaBreached: now > due },
    });
  }

  /** Close without executing: the outcomes that end a request unfulfilled. */
  async close(input: {
    id: string;
    outcome: 'no_account_found' | 'identity_not_verified' | 'rejected' | 'failed';
    reasonCode?: string | undefined;
    operatorNote?: string | undefined;
    actorId: string;
  }) {
    const row = await this.load(input.id);
    if (row.status === 'closed') {
      throw AppError.conflict('ALREADY_CLOSED', 'This request is already closed');
    }
    const now = new Date();
    const [updated] = await this.db
      .update(schema.privacyRequests)
      .set({
        status: 'closed',
        outcome: input.outcome,
        closedAt: now,
        retentionAt: retentionDate(now, this.config.PRIVACY_RETENTION_MONTHS),
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.privacyRequests.id, input.id))
      .returning();

    await bumpPrivacyMetrics(this.db, monthKey(now), [
      ...(input.outcome === 'no_account_found' ? (['no_account_found'] as const) : []),
      ...(input.outcome === 'failed' && row.type === 'export' ? (['export_failed'] as const) : []),
      ...(input.outcome === 'failed' && row.type === 'delete' ? (['delete_failed'] as const) : []),
    ]);
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: input.actorId,
      action: 'privacy_request.closed',
      resourceType: 'privacy_request',
      resourceId: input.id,
      diff: { outcome: input.outcome, reasonCode: input.reasonCode },
    });
    return toDto(updated!);
  }

  /** Records how the export left the building. Metadata only, ever. */
  async markDelivered(input: {
    id: string;
    deliveryMethod: 'in_app' | 'secure_download' | 'other';
    actorId: string;
  }) {
    const row = await this.load(input.id);
    if (row.type !== 'export') {
      throw AppError.conflict('NOT_AN_EXPORT', 'Only an export request has a delivery');
    }
    const [updated] = await this.db
      .update(schema.privacyRequests)
      .set({ deliveryMethod: input.deliveryMethod, deliveredAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(schema.privacyRequests.id, input.id))
      .returning();
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: input.actorId,
      action: 'privacy_request.delivered',
      resourceType: 'privacy_request',
      resourceId: input.id,
      diff: { deliveryMethod: input.deliveryMethod },
    });
    return toDto(updated!);
  }

  /**
   * Legal retention hold — the mechanism, so an override never means editing
   * the database by hand. Reason, legal basis and a review date are all
   * mandatory; the retention job skips held rows; and a hold only ever
   * extends retention — releasing restores the standard date, never an
   * earlier one, because quietly shortening retention is destroying evidence.
   */
  async holdRetention(input: {
    id: string;
    reason: string;
    legalBasis: string;
    reviewAt: Date;
    holdUntil?: Date | undefined;
    actorId: string;
  }) {
    const row = await this.load(input.id);
    if (row.status !== 'closed') {
      throw AppError.conflict('NOT_CLOSED', 'Retention only applies to a closed request');
    }
    if (row.retentionHoldAt && !row.releasedAt) {
      throw AppError.conflict('ALREADY_HELD', 'A retention hold is already in place');
    }
    if (input.reviewAt <= new Date()) {
      throw AppError.badRequest('REVIEW_IN_PAST', 'The review date must be in the future');
    }
    const [updated] = await this.db
      .update(schema.privacyRequests)
      .set({
        retentionHoldAt: sql`now()`,
        retentionHoldBy: input.actorId,
        retentionHoldReason: input.reason,
        legalBasis: input.legalBasis,
        reviewAt: input.reviewAt,
        holdUntil: input.holdUntil ?? null,
        releasedAt: null,
        releasedBy: null,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.privacyRequests.id, input.id))
      .returning();
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: input.actorId,
      action: 'privacy_request.retention_hold_created',
      resourceType: 'privacy_request',
      resourceId: input.id,
      diff: { reason: input.reason, legalBasis: input.legalBasis, reviewAt: input.reviewAt },
    });
    return toDto(updated!);
  }

  async releaseHold(input: { id: string; reason: string; actorId: string }) {
    const row = await this.load(input.id);
    if (!row.retentionHoldAt || row.releasedAt) {
      throw AppError.conflict('NOT_HELD', 'No active retention hold on this request');
    }
    const [updated] = await this.db
      .update(schema.privacyRequests)
      .set({
        // The hold columns stay filled — who held it and why is part of the
        // record; released_at is what says it is over. The retention date is
        // untouched: standard retention resumes, never shortens.
        retentionHoldAt: null,
        releasedAt: sql`now()`,
        releasedBy: input.actorId,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.privacyRequests.id, input.id))
      .returning();
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: input.actorId,
      action: 'privacy_request.retention_hold_released',
      resourceType: 'privacy_request',
      resourceId: input.id,
      diff: { reason: input.reason },
    });
    return toDto(updated!);
  }

  private async load(id: string): Promise<Row> {
    const [row] = await this.db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, id))
      .limit(1);
    if (!row) throw AppError.notFound('PRIVACY_REQUEST_NOT_FOUND', 'No such request');
    return row;
  }
}

/** Raw `select *` rows arrive snake_case; Drizzle's mapped reads are camel. */
function normalizeRow(r: Row | Record<string, unknown>): Row {
  if ('receivedAt' in r) return r as Row;
  const x = r as Record<string, unknown>;
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  return {
    id: x.id,
    type: x.type,
    source: x.source,
    status: x.status,
    outcome: x.outcome ?? null,
    subjectType: x.subject_type,
    userId: x.user_id ?? null,
    contactEmail: x.contact_email ?? null,
    externalReference: x.external_reference ?? null,
    identityStatus: x.identity_status,
    receivedAt: date(x.received_at),
    ackDueAt: date(x.ack_due_at),
    acknowledgedAt: date(x.acknowledged_at),
    fulfillmentDueAt: date(x.fulfillment_due_at),
    extendedDueAt: date(x.extended_due_at),
    extensionReason: x.extension_reason ?? null,
    executedAt: date(x.executed_at),
    executedByAdminId: x.executed_by_admin_id ?? null,
    completedAt: date(x.completed_at),
    closedAt: date(x.closed_at),
    deliveryMethod: x.delivery_method ?? null,
    deliveredAt: date(x.delivered_at),
    retentionAt: date(x.retention_at),
    retentionHoldAt: date(x.retention_hold_at),
    retentionHoldBy: x.retention_hold_by ?? null,
    retentionHoldReason: x.retention_hold_reason ?? null,
    legalBasis: x.legal_basis ?? null,
    reviewAt: date(x.review_at),
    holdUntil: date(x.hold_until),
    releasedAt: date(x.released_at),
    releasedBy: x.released_by ?? null,
    reasonCode: x.reason_code ?? null,
    ticketReference: x.ticket_reference ?? null,
    operatorNote: x.operator_note ?? null,
    createdByAdminId: x.created_by_admin_id ?? null,
    createdAt: date(x.created_at),
    updatedAt: date(x.updated_at),
  } as Row;
}
