import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
  reapAttemptObjects,
  type AttemptReapReport,
  closeLinkedRequestFailed,
  type ArtifactRow,
  type CleanupReport,
} from './export-artifacts';

export type PrivacyExportProcessorOptions = {
  workerId: string;
  mediaPublicBaseUrl: string;
  retentionMonths: number;
  leaseTtlMs?: number;
  /** Hard deadline on one upload (default 30 s). */
  uploadTimeoutMs?: number;
  /**
   * How long an attempt's deletion record waits before its first reap when the
   * attempt never reaches the upload (default lease TTL + 2 × upload deadline).
   * It is the crash backstop for the collection phase only: immediately before
   * the PUT the record is refreshed to cover the upload itself (PR #677
   * A-F-04), so a slow collection cannot let the record expire under a PUT.
   */
  attemptGraceMs?: number;
  maxPlaintextBytes?: number;
  ttlMs?: number;
  generationDeadlineMs?: number;
  /**
   * Test seam: runs after the export is sealed and before the upload is
   * permitted — where a lapsed lease, a fencing claim or a reaped record has
   * to be noticed before any byte leaves.
   */
  beforeUpload?: (artifactId: string) => Promise<void>;
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
  requestsReconciled: number;
  cleanup: CleanupReport;
  attemptObjects: AttemptReapReport;
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
 * key, build the allowlisted export, encrypt it in memory, re-arm the fence and
 * the attempt's deletion record immediately before the upload, upload it, then
 * publish in one short transaction that rechecks the fence and the subject's
 * export epoch under the user row lock. Publication, ledger completion, the
 * monthly counter and the in-app notification commit together, once.
 *
 * `sweep` expires, times out stuck generations and deletes what is due. It
 * needs the bucket and nothing else: a worker without wrapping keys still
 * sweeps (PR #677 S-F-11); only generation is gated on the keyring.
 *
 * Plain class: the worker builds it by hand, tests build it with fakes.
 */
export class PrivacyExportProcessor {
  private readonly leaseTtlMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly attemptGraceMs: number;
  private readonly maxPlaintextBytes: number;
  private readonly ttlMs: number;
  private readonly generationDeadlineMs: number;

  constructor(
    private readonly db: Db,
    private readonly storage: StoragePort,
    /** `null` = this worker sweeps but does not generate. */
    private readonly keyring: ExportKeyring | null,
    private readonly options: PrivacyExportProcessorOptions,
  ) {
    this.leaseTtlMs = options.leaseTtlMs ?? PRIVACY_EXPORT_DEFAULTS.leaseTtlMs;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? PRIVACY_EXPORT_DEFAULTS.uploadTimeoutMs;
    this.attemptGraceMs = options.attemptGraceMs ?? this.leaseTtlMs + 2 * this.uploadTimeoutMs;
    this.maxPlaintextBytes = options.maxPlaintextBytes ?? PRIVACY_EXPORT_DEFAULTS.maxPlaintextBytes;
    this.ttlMs = options.ttlMs ?? PRIVACY_EXPORT_DEFAULTS.ttlMs;
    this.generationDeadlineMs =
      options.generationDeadlineMs ?? PRIVACY_EXPORT_DEFAULTS.generationDeadlineMs;
  }

  /** Whether this worker holds a wrapping key, i.e. may generate at all. */
  get canGenerate(): boolean {
    return this.keyring !== null;
  }

  /**
   * The window a permitted upload may occupy, from the moment it is permitted:
   * the upload deadline plus one more for a PUT the abort could not recall.
   * The attempt's deletion record is re-armed to exactly this before the PUT.
   */
  private get uploadCoverMs(): number {
    return 2 * this.uploadTimeoutMs;
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
    // No key, no claim: the artifact waits for a worker that can seal it.
    if (!this.keyring) return report;
    for (let i = 0; i < limit; i += 1) {
      if (signal?.aborted) break;
      const claim = await this.claim();
      if (!claim) break;
      report[await this.generate(claim, this.keyring, signal)] += 1;
    }
    return report;
  }

  /**
   * One due artifact: pending and due, or generating with a lapsed lease. A
   * previous attempt's object needs nothing here: its durable attempt record
   * (written before it uploaded) deletes it once its grace has passed, and the
   * new attempt gets a fresh key of its own.
   */
  private async claim(): Promise<Claim | null> {
    const { rows } = await this.db.execute(sql`
      with due as (
        select id from privacy_export_artifacts
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
      returning a.id
    `);
    const claimed = rows[0] as { id: string } | undefined;
    if (!claimed) return null;
    const [row] = await this.db
      .select()
      .from(schema.privacyExportArtifacts)
      .where(eq(schema.privacyExportArtifacts.id, claimed.id));
    return row ?? null;
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

  private async generate(
    claim: Claim,
    keyring: ExportKeyring,
    signal?: AbortSignal,
  ): Promise<GenerationOutcome> {
    const objectKey = `${PRIVACY_EXPORT_PREFIX}${claim.id}/${claim.attempt}-${randomUUID()}.bin`;
    // PR #677 F-04 — the key and its durable deletion record are written
    // together, before any byte is uploaded. The record outlives every way
    // this attempt can end except publication.
    const persisted = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.privacyExportArtifacts)
        .set({ objectKey, updatedAt: sql`now()` })
        .where(this.fence(claim))
        .returning({ id: schema.privacyExportArtifacts.id });
      if (updated.length === 0) return false;
      await tx.insert(schema.privacyExportAttemptObjects).values({
        artifactId: claim.id,
        objectKey,
        deleteAfter: sql`now() + make_interval(secs => ${this.attemptGraceMs / 1000})`,
      });
      return true;
    });
    if (!persisted) return 'fenced';

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
        // F-03: the budget is charged while rows are read, page by page.
        { mediaPublicBaseUrl: this.options.mediaPublicBaseUrl, maxBytes: this.maxPlaintextBytes },
      );
      const plaintext = serializeBounded(doc, this.maxPlaintextBytes);
      try {
        sealed = sealExport(
          plaintext,
          { exportId: claim.id, subjectUserId: claim.subjectUserId },
          keyring,
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

    await this.options.beforeUpload?.(claim.id);

    // PR #677 A-F-04 — collection is unbounded, so nothing decided before it
    // still holds: the lease may have lapsed and been re-claimed, and the
    // attempt record may have been reaped. One statement, right before the
    // PUT, re-arms both or refuses the upload. Never a byte after a lost fence.
    if (signal?.aborted) return this.retryLater(claim);
    const permit = await this.permitUpload(claim, objectKey);
    if (permit !== 'permitted') return permit === 'fenced' ? 'fenced' : this.retryLater(claim);

    try {
      // Bounded even when a lease signal is passed: the attempt record now
      // covers `uploadCoverMs` from the permit, which outlasts this deadline.
      const deadline = AbortSignal.timeout(this.uploadTimeoutMs);
      await this.storage.putObject(objectKey, sealed.object, 'application/octet-stream', {
        cacheControl: 'no-store',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch {
      return this.retryLater(claim);
    }

    await this.options.afterUpload?.(claim.id);

    const outcome = await this.publish(claim, objectKey, sealed);
    // Unpublished ('fenced', 'revoked'): the attempt record deletes this object
    // once its grace passes, even if storage saw the PUT after a cleanup ran.
    if (outcome === 'grace_expired') return this.retryLater(claim);
    return outcome;
  }

  /**
   * The upload permit: in one transaction, the artifact row must still be this
   * attempt's (fence) — its lease is renewed — and this attempt's deletion
   * record must still exist, unclaimed by the reaper (A-F-10) and not dead —
   * its `delete_after` is moved to now + upload cover. `fenced` means another
   * attempt owns the artifact; `reaped` means this attempt's object key has
   * already been handed to deletion and a fresh attempt must take a new key.
   */
  private async permitUpload(
    claim: Claim,
    objectKey: string,
  ): Promise<'permitted' | 'fenced' | 'reaped'> {
    return this.db.transaction(async (tx) => {
      const fenced = await tx
        .update(schema.privacyExportArtifacts)
        .set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${this.leaseTtlMs / 1000})`,
          updatedAt: sql`now()`,
        })
        .where(and(this.fence(claim), eq(schema.privacyExportArtifacts.objectKey, objectKey)))
        .returning({ id: schema.privacyExportArtifacts.id });
      if (fenced.length === 0) return 'fenced';
      const o = schema.privacyExportAttemptObjects;
      const armed = await tx
        .update(o)
        .set({ deleteAfter: sql`now() + make_interval(secs => ${this.uploadCoverMs / 1000})` })
        .where(and(eq(o.objectKey, objectKey), isNull(o.reapingSince), isNull(o.deadAt)))
        .returning({ id: o.id });
      return armed.length === 0 ? 'reaped' : 'permitted';
    });
  }

  private async publish(
    claim: Claim,
    objectKey: string,
    sealed: SealedExport,
  ): Promise<'published' | 'fenced' | 'revoked' | 'grace_expired'> {
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

      // PR #677 F-04 / A-F-10 — publication takes this attempt's deletion
      // record out of the reaper's hands: only while its cover has not run
      // out, and only if the reaper has not already claimed it (`reaping_since`
      // is the reaper's committed ownership; once set, the object is on its
      // way out and this attempt must not become the ready artifact).
      const kept = await tx
        .delete(schema.privacyExportAttemptObjects)
        .where(
          and(
            eq(schema.privacyExportAttemptObjects.objectKey, objectKey),
            sql`${schema.privacyExportAttemptObjects.deleteAfter} > clock_timestamp()`,
            isNull(schema.privacyExportAttemptObjects.deadAt),
            isNull(schema.privacyExportAttemptObjects.reapingSince),
          ),
        )
        .returning({ id: schema.privacyExportAttemptObjects.id });
      if (kept.length === 0) return 'grace_expired';

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

    const reconciled = await this.reconcileStrandedRequests();
    const cleanup = await cleanupDueArtifacts(this.db, this.storage);
    const attempts = await reapAttemptObjects(this.db, this.storage);

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
    const { rows: attemptRows } = await this.db.execute(sql`
      select
        count(*) filter (where dead_at is null)::int as pending,
        count(*) filter (where dead_at is not null)::int as dead,
        count(*) filter (where dead_at is null
          and delete_after < now() - interval '5 minutes')::int as overdue
      from privacy_export_attempt_objects
    `);
    const attemptCounts = attemptRows[0] as { pending: number; dead: number; overdue: number };

    return {
      expired: expired.rows.length,
      timedOut,
      requestsReconciled: reconciled,
      cleanup,
      attemptObjects: attempts,
      tombstonesPurged: purged.rows.length,
      // Attempt records are deletion work too: one gauge covers both queues.
      cleanupPending: counts.pending + attemptCounts.pending,
      cleanupDeadLettered: counts.dead + attemptCounts.dead,
      cleanupOverdue: counts.overdue + attemptCounts.overdue,
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
    const attempts = await this.db.execute(sql`
      update privacy_export_attempt_objects
      set dead_at = null, attempts = 0, delete_after = now()
      where dead_at is not null
      returning id
    `);
    return res.rows.length + attempts.rows.length;
  }

  /**
   * PR #677 F-07 — a request whose artifact was revoked (or failed) before it
   * became available would otherwise stay `in_progress` forever. Closed
   * `failed` once — retention stamped, `export_failed` counted — unless another
   * artifact for the same request is still live (a CMS re-execution).
   */
  private async reconcileStrandedRequests(): Promise<number> {
    const { rows } = await this.db.execute(sql`
      select distinct a.privacy_request_id as request_id
      from privacy_export_artifacts a
      join privacy_requests r on r.id = a.privacy_request_id
      where a.state in ('revoked', 'failed')
        and r.status <> 'closed'
        and not exists (
          select 1 from privacy_export_artifacts live
          where live.privacy_request_id = a.privacy_request_id
            and live.state in ('pending', 'generating', 'ready')
        )
      limit 100
    `);
    let closed = 0;
    for (const { request_id } of rows as { request_id: string }[]) {
      const done = await this.db.transaction(async (tx) => {
        // PR #677 A-F-07 — the lock first, on its own. A re-execution holding
        // this row inserts its artifact and commits while we wait; a
        // `not exists` in the same statement as the lock would still be
        // evaluated against the snapshot taken before that commit. The
        // live-artifact check is therefore a second statement, taken after
        // the lock is granted, with a snapshot of its own.
        const { rows: locked } = await tx.execute(sql`
          select 1 from privacy_requests
          where id = ${request_id}::uuid and status <> 'closed'
          for update
        `);
        if (locked.length === 0) return false;
        const { rows: live } = await tx.execute(sql`
          select 1 from privacy_export_artifacts
          where privacy_request_id = ${request_id}::uuid
            and state in ('pending', 'generating', 'ready')
          limit 1
        `);
        if (live.length > 0) return false;
        await closeLinkedRequestFailed(tx, request_id, this.options.retentionMonths);
        await writeAudit(tx, {
          actorType: 'system',
          action: 'privacy_request.export_failed',
          resourceType: 'privacy_request',
          resourceId: request_id,
          diff: { reason: 'artifact_not_delivered' },
        });
        return true;
      });
      if (done) closed += 1;
    }
    return closed;
  }
}
