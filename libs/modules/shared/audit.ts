import { schema, type Db } from '@gogo/database';
import { currentRequestContext } from './request-context';

/**
 * BE-IMP-007 — the one way to write an audit row.
 *
 * Two fields were being lost before this existed: `request_id` was declared on
 * the table and populated by exactly one writer, and the actor's IP had nowhere
 * to go at all. Both come from the request, which audit writers deep in the
 * services never see — so they are filled here from the request context rather
 * than threaded through every signature and forgotten on the next writer.
 *
 * IP is recorded for **admin actors only**. It is PII; the justification is
 * staff accountability — telling "that admin did it" apart from "that admin's
 * account was taken over" — and that justification does not extend to users or
 * guests, whose actions are audited without it.
 */
export type AuditInput = {
  actorType: 'admin' | 'user' | 'system';
  actorId?: string | null | undefined;
  action: string;
  resourceType: string;
  resourceId: string;
  diff?: unknown;
};

/** Accepts a transaction as well as the pool, so audits stay inside their tx. */
type AuditWriter = Pick<Db, 'insert'>;

export async function writeAudit(db: AuditWriter, input: AuditInput): Promise<void> {
  const context = currentRequestContext();
  await db.insert(schema.auditLogs).values({
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    diff: input.diff,
    requestId: context.requestId ?? null,
    ipAddress: input.actorType === 'admin' ? (context.ip ?? null) : null,
  });
}
