import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { StoragePort } from '@gogo/providers';
import { RETRY_BACKOFF_SECONDS } from '../../notifications/application/outbox-dispatcher';
import { writeAudit } from '../../shared/audit';
import type { Tx } from '../../shared/outbox';
import { bumpPrivacyMetrics, monthKey, retentionDate } from '../../shared/privacy-ledger';

/**
 * GoGo-BE#256, ADR-0031 — operational defaults. Changing one is an ADR
 * amendment, not a tuning knob: each is part of the security argument.
 */
export const PRIVACY_EXPORT_DEFAULTS = {
  /** Immutable per artifact, from the moment it becomes ready. */
  ttlMs: 24 * 3_600_000,
  /** UTF-8 JSON plaintext limit, enforced while serializing. Never truncated. */
  maxPlaintextBytes: 16 * 1024 * 1024,
  /** A transfer admitted before expiry/revocation may run this long, no longer. */
  transferDeadlineMs: 60_000,
  /** Pending/generating longer than this fails explicitly. */
  generationDeadlineMs: 2 * 3_600_000,
  /** Generation retries before the artifact fails. */
  maxGenerationFailures: 5,
  /** Storage deletes before a cleanup row is dead-lettered and needs a person. */
  maxCleanupAttempts: 8,
  /** Cleaned tombstones (no key, no object) are removed after this. */
  tombstoneRetentionMs: 30 * 24 * 3_600_000,
  /** Generations per subject per rolling hour, across every entry point. */
  generationsPerHour: 3,
  /** Concurrent decrypt-and-send per API process. */
  maxConcurrentDownloads: 4,
  /** Worker lease on one generation attempt. */
  leaseTtlMs: 120_000,
} as const;

/** Private bucket prefix — the one the 2-day R2 lifecycle backstop targets. */
export const PRIVACY_EXPORT_PREFIX = 'privacy-exports/';

export type ArtifactRow = typeof schema.privacyExportArtifacts.$inferSelect;

export const ACTIVE_STATES = ['pending', 'generating', 'ready'] as const;

/** Facts only; the client composes copy from `status` and the timestamps. */
export function toExportStatus(row: ArtifactRow) {
  return {
    id: row.id,
    status: row.state,
    initiatedBy: row.initiatorType === 'user' ? ('self' as const) : ('support' as const),
    createdAt: row.createdAt.toISOString(),
    ...(row.readyAt ? { readyAt: row.readyAt.toISOString() } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}),
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    ...(row.revokeReason ? { revokeReason: row.revokeReason } : {}),
  };
}

export type ExportStatusDto = ReturnType<typeof toExportStatus>;

/** CMS view: adds delivery facts an operator needs and nothing a subject would not see. */
export function toAdminExportStatus(row: ArtifactRow) {
  return {
    ...toExportStatus(row),
    ...(row.transferCompletedAt
      ? { transferCompletedAt: row.transferCompletedAt.toISOString() }
      : {}),
    ...(row.transferOutcome ? { transferOutcome: row.transferOutcome } : {}),
    ...(row.cleanedAt ? { cleanedAt: row.cleanedAt.toISOString() } : {}),
  };
}

/**
 * Closes the ledger row an artifact fulfils as `failed`, once. A row an
 * operator already closed is left alone and nothing is counted twice.
 */
export async function closeLinkedRequestFailed(
  tx: Tx,
  requestId: string | null,
  retentionMonths: number,
): Promise<void> {
  if (!requestId) return;
  const now = new Date();
  const closed = await tx
    .update(schema.privacyRequests)
    .set({
      status: 'closed',
      outcome: 'failed',
      closedAt: now,
      retentionAt: retentionDate(now, retentionMonths),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.privacyRequests.id, requestId),
        sql`${schema.privacyRequests.status} <> 'closed'`,
      ),
    )
    .returning({ id: schema.privacyRequests.id });
  if (closed.length > 0) await bumpPrivacyMetrics(tx, monthKey(now), ['export_failed']);
}

/**
 * Closes the ledger row as `completed` when its artifact becomes available.
 * `delivered_at` is NOT set here: that records a server-observed transfer.
 */
export async function closeLinkedRequestCompleted(
  tx: Tx,
  requestId: string | null,
  retentionMonths: number,
): Promise<void> {
  if (!requestId) return;
  const now = new Date();
  const [closed] = await tx
    .update(schema.privacyRequests)
    .set({
      status: 'closed',
      outcome: 'completed',
      executedAt: sql`coalesce(${schema.privacyRequests.executedAt}, now())`,
      completedAt: now,
      closedAt: now,
      deliveryMethod: 'secure_download',
      retentionAt: retentionDate(now, retentionMonths),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.privacyRequests.id, requestId),
        sql`${schema.privacyRequests.status} <> 'closed'`,
      ),
    )
    .returning({
      fulfillmentDueAt: schema.privacyRequests.fulfillmentDueAt,
      extendedDueAt: schema.privacyRequests.extendedDueAt,
    });
  if (!closed) return;
  const due = closed.extendedDueAt ?? closed.fulfillmentDueAt;
  await bumpPrivacyMetrics(tx, monthKey(now), [
    'export_completed',
    ...(now > due ? (['sla_breached'] as const) : []),
  ]);
}

export type CleanupReport = { attempted: number; deleted: number; retried: number; dead: number };

/**
 * Physical deletion of whatever artifacts are due. Storage first, then the
 * row: a refused delete is retried with backoff and dead-lettered after
 * `maxCleanupAttempts`, and an artifact is never marked cleaned while its
 * object may still exist. Confirmed deletion clears every remaining key field
 * and leaves a tombstone (state + timestamps) for the audit trail.
 */
export async function cleanupDueArtifacts(
  db: Db,
  storage: StoragePort,
  options: { ids?: string[]; limit?: number; maxAttempts?: number } = {},
): Promise<CleanupReport> {
  const report: CleanupReport = { attempted: 0, deleted: 0, retried: 0, dead: 0 };
  if (options.ids && options.ids.length === 0) return report;
  const maxAttempts = options.maxAttempts ?? PRIVACY_EXPORT_DEFAULTS.maxCleanupAttempts;
  const t = schema.privacyExportArtifacts;
  const rows = await db
    .select({ id: t.id, objectKey: t.objectKey, cleanupAttempts: t.cleanupAttempts })
    .from(t)
    .where(
      and(
        sql`${t.cleanupDueAt} <= now()`,
        isNull(t.cleanedAt),
        isNull(t.cleanupDeadAt),
        sql`${t.state} not in ('pending', 'generating', 'ready')`,
        ...(options.ids ? [inArray(t.id, options.ids)] : []),
      ),
    )
    .orderBy(t.cleanupDueAt)
    .limit(options.limit ?? 50);

  for (const row of rows) {
    report.attempted += 1;
    try {
      if (row.objectKey) await storage.deleteObject(row.objectKey);
      const done = await db.transaction(async (tx) => {
        const marked = await tx
          .update(t)
          .set({
            cleanedAt: sql`now()`,
            objectKey: null,
            wrappedKey: null,
            wrapNonce: null,
            wrapTag: null,
            updatedAt: sql`now()`,
          })
          .where(and(eq(t.id, row.id), isNull(t.cleanedAt)))
          .returning({ id: t.id });
        if (marked.length === 0) return false;
        await writeAudit(tx, {
          actorType: 'system',
          action: 'privacy_export.deleted',
          resourceType: 'privacy_export',
          resourceId: row.id,
          diff: { objectDeleted: row.objectKey !== null },
        });
        return true;
      });
      if (done) report.deleted += 1;
    } catch (err) {
      const attempts = row.cleanupAttempts + 1;
      const exhausted = attempts >= maxAttempts;
      await db
        .update(t)
        .set({
          cleanupAttempts: attempts,
          // The error's name only: a provider message can echo the request.
          cleanupLastError: err instanceof Error ? err.name : 'Error',
          cleanupDueAt: sql`now() + make_interval(secs => ${RETRY_BACKOFF_SECONDS(attempts)})`,
          ...(exhausted ? { cleanupDeadAt: sql`now()` } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(t.id, row.id), isNull(t.cleanedAt)));
      if (exhausted) report.dead += 1;
      else report.retried += 1;
    }
  }
  return report;
}
