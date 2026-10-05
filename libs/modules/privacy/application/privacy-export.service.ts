import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import {
  ProviderUnavailableError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type StoragePort,
} from '@gogo/providers';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import type { Tx } from '../../shared/outbox';
import {
  beginIdempotent,
  completeIdempotentWithin,
  releaseIdempotent,
  type IdempotencyScope,
} from '../../shared/idempotency.interceptor';
import {
  bumpPrivacyMetrics,
  dueDates,
  monthKey,
  type SlaConfig,
} from '../../shared/privacy-ledger';
import type { Actor } from '../../identity/domain/actor';
import {
  EXPORT_ENVELOPE_OVERHEAD,
  ExportIntegrityError,
  ExportKeyUnavailableError,
  openExport,
  type ExportKeyring,
} from '../domain/export-envelope';
import {
  ACTIVE_STATES,
  PRIVACY_EXPORT_DEFAULTS,
  cleanupDueArtifacts,
  toAdminExportStatus,
  toExportStatus,
  type ArtifactRow,
  type ExportStatusDto,
} from './export-artifacts';

export const PRIVACY_EXPORT_OPTIONS = Symbol('PRIVACY_EXPORT_OPTIONS');

export type PrivacyExportOptions = {
  /** `null` = no wrapping key configured: issuance and redemption are unavailable. */
  keyring: ExportKeyring | null;
  /** False in an environment that must not keep exports in the in-memory fake. */
  storageReady: boolean;
  sla: SlaConfig;
  retentionMonths: number;
  maxPlaintextBytes?: number;
  maxConcurrentDownloads?: number;
};

type Initiator = { type: 'user' | 'admin'; id: string };

type LedgerLink =
  | { kind: 'self_service' }
  | { kind: 'cms_direct'; reason: string }
  | { kind: 'existing'; requestId: string };

export type RedeemedExport = {
  artifactId: string;
  body: Buffer;
  filename: string;
  /** Called exactly once by the transport: did the bytes leave the server? */
  finalize(outcome: 'completed' | 'aborted'): Promise<void>;
};

const isUniqueViolation = (err: unknown, constraint: string) => {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const c = e.code === '23505' ? e : e.cause?.code === '23505' ? e.cause : undefined;
  return c !== undefined && c.constraint === constraint;
};

/**
 * GoGo-BE#256, ADR-0031 — the API half of secure export delivery.
 *
 * Issuance (self-service and CMS) creates a durable `pending` artifact and its
 * ledger link in one transaction; the worker generates it. Redemption is an
 * authenticated POST by the subject's own active session, consumed atomically
 * after the ciphertext has authenticated and before any byte is sent.
 *
 * Owner decision 2026-10-05: there is no path for a subject who cannot sign
 * in — account recovery first; staff never forward raw data.
 */
export class PrivacyExportService {
  private activeDownloads = 0;

  constructor(
    private readonly db: Db,
    private readonly storage: StoragePort,
    private readonly options: PrivacyExportOptions,
  ) {}

  private assertAvailable(): void {
    if (!this.options.keyring || !this.options.storageReady) {
      throw AppError.serviceUnavailable(
        'EXPORT_UNAVAILABLE',
        'Secure export is not configured in this environment',
        false,
      );
    }
  }

  // --- issuance -------------------------------------------------------------

  /** `POST /me/exports` — Idempotency-Key required; a replay returns metadata only. */
  async createForSelf(
    actor: Actor,
    scope: IdempotencyScope,
  ): Promise<{ replayed: boolean; export: ExportStatusDto }> {
    const userId = requireUserActor(actor);
    this.assertAvailable();
    const begun = await beginIdempotent(this.db, scope);
    if (begun.kind === 'replay') {
      const exportId = (begun.body as { exportId?: unknown } | null)?.exportId;
      if (typeof exportId !== 'string') throw AppError.internal('Replay record names no export');
      return { replayed: true, export: await this.status(actor, exportId) };
    }
    try {
      const row = await this.db.transaction(async (tx) => {
        const created = await this.createArtifactTx(tx, {
          subjectUserId: userId,
          initiator: { type: 'user', id: userId },
          link: { kind: 'self_service' },
        });
        if (!(await completeIdempotentWithin(tx, begun.claim, 202, { exportId: created.id }))) {
          throw new AppError(
            'IDEMPOTENT_REQUEST_IN_FLIGHT',
            'Idempotency claim was lost; retry the request',
            409,
            { retryable: true },
          );
        }
        return created;
      });
      return { replayed: false, export: toExportStatus(row) };
    } catch (err) {
      await releaseIdempotent(this.db, begun.claim).catch(() => undefined);
      throw err;
    }
  }

  /** `POST /cms/users/{id}/export` — creates its own linked ledger request. */
  async createForCmsSubject(input: { subjectUserId: string; adminId: string; reason: string }) {
    this.assertAvailable();
    const row = await this.db.transaction((tx) =>
      this.createArtifactTx(tx, {
        subjectUserId: input.subjectUserId,
        initiator: { type: 'admin', id: input.adminId },
        link: { kind: 'cms_direct', reason: input.reason },
      }),
    );
    return { privacyRequestId: row.privacyRequestId!, export: toAdminExportStatus(row) };
  }

  /** `POST /cms/privacy-requests/{id}/execute` for an export request. */
  async createForRequest(input: { requestId: string; subjectUserId: string; adminId: string }) {
    this.assertAvailable();
    const row = await this.db.transaction((tx) =>
      this.createArtifactTx(tx, {
        subjectUserId: input.subjectUserId,
        initiator: { type: 'admin', id: input.adminId },
        link: { kind: 'existing', requestId: input.requestId },
      }),
    );
    return toAdminExportStatus(row);
  }

  /** The latest artifact for a ledger row, for the CMS detail view. */
  async forRequest(requestId: string) {
    const [row] = await this.db
      .select()
      .from(schema.privacyExportArtifacts)
      .where(eq(schema.privacyExportArtifacts.privacyRequestId, requestId))
      .orderBy(sql`${schema.privacyExportArtifacts.createdAt} desc`)
      .limit(1);
    return row ? toAdminExportStatus(row) : undefined;
  }

  /**
   * One active artifact per subject, three generations per subject per hour,
   * across every entry point. Both checks run under the user row lock, so two
   * concurrent requests cannot both pass them; the partial unique index is the
   * last word if anything else ever writes this table.
   */
  private async createArtifactTx(
    tx: Tx,
    input: { subjectUserId: string; initiator: Initiator; link: LedgerLink },
  ): Promise<ArtifactRow> {
    const { rows } = await tx.execute(sql`
      select status, export_epoch from users where id = ${input.subjectUserId}::uuid
      for no key update
    `);
    const user = rows[0] as { status: string; export_epoch: number } | undefined;
    if (!user) throw AppError.notFound('USER_NOT_FOUND', 'No such account');
    if (user.status !== 'active') {
      // Only the subject's own active session can redeem; an account that
      // cannot sign in is recovered first (owner decision 2026-10-05).
      throw AppError.conflict(
        'SUBJECT_CANNOT_SIGN_IN',
        'The account must be able to sign in to receive a secure export',
      );
    }
    const t = schema.privacyExportArtifacts;
    const [active] = await tx
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.subjectUserId, input.subjectUserId),
          sql`${t.state} in (${sql.join(
            ACTIVE_STATES.map((s) => sql`${s}`),
            sql`, `,
          )})`,
        ),
      )
      .limit(1);
    if (active) {
      throw AppError.conflict('EXPORT_ALREADY_ACTIVE', 'An export is already in progress', [
        { field: 'exportId', code: 'active', message: active.id },
      ]);
    }
    const { rows: recent } = await tx.execute(sql`
      select count(*)::int as n, min(created_at) as oldest from privacy_export_artifacts
      where subject_user_id = ${input.subjectUserId}::uuid
        and created_at > now() - interval '1 hour'
    `);
    const window = recent[0] as { n: number; oldest: Date | string | null };
    if (window.n >= PRIVACY_EXPORT_DEFAULTS.generationsPerHour) {
      const oldest = window.oldest ? new Date(window.oldest).getTime() : Date.now();
      throw AppError.tooManyRequests(
        'Too many exports requested; try again later',
        Math.max(1, Math.ceil((oldest + 3_600_000 - Date.now()) / 1000)),
      );
    }

    const requestId = await this.linkLedger(tx, input);
    let row: ArtifactRow | undefined;
    try {
      [row] = await tx
        .insert(t)
        .values({
          subjectUserId: input.subjectUserId,
          privacyRequestId: requestId,
          initiatorType: input.initiator.type,
          initiatorId: input.initiator.id,
          subjectEpoch: user.export_epoch,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err, 'privacy_export_artifacts_one_active')) {
        throw AppError.conflict('EXPORT_ALREADY_ACTIVE', 'An export is already in progress');
      }
      throw err;
    }
    await writeAudit(tx, {
      actorType: input.initiator.type,
      actorId: input.initiator.id,
      action: 'privacy_export.requested',
      resourceType: 'privacy_export',
      resourceId: row!.id,
      diff: { privacyRequestId: requestId, initiatorType: input.initiator.type },
    });
    return row!;
  }

  /**
   * The ledger row this artifact fulfils: born `in_progress` for a new
   * request, moved to `in_progress` for an executed one. It closes
   * `completed` only when the artifact becomes available (worker).
   */
  private async linkLedger(
    tx: Tx,
    input: { subjectUserId: string; initiator: Initiator; link: LedgerLink },
  ): Promise<string> {
    const now = new Date();
    if (input.link.kind === 'existing') {
      const [moved] = await tx
        .update(schema.privacyRequests)
        .set({
          status: 'in_progress',
          acknowledgedAt: sql`coalesce(${schema.privacyRequests.acknowledgedAt}, now())`,
          executedAt: now,
          executedByAdminId: input.initiator.id,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.privacyRequests.id, input.link.requestId),
            sql`${schema.privacyRequests.status} <> 'closed'`,
          ),
        )
        .returning({ id: schema.privacyRequests.id });
      if (!moved) throw AppError.conflict('ALREADY_CLOSED', 'This request is already closed');
      return moved.id;
    }
    const { ackDueAt, fulfillmentDueAt } = dueDates(this.options.sla, 'export', now);
    const [created] = await tx
      .insert(schema.privacyRequests)
      .values({
        type: 'export',
        source: input.link.kind === 'self_service' ? 'self_service' : 'cms',
        status: 'in_progress',
        subjectType: 'user',
        userId: input.subjectUserId,
        identityStatus: 'matched',
        receivedAt: now,
        ackDueAt,
        acknowledgedAt: now,
        fulfillmentDueAt,
        ...(input.link.kind === 'cms_direct'
          ? {
              executedAt: now,
              executedByAdminId: input.initiator.id,
              createdByAdminId: input.initiator.id,
              operatorNote: input.link.reason.slice(0, 256),
            }
          : {}),
      })
      .returning({ id: schema.privacyRequests.id });
    await bumpPrivacyMetrics(tx, monthKey(now), ['export_received']);
    return created!.id;
  }

  // --- status ---------------------------------------------------------------

  /** `GET /me/exports/{id}`. Another account's id is a 404, never a 403. */
  async status(actor: Actor, id: string): Promise<ExportStatusDto> {
    const userId = requireUserActor(actor);
    return toExportStatus(await this.loadOwned(userId, id));
  }

  private async loadOwned(userId: string, id: string): Promise<ArtifactRow> {
    const [row] = await this.db
      .select()
      .from(schema.privacyExportArtifacts)
      .where(
        and(
          eq(schema.privacyExportArtifacts.id, id),
          eq(schema.privacyExportArtifacts.subjectUserId, userId),
        ),
      )
      .limit(1);
    if (!row) throw AppError.notFound('EXPORT_NOT_FOUND', 'No such export');
    return row;
  }

  // --- redemption -----------------------------------------------------------

  /**
   * `POST /me/exports/{id}/download`. Order matters:
   *
   * 1. the session is checked against the database, not the Redis denylist
   *    the guard consulted — a revocation is honoured even while Redis is down;
   * 2. state, expiry and epoch are checked cheaply;
   * 3. the ciphertext is fetched (bounded) and fully authenticated — no
   *    plaintext exists outside this call until `final()` has passed;
   * 4. one short transaction locks the user, rechecks expiry and epoch and
   *    moves `ready → consumed`. Only the winner gets bytes; every other
   *    concurrent or replayed attempt is a 410.
   */
  async redeem(actor: Actor, id: string): Promise<RedeemedExport> {
    const userId = requireUserActor(actor);
    this.assertAvailable();
    await this.assertLiveSession(userId, actor.sessionId);

    const row = await this.loadOwned(userId, id);
    assertRedeemable(row);

    const limit =
      this.options.maxConcurrentDownloads ?? PRIVACY_EXPORT_DEFAULTS.maxConcurrentDownloads;
    if (this.activeDownloads >= limit) {
      throw AppError.serviceUnavailable('EXPORT_BUSY', 'Too many downloads in progress', true);
    }
    // PR #677 F-02 — the slot covers the plaintext's whole life: it is held
    // through the transfer and released exactly once, by `finalize` or by a
    // failure before any byte could be sent — never when this method returns.
    this.activeDownloads += 1;
    let slotHeld = true;
    const releaseSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      this.activeDownloads -= 1;
    };
    try {
      const plaintext = await this.decryptVerified(row);
      const outcome = await this.consume(row, userId, actor.sessionId);
      if (outcome !== 'consumed') {
        plaintext.fill(0);
        if (outcome === 'session_revoked') {
          throw AppError.unauthorized('SESSION_REVOKED', 'Session is no longer valid');
        }
        throw AppError.gone('EXPORT_GONE', 'This export is no longer available');
      }
      let finalized = false;
      return {
        artifactId: row.id,
        body: plaintext,
        filename: `gogo-export-${row.readyAt!.toISOString().slice(0, 10)}.json`,
        finalize: async (transfer) => {
          if (finalized) return;
          finalized = true;
          plaintext.fill(0);
          releaseSlot();
          await this.finalizeTransfer(row, userId, transfer);
        },
      };
    } catch (err) {
      releaseSlot();
      throw err;
    }
  }

  /** Downloads currently holding plaintext (admitted, not yet finalized). */
  get downloadsInFlight(): number {
    return this.activeDownloads;
  }

  private async assertLiveSession(userId: string, sessionId: string): Promise<void> {
    const { rows } = await this.db.execute(sql`
      select 1 from auth_sessions s join users u on u.id = s.user_id
      where s.id = ${sessionId}::uuid and s.user_id = ${userId}::uuid
        and s.revoked_at is null and u.status = 'active'
      limit 1
    `);
    if (rows.length === 0) {
      throw AppError.unauthorized('SESSION_REVOKED', 'Session is no longer valid');
    }
  }

  private async decryptVerified(row: ArtifactRow): Promise<Buffer> {
    const maxPlain = this.options.maxPlaintextBytes ?? PRIVACY_EXPORT_DEFAULTS.maxPlaintextBytes;
    let object: Uint8Array;
    try {
      object = (
        await this.storage.getObject(row.objectKey!, {
          maxBytes: maxPlain + EXPORT_ENVELOPE_OVERHEAD,
        })
      ).body;
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        await this.markIntegrityFailure(row, 'object_missing');
        throw integrityError();
      }
      if (err instanceof StorageObjectTooLargeError) {
        await this.markIntegrityFailure(row, 'object_oversize');
        throw integrityError();
      }
      if (err instanceof ProviderUnavailableError) {
        throw AppError.serviceUnavailable('STORAGE_UNAVAILABLE', 'Storage is not answering', true);
      }
      throw err;
    }
    try {
      return openExport(
        object,
        {
          keyVersion: row.keyVersion!,
          wrappedKey: row.wrappedKey!,
          wrapNonce: row.wrapNonce!,
          wrapTag: row.wrapTag!,
        },
        { exportId: row.id, subjectUserId: row.subjectUserId },
        this.options.keyring,
      );
    } catch (err) {
      if (err instanceof ExportKeyUnavailableError) {
        // Fail closed and keep the artifact: restoring the key version fixes it.
        throw AppError.serviceUnavailable(
          'EXPORT_KEY_UNAVAILABLE',
          'This export cannot be opened in this environment',
          false,
        );
      }
      if (err instanceof ExportIntegrityError) {
        await this.markIntegrityFailure(row, `integrity_${err.stage}`);
        throw integrityError();
      }
      throw err;
    }
  }

  private async markIntegrityFailure(row: ArtifactRow, code: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const failed = await tx
        .update(schema.privacyExportArtifacts)
        .set({
          state: 'failed',
          failedAt: sql`now()`,
          failureCode: code,
          wrappedKey: null,
          wrapNonce: null,
          wrapTag: null,
          cleanupDueAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.privacyExportArtifacts.id, row.id),
            eq(schema.privacyExportArtifacts.state, 'ready'),
          ),
        )
        .returning({ id: schema.privacyExportArtifacts.id });
      if (failed.length === 0) return;
      await writeAudit(tx, {
        actorType: 'system',
        action: 'privacy_export.failed',
        resourceType: 'privacy_export',
        resourceId: row.id,
        diff: { reason: code },
      });
    });
    await cleanupDueArtifacts(this.db, this.storage, { ids: [row.id] }).catch(() => undefined);
  }

  /**
   * The atomic single-use transition, decided under locks:
   *
   * - the user row (`for no key update`), the lock deletion and credential
   *   changes take, so the epoch read is current;
   * - the session row (`for share`), so a sign-out committed while the
   *   ciphertext was being fetched is seen here and one still running waits
   *   for this decision (PR #677 F-01);
   * - expiry against `clock_timestamp()` — the wall clock after the locks were
   *   granted, not the transaction's start (`now()`), which may predate a long
   *   lock wait (PR #677 F-05).
   */
  private async consume(
    row: ArtifactRow,
    userId: string,
    sessionId: string,
  ): Promise<'consumed' | 'gone' | 'session_revoked'> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`
        select export_epoch, status from users where id = ${userId}::uuid for no key update
      `);
      const user = rows[0] as { export_epoch: number; status: string } | undefined;
      if (!user || user.status !== 'active') return 'gone';
      const { rows: session } = await tx.execute(sql`
        select 1 from auth_sessions
        where id = ${sessionId}::uuid and user_id = ${userId}::uuid and revoked_at is null
        for share
      `);
      if (session.length === 0) return 'session_revoked';
      const t = schema.privacyExportArtifacts;
      const won = await tx
        .update(t)
        .set({
          state: 'consumed',
          consumedAt: sql`clock_timestamp()`,
          consumedSessionId: sessionId,
          wrappedKey: null,
          wrapNonce: null,
          wrapTag: null,
          cleanupDueAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(t.id, row.id),
            eq(t.state, 'ready'),
            sql`${t.expiresAt} > clock_timestamp()`,
            eq(t.subjectEpoch, user.export_epoch),
          ),
        )
        .returning({ id: t.id });
      if (won.length === 0) return 'gone';
      await writeAudit(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'privacy_export.consumed',
        resourceType: 'privacy_export',
        resourceId: row.id,
      });
      return 'consumed';
    });
  }

  /**
   * The transfer outcome, observed by the server. `delivered_at` on the ledger
   * is set only for a completed transfer; an interrupted one stays unset and
   * the subject regenerates (single-use means one admitted transfer).
   */
  private async finalizeTransfer(
    row: ArtifactRow,
    userId: string,
    outcome: 'completed' | 'aborted',
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const marked = await tx
        .update(schema.privacyExportArtifacts)
        .set({
          transferOutcome: outcome,
          ...(outcome === 'completed' ? { transferCompletedAt: sql`now()` } : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.privacyExportArtifacts.id, row.id),
            sql`${schema.privacyExportArtifacts.transferOutcome} is null`,
          ),
        )
        .returning({ id: schema.privacyExportArtifacts.id });
      if (marked.length === 0) return;
      if (outcome === 'completed' && row.privacyRequestId) {
        await tx
          .update(schema.privacyRequests)
          .set({
            deliveryMethod: 'secure_download',
            deliveredAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.privacyRequests.id, row.privacyRequestId),
              sql`${schema.privacyRequests.deliveredAt} is null`,
            ),
          );
      }
      await writeAudit(tx, {
        actorType: 'user',
        actorId: userId,
        action:
          outcome === 'completed'
            ? 'privacy_export.transfer_completed'
            : 'privacy_export.transfer_aborted',
        resourceType: 'privacy_export',
        resourceId: row.id,
      });
    });
    // Immediate cleanup; the worker sweep retries whatever storage refuses.
    await cleanupDueArtifacts(this.db, this.storage, { ids: [row.id] }).catch(() => undefined);
  }
}

function integrityError(): AppError {
  return new AppError(
    'EXPORT_INTEGRITY_FAILED',
    'This export could not be verified; request a new one',
    500,
    { retryable: false },
  );
}

function assertRedeemable(row: ArtifactRow): void {
  if (row.state === 'pending' || row.state === 'generating') {
    throw AppError.conflict('EXPORT_NOT_READY', 'This export is still being prepared');
  }
  if (row.state !== 'ready' || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) {
    throw AppError.gone('EXPORT_GONE', 'This export is no longer available');
  }
}

/** Exports belong to registered accounts; guests and staff have none to redeem. */
export function requireUserActor(actor: Actor): string {
  if (actor.type !== 'user') {
    throw AppError.forbidden('USER_ONLY', 'Register an account to use this feature');
  }
  return actor.id;
}
