import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { StoragePort } from '@gogo/providers';
import { RETRY_BACKOFF_SECONDS } from '../../notifications/application/outbox-dispatcher';
import { writeAudit } from '../../shared/audit';
import type { Tx } from '../../shared/outbox';
import { collectUserExport } from '../../reviews/application/user-export';
import {
  ExportTooLargeError,
  sealExport,
  serializeBounded,
  type ExportKeyring,
  type SealedExport,
} from '../domain/export-envelope';
import {
  PRIVACY_EXPORT_DEFAULTS,
  PRIVACY_EXPORT_PREFIX,
  cleanupDueArtifacts,
  closeLinkedRequestCompleted,
  closeLinkedRequestFailed,
  type ArtifactRow,
  type CleanupReport,
} from './export-artifacts';

export type PrivacyExportProcessorOptions = {
  workerId: string;
  mediaPublicBaseUrl: string;
  retentionMonths: number;
  leaseTtlMs?: number;
  maxPlaintextBytes?: number;
  ttlMs?: number;
  generationDeadlineMs?: number;
  /**
   * Test seam: runs after the ciphertext is in storage and before publication
   * is attempted — exactly where a crash, a stale lease or a revocation race
   * has to be survivable.
   */
  afterUpload?: (artifactId: string) => Promise<void>;
};

type Claim = ArtifactRow;

export type GenerationOutcome =
  'published' | 'fenced' | 'revoked' | 'failed' | 'retry_scheduled' | 'too_large';

export type GenerationReport = Record<GenerationOutcome, number>;

export type SweepReport = {
  expired: number;
  timedOut: number;
  cleanup: CleanupReport;
  tombstonesPurged: number;
  cleanupPending: number;
  cleanupDeadLettered: number;
  /** Cleanup due for more than five minutes — the healthy-deletion target. */
  cleanupOverdue: number;
};

/**
 * GoGo-BE#256, ADR-0031 §4/§6 — the worker half of secure export delivery.
 *
 * `runDue` generates: claim one due artifact under a fenced lease (the
 * `attempt` counter is the fencing token), persist an attempt-specific object
 * key, build the allowlisted export, encrypt it in memory, upload it, then
 * publish in one short transaction that rechecks the fence and the subject's
 * export epoch under the user row lock. Publication, ledger completion, the
 * monthly counter and the in-app notification commit together, once.
 *
 * `sweep` expires, times out stuck generations and deletes what is due.
 *
 * Plain class: the worker builds it by hand, tests build it with fakes.
 */
export class PrivacyExportProcessor {
  private readonly leaseTtlMs: number;
  private readonly maxPlaintextBytes: number;
  private readonly ttlMs: number;
  private readonly generationDeadlineMs: number;

  constructor(
    private readonly db: Db,
    private readonly storage: StoragePort,
    private readonly keyring: ExportKeyring,
    private readonly options: PrivacyExportProcessorOptions,
  ) {
    this.leaseTtlMs = options.leaseTtlMs ?? PRIVACY_EXPORT_DEFAULTS.leaseTtlMs;
    this.maxPlaintextBytes = options.maxPlaintextBytes ?? PRIVACY_EXPORT_DEFAULTS.maxPlaintextBytes;
    this.ttlMs = options.ttlMs ?? PRIVACY_EXPORT_DEFAULTS.ttlMs;
    this.generationDeadlineMs =
      options.generationDeadlineMs ?? PRIVACY_EXPORT_DEFAULTS.generationDeadlineMs;
  }

  /** Bounded: at most `limit` generations per tick, one at a time. */
  async runDue(limit = 2, signal?: AbortSignal): Promise<GenerationReport> {
    const report: GenerationReport = {
      published: 0,
      fenced: 0,
      revoked: 0,
      failed: 0,
      retry_scheduled: 0,
      too_large: 0,
    };
    for (let i = 0; i < limit; i += 1) {
      if (signal?.aborted) break;
      const claim = await this.claim();
      if (!claim) break;
      report[await this.generate(claim, signal)] += 1;
    }
    return report;
  }

  /**
   * One due artifact: pending and due, or generating with a lapsed lease. The
   * key a previous attempt persisted is handed to the media cleanup queue in
   * the same transaction — that attempt may have uploaded before it died, and
   * the new attempt gets a fresh key of its own.
   */
  private async claim(): Promise<Claim | null> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`
        with due as (
          select id, object_key from privacy_export_artifacts
          where (state = 'pending' and next_attempt_at <= now())
             or (state = 'generating' and lease_expires_at < now())
          order by next_attempt_at, created_at
          limit 1
          for update skip locked
        )
        update privacy_export_artifacts a
        set state = 'generating',
            attempt = a.attempt + 1,
            lease_owner = ${this.options.workerId},
            lease_expires_at = now() + make_interval(secs => ${this.leaseTtlMs / 1000}),
            object_key = null,
            updated_at = now()
        from due
        where a.id = due.id
        returning a.id, due.object_key as stale_key
      `);
      const claimed = rows[0] as { id: string; stale_key: string | null } | undefined;
      if (!claimed) return null;
      if (claimed.stale_key) {
        await tx
          .insert(schema.mediaCleanupQueue)
          .values({
            bucket: 'private',
            objectKey: claimed.stale_key,
            reason: 'privacy_export_abandoned',
          })
          .onConflictDoNothing();
      }
      const [row] = await tx
        .select()
        .from(schema.privacyExportArtifacts)
        .where(eq(schema.privacyExportArtifacts.id, claimed.id));
      return row ?? null;
    });
  }

  /** The `where` every write of this attempt carries: it fails once fenced off. */
  private fence(claim: Claim) {
    const t = schema.privacyExportArtifacts;
    return and(
      eq(t.id, claim.id),
      eq(t.attempt, claim.attempt),
      eq(t.leaseOwner, this.options.workerId),
      eq(t.state, 'generating'),
    );
  }

  private async generate(claim: Claim, signal?: AbortSignal): Promise<GenerationOutcome> {
    const objectKey = `${PRIVACY_EXPORT_PREFIX}${claim.id}/${claim.attempt}-${randomUUID()}.bin`;
    const persisted = await this.db
      .update(schema.privacyExportArtifacts)
      .set({ objectKey, updatedAt: sql`now()` })
      .where(this.fence(claim))
      .returning({ id: schema.privacyExportArtifacts.id });
    if (persisted.length === 0) return 'fenced';

    let sealed: SealedExport;
    try {
      const doc = await collectUserExport(
        this.db,
        claim.subjectUserId,
        {
          actorType: claim.initiatorType === 'admin' ? 'admin' : 'user',
          actorId: claim.initiatorId,
          reason: `privacy_export:${claim.id}`,
        },
        { mediaPublicBaseUrl: this.options.mediaPublicBaseUrl },
      );
      const plaintext = serializeBounded(doc, this.maxPlaintextBytes);
      try {
        sealed = sealExport(
          plaintext,
          { exportId: claim.id, subjectUserId: claim.subjectUserId },
          this.keyring,
        );
      } finally {
        plaintext.fill(0);
      }
    } catch (err) {
      if (err instanceof ExportTooLargeError) {
        return (await this.fail(claim, 'too_large')) ? 'too_large' : 'fenced';
      }
      return this.retryLater(claim);
    }

    try {
      if (signal?.aborted) throw new Error('lease lost');
      await this.storage.putObject(objectKey, sealed.object, 'application/octet-stream', {
        cacheControl: 'no-store',
        ...(signal ? { signal } : {}),
      });
    } catch {
      return this.retryLater(claim);
    }

    await this.options.afterUpload?.(claim.id);

    const outcome = await this.publish(claim, objectKey, sealed);
    if (outcome === 'fenced') {
      // Another attempt owns the row now; this object is ours alone to remove.
      await this.db
        .insert(schema.mediaCleanupQueue)
        .values({ bucket: 'private', objectKey, reason: 'privacy_export_fenced' })
        .onConflictDoNothing();
    }
    // 'revoked': the row still names this key, so its own cleanup removes it.
    return outcome;
  }

  private async publish(
    claim: Claim,
    objectKey: string,
    sealed: SealedExport,
  ): Promise<'published' | 'fenced' | 'revoked'> {
    return this.db.transaction(async (tx) => {
      // The user row first, the same lock deletion and credential changes take
      // (an UPDATE of the row), so an epoch bump either committed before this
      // read or waits until publication is decided.
      const { rows: userRows } = await tx.execute(sql`
        select export_epoch, status from users where id = ${claim.subjectUserId}::uuid
        for no key update
      `);
      const user = userRows[0] as { export_epoch: number; status: string } | undefined;
      const t = schema.privacyExportArtifacts;
      const [row] = await tx.select().from(t).where(eq(t.id, claim.id)).for('update');
      if (
        !row ||
        row.state !== 'generating' ||
        row.attempt !== claim.attempt ||
        row.leaseOwner !== this.options.workerId ||
        row.objectKey !== objectKey
      ) {
        return row?.objectKey === objectKey ? 'revoked' : 'fenced';
      }
      if (!user || user.export_epoch !== row.subjectEpoch || user.status !== 'active') {
        // The trigger revokes on every epoch bump; this is the belt to its braces.
        await tx
          .update(t)
          .set({
            state: 'revoked',
            revokedAt: sql`now()`,
            revokeReason: 'epoch_mismatch',
            leaseOwner: null,
            leaseExpiresAt: null,
            cleanupDueAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(t.id, row.id));
        await this.audit(tx, row.id, 'privacy_export.revoked', { reason: 'epoch_mismatch' });
        return 'revoked';
      }

      // Both from the transaction clock, so the window is exactly the TTL.
      const [published] = await tx
        .update(t)
        .set({
          state: 'ready',
          readyAt: sql`now()`,
          expiresAt: sql`now() + make_interval(secs => ${this.ttlMs / 1000})`,
          formatVersion: sealed.formatVersion,
          keyVersion: sealed.keyVersion,
          wrappedKey: sealed.wrappedKey,
          wrapNonce: sealed.wrapNonce,
          wrapTag: sealed.wrapTag,
          plaintextBytes: sealed.plaintextBytes,
          ciphertextBytes: sealed.object.byteLength,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(t.id, row.id))
        .returning({ expiresAt: t.expiresAt });
      const expiresAt = published!.expiresAt!;
      await closeLinkedRequestCompleted(tx, row.privacyRequestId, this.options.retentionMonths);
      // In-app only, and idempotent on the artifact: a notification carries the
      // id and the expiry, never data, a key or a URL that authorizes anything.
      await tx
        .insert(schema.notifications)
        .values({
          userId: row.subjectUserId,
          kind: 'privacy_export_ready',
          payload: { exportId: row.id, expiresAt: expiresAt.toISOString() },
          dedupeKey: `privacy_export_ready:${row.id}`,
        })
        .onConflictDoNothing();
      await this.audit(tx, row.id, 'privacy_export.ready', {
        keyVersion: sealed.keyVersion,
        attempt: row.attempt,
      });
      return 'published';
    });
  }

  /** Terminal failure for this artifact. False when the attempt was fenced off. */
  private async fail(claim: Claim, code: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const failed = await tx
        .update(schema.privacyExportArtifacts)
        .set({
          state: 'failed',
          failedAt: sql`now()`,
          failureCode: code,
          leaseOwner: null,
          leaseExpiresAt: null,
          cleanupDueAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(this.fence(claim))
        .returning({ requestId: schema.privacyExportArtifacts.privacyRequestId });
      if (failed.length === 0) return false;
      await closeLinkedRequestFailed(tx, failed[0]!.requestId, this.options.retentionMonths);
      await this.audit(tx, claim.id, 'privacy_export.failed', { reason: code });
      return true;
    });
  }

  /** Back to pending with backoff, keeping the persisted key for the next claim to clean. */
  private async retryLater(claim: Claim): Promise<GenerationOutcome> {
    const failures = claim.generationFailures + 1;
    if (failures >= PRIVACY_EXPORT_DEFAULTS.maxGenerationFailures) {
      return (await this.fail(claim, 'generation_failed')) ? 'failed' : 'fenced';
    }
    const updated = await this.db
      .update(schema.privacyExportArtifacts)
      .set({
        state: 'pending',
        generationFailures: failures,
        nextAttemptAt: sql`now() + make_interval(secs => ${RETRY_BACKOFF_SECONDS(failures)})`,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(this.fence(claim))
      .returning({ id: schema.privacyExportArtifacts.id });
    return updated.length > 0 ? 'retry_scheduled' : 'fenced';
  }

  private audit(tx: Tx, artifactId: string, action: string, diff: Record<string, unknown>) {
    return writeAudit(tx, {
      actorType: 'system',
      action,
      resourceType: 'privacy_export',
      resourceId: artifactId,
      diff,
    });
  }

  /**
   * The one-minute sweep. Expiry is also enforced synchronously at redemption;
   * this is what turns an expired artifact into a deleted one.
   */
  async sweep(): Promise<SweepReport> {
    const expired = await this.db.execute(sql`
      with expired as (
        update privacy_export_artifacts
        set state = 'expired', expired_at = now(),
            wrapped_key = null, wrap_nonce = null, wrap_tag = null,
            cleanup_due_at = now(), updated_at = now()
        where state = 'ready' and expires_at <= now()
        returning id
      )
      insert into audit_logs (actor_type, action, resource_type, resource_id, diff)
      select 'system', 'privacy_export.expired', 'privacy_export', id::text, '{}'::jsonb
      from expired
      returning resource_id
    `);

    const stuck = await this.db
      .select()
      .from(schema.privacyExportArtifacts)
      .where(
        and(
          sql`${schema.privacyExportArtifacts.state} in ('pending', 'generating')`,
          sql`${schema.privacyExportArtifacts.createdAt} <
            now() - make_interval(secs => ${this.generationDeadlineMs / 1000})`,
        ),
      )
      .limit(50);
    let timedOut = 0;
    for (const row of stuck) {
      const ok = await this.db.transaction(async (tx) => {
        const failed = await tx
          .update(schema.privacyExportArtifacts)
          .set({
            state: 'failed',
            failedAt: sql`now()`,
            failureCode: 'generation_timeout',
            leaseOwner: null,
            leaseExpiresAt: null,
            cleanupDueAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.privacyExportArtifacts.id, row.id),
              sql`${schema.privacyExportArtifacts.state} in ('pending', 'generating')`,
            ),
          )
          .returning({ id: schema.privacyExportArtifacts.id });
        if (failed.length === 0) return false;
        await closeLinkedRequestFailed(tx, row.privacyRequestId, this.options.retentionMonths);
        await this.audit(tx, row.id, 'privacy_export.failed', { reason: 'generation_timeout' });
        return true;
      });
      if (ok) timedOut += 1;
    }

    const cleanup = await cleanupDueArtifacts(this.db, this.storage);

    const purged = await this.db.execute(sql`
      delete from privacy_export_artifacts
      where cleaned_at is not null
        and cleaned_at < now() - make_interval(secs => ${PRIVACY_EXPORT_DEFAULTS.tombstoneRetentionMs / 1000})
      returning id
    `);

    const { rows } = await this.db.execute(sql`
      select
        count(*) filter (where cleanup_dead_at is null)::int as pending,
        count(*) filter (where cleanup_dead_at is not null)::int as dead,
        count(*) filter (where cleanup_dead_at is null
          and cleanup_due_at < now() - interval '5 minutes')::int as overdue
      from privacy_export_artifacts
      where cleanup_due_at is not null and cleaned_at is null
    `);
    const counts = rows[0] as { pending: number; dead: number; overdue: number };

    return {
      expired: expired.rows.length,
      timedOut,
      cleanup,
      tombstonesPurged: purged.rows.length,
      cleanupPending: counts.pending,
      cleanupDeadLettered: counts.dead,
      cleanupOverdue: counts.overdue,
    };
  }

  /** Explicit redrive (runbook): dead-lettered cleanups become due again. */
  async redriveDeadLettered(): Promise<number> {
    const res = await this.db.execute(sql`
      update privacy_export_artifacts
      set cleanup_dead_at = null, cleanup_attempts = 0, cleanup_due_at = now(), updated_at = now()
      where cleanup_dead_at is not null and cleaned_at is null
      returning id
    `);
    return res.rows.length;
  }
}
