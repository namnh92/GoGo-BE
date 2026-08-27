import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';

/**
 * BE-IMP-010 — reading the audit log back.
 *
 * `writeAudit` has had nine callers and no reader: answering "who suspended
 * this place and why" meant opening psql. The workspace rule is that audit is a
 * feature, not a log, so this is the query behind the CMS history drawer and
 * the incident review of an emergency takedown.
 *
 * Read-only on purpose. FR-CMS-008 makes the log immutable, so there is no
 * update or delete path here and none should be added.
 */
export type AuditQuery = {
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  breakGlass?: boolean | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type AuditEntry = {
  id: string;
  action: string;
  actorType: 'admin' | 'user' | 'system';
  actorId?: string | undefined;
  actorRole?: string | undefined;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  diff?: unknown;
  reason?: string | undefined;
  breakGlass: boolean;
  requestId?: string | undefined;
  ipAddress?: string | undefined;
  authorizationPath?: string | undefined;
};

type AuditRow = {
  id: string;
  action: string;
  actor_type: 'admin' | 'user' | 'system';
  actor_id: string | null;
  actor_role: string | null;
  resource_type: string;
  resource_id: string;
  created_at: Date | string;
  diff: Record<string, unknown> | null;
  request_id: string | null;
  ip_address: string | null;
  authorization_path: string | null;
};

export function encodeAuditCursor(occurredAt: Date | string, id: string): string {
  const raw = occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt);
  return Buffer.from(JSON.stringify([raw, id])).toString('base64url');
}

export function decodeAuditCursor(cursor: string): { occurredAt: string; id: string } {
  try {
    const [occurredAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [
      string,
      string,
    ];
    if (typeof occurredAt !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad');
    return { occurredAt, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

@Injectable()
export class CmsAuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `includeIp` is the caller's clearance, not a preference. Every admin role
   * may read history — an editor needs to see who changed a place — but the
   * staff IP is only justified for incident review, so it is dropped for the
   * roles that do not run one rather than being shown to everyone who can
   * open the drawer.
   */
  async list(
    query: AuditQuery,
    options: { includeIp: boolean },
  ): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
    const where = [sql`true`];

    if (query.resourceType) where.push(sql`a.resource_type = ${query.resourceType}`);
    if (query.resourceId) where.push(sql`a.resource_id = ${query.resourceId}`);
    if (query.actorId) where.push(sql`a.actor_id = ${query.actorId}::uuid`);
    if (query.action) where.push(sql`a.action = ${query.action}`);
    if (query.from) where.push(sql`a.created_at >= ${query.from}::timestamptz`);
    if (query.to) where.push(sql`a.created_at < ${query.to}::timestamptz`);
    // Break-glass lives in the diff rather than a column: it is a property of
    // how the write was authorized, and only the takedown writer sets it.
    if (query.breakGlass) where.push(sql`a.diff->>'breakGlass' = 'true'`);

    if (query.cursor) {
      const { occurredAt, id } = decodeAuditCursor(query.cursor);
      where.push(sql`(a.created_at, a.id) < (${occurredAt}::timestamptz, ${id}::uuid)`);
    }

    // Newest first, and keyset rather than offset: the log is append-only and
    // written to while it is read, so an offset page would drift under the
    // reader. Joining admin_users is for the role only — an incident review
    // needs "an ops_admin did this", and nothing else about the account.
    const rows = await this.db.execute(sql`
      select a.id, a.action, a.actor_type, a.actor_id, au.role as actor_role,
             a.resource_type, a.resource_id, a.created_at, a.diff,
             a.request_id, a.ip_address, a.authorization_path
      from audit_logs a
      left join admin_users au
        on au.id = a.actor_id and a.actor_type = 'admin'
      where ${sql.join(where, sql` and `)}
      order by a.created_at desc, a.id desc
      limit ${query.limit + 1}
    `);

    const page = rows.rows as AuditRow[];
    const items = page.slice(0, query.limit);
    const last = items[items.length - 1];

    return {
      items: items.map((r) => {
        const diff = r.diff ?? undefined;
        const reason =
          diff && typeof diff === 'object' && typeof diff['reason'] === 'string'
            ? (diff['reason'] as string)
            : undefined;
        return {
          id: r.id,
          action: r.action,
          actorType: r.actor_type,
          actorId: r.actor_id ?? undefined,
          actorRole: r.actor_role ?? undefined,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          occurredAt: toIso(r.created_at),
          diff,
          reason,
          breakGlass: diff?.['breakGlass'] === true,
          requestId: r.request_id ?? undefined,
          // Staff IP is PII kept for staff accountability. It appears in this
          // read only, and must not be copied into any other CMS response, log
          // line or analytics event.
          ipAddress: options.includeIp ? (r.ip_address ?? undefined) : undefined,
          authorizationPath: r.authorization_path ?? undefined,
        };
      }),
      nextCursor:
        page.length > query.limit && last ? encodeAuditCursor(last.created_at, last.id) : null,
    };
  }
}
