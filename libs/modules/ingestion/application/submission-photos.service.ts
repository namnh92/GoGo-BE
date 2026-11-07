import { assertBillPhotoConsent, contributionStorageFailure } from './contribution-enrichment';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema, type Db, type SubmissionEnrichment } from '@gogo/database';
import {
  STORAGE_PROVIDER,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  ProviderUnavailableError,
  type StoragePort,
} from '@gogo/providers';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Tx } from '../../shared/outbox';
import { writeAudit } from '../../shared/audit';
import type { Actor } from '../../identity/domain/actor';
import {
  MAX_UPLOAD_BYTES,
  UploadsService,
  type VerifiedUploads,
} from '../../uploads/application/uploads.service';
import { MediaCleanupService } from '../../profile/application/media-cleanup.service';

import { SUBMISSION_PHOTO_PREFIX } from '../../shared/submission-photo-url';
// Durable bill classification preserves the consent requirement through draft relabelling/dedupe.
// All contribution photos stay in private storage; publication requires an approved user-photo row linked to a visible place.
export const WIZARD_MENU_PHOTO_PREFIX = `${SUBMISSION_PHOTO_PREFIX}menus/`;
export const BILL_PHOTO_PREFIX = `${SUBMISSION_PHOTO_PREFIX}bills/`;
const isBill = (key: string) => key.startsWith(BILL_PHOTO_PREFIX);

function evidencePrefix(
  key: string,
  evidence?: NonNullable<SubmissionEnrichment['photos']>[number],
) {
  if (isBill(key) || evidence?.kind === 'bill') return BILL_PHOTO_PREFIX;
  return key.startsWith(WIZARD_MENU_PHOTO_PREFIX) || evidence?.kind === 'menu'
    ? WIZARD_MENU_PHOTO_PREFIX
    : SUBMISSION_PHOTO_PREFIX;
}
export const SUBMISSION_PHOTO_RETENTION_SECONDS = 7 * 86400;
const FORMATS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

type Upload = typeof schema.mediaUploads.$inferSelect;
type PreparedPhoto = {
  upload: Upload;
  key: string;
  width: number;
  height: number;
  cleanupIds: string[];
  size?: number;
};
export type PreparedPhotos = {
  photos: PreparedPhoto[];
  reusedIds: string[];
  verified: VerifiedUploads;
};

/** Decode/re-encode just as the avatar pipeline does; never preserve metadata. */
export async function sanitiseSubmissionPhoto(body: Uint8Array, contentType: string) {
  try {
    const image = sharp(body, { limitInputPixels: 16_000_000, failOn: 'error' }).timeout({
      seconds: 3,
    });
    const metadata = await image.metadata();
    if (
      !FORMATS[contentType] ||
      metadata.format !== FORMATS[contentType] ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new Error('unsupported image');
    }
    const { data, info } = await image
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { body: new Uint8Array(data), width: info.width, height: info.height };
  } catch {
    throw new AppError(
      'PHOTO_UNPROCESSABLE',
      'The image could not be read as the declared type',
      422,
    );
  }
}

@Injectable()
export class SubmissionPhotosService {
  private inFlight = 0;
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uploads: UploadsService,
    private readonly cleanup: MediaCleanupService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StoragePort,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /** Ownership and storage I/O before the submission transaction; claim rechecked under lock. */
  async prepare(
    actor: Actor,
    mediaIds: string[],
    existingSubmissionId: string | null,
    options: {
      draftId?: string;
      evidence?: SubmissionEnrichment['photos'];
      billPhotoPublicConsent?: boolean | undefined;
    } = {},
  ): Promise<PreparedPhotos> {
    // PostgreSQL UUID columns return lowercase; JSON evidence must use the same identity.
    mediaIds = mediaIds.map((id) => id.toLowerCase());
    const evidence = options.evidence?.map((photo) => ({
      ...photo,
      mediaId: photo.mediaId.toLowerCase(),
    }));
    assertBillPhotoConsent(
      evidence?.some((p) => p.kind === 'bill') ?? false,
      options.billPhotoPublicConsent,
    );
    if (mediaIds.length > 5 || new Set(mediaIds).size !== mediaIds.length) {
      throw AppError.badRequest('INVALID_SUBMISSION_PHOTOS', 'Use at most five distinct media ids');
    }
    const uploads = mediaIds.length
      ? await this.db
          .select()
          .from(schema.mediaUploads)
          .where(inArray(schema.mediaUploads.id, mediaIds))
      : [];
    if (
      uploads.length !== mediaIds.length ||
      uploads.some(
        (u) =>
          u.actorId !== actor.id ||
          u.actorType !== actor.type ||
          u.purpose !== 'place_photo' ||
          !['pending', 'attached'].includes(u.status) ||
          (u.status === 'attached' &&
            !(
              (u.attachedToType === 'place_submission' &&
                u.attachedToId === existingSubmissionId &&
                !options.draftId) ||
              (u.attachedToType === 'contribution_draft' &&
                (!options.draftId || u.attachedToId === options.draftId))
            )) ||
          !FORMATS[u.contentType] ||
          u.contentLength <= 0 ||
          u.contentLength > MAX_UPLOAD_BYTES,
      )
    ) {
      throw AppError.badRequest(
        'INVALID_SUBMISSION_PHOTOS',
        'One or more media ids cannot be attached',
      );
    }
    assertBillPhotoConsent(
      uploads.some((u) => isBill(u.storageKey)),
      options.billPhotoPublicConsent,
    );
    for (const upload of uploads.filter((u) => u.attachedToType === 'contribution_draft'))
      await this.assertDraftClaim(this.db, actor, upload);
    const verified = await this.uploads.verifyUploaded(
      actor,
      uploads.filter((u) => u.status === 'pending').map((u) => u.storageKey),
      {
        type: 'place_submission',
        id: existingSubmissionId,
        purposes: ['place_photo'],
      },
    );
    const result: PreparedPhotos = { photos: [], reusedIds: [], verified };
    if (!uploads.length) return result;
    if (this.inFlight >= 2)
      throw AppError.serviceUnavailable('PHOTO_PROCESSING_BUSY', 'Try again shortly');
    this.inFlight++;
    const started = Date.now();
    try {
      // Sequential: bounded image memory even for five uploads in one request.
      for (const upload of uploads) {
        if (upload.status === 'attached' && upload.attachedToType === 'place_submission') {
          const [previous] = await this.db
            .select()
            .from(schema.placeSubmissionPhotos)
            .where(eq(schema.placeSubmissionPhotos.mediaUploadId, upload.id));
          if (
            !previous ||
            previous.status !== 'pending' ||
            previous.submissionId !== existingSubmissionId
          ) {
            throw AppError.badRequest(
              'INVALID_SUBMISSION_PHOTOS',
              'One or more media ids cannot be attached',
            );
          }
          const bill = isBill(previous.storageKey);
          assertBillPhotoConsent(bill, options.billPhotoPublicConsent);
          // Existing menu bytes cannot silently be reclassified as bill evidence.
          if (!bill && evidence?.some((p) => p.mediaId === upload.id && p.kind === 'bill'))
            throw AppError.badRequest('INVALID_SUBMISSION_PHOTOS', 'Upload a new bill photo');
          result.reusedIds.push(previous.id);
          continue;
        }
        const original = await this.storage.getObject(upload.storageKey, {
          maxBytes: MAX_UPLOAD_BYTES,
        });
        if (original.body.byteLength !== upload.contentLength) {
          throw AppError.badRequest(
            'INVALID_SUBMISSION_PHOTOS',
            'The uploaded size differs from the declared size',
          );
        }
        const image = await sanitiseSubmissionPhoto(original.body, upload.contentType);
        const prefix = evidencePrefix(
          upload.storageKey,
          evidence?.find((p) => p.mediaId === upload.id),
        );
        const key = `${prefix}${randomUUID()}.webp`;
        // Durable before PUT: a process crash or uncertain PUT leaves a cleanup job.
        const cleanupIds = await this.cleanup.enqueueNow(
          [{ bucket: 'private', objectKey: key, reason: 'submission_photo_unclaimed' }],
          { delaySeconds: 86400 },
        );
        await this.storage.putObject(key, image.body, 'image/webp', {
          cacheControl: 'private, no-store',
        });
        result.photos.push({
          upload,
          key,
          width: image.width,
          height: image.height,
          cleanupIds,
          size: image.body.byteLength,
        });
      }
      this.metrics.increment(
        'submission_photo_processing_total',
        { outcome: 'processed' },
        result.photos.length,
      );
      return result;
    } catch (err) {
      this.metrics.increment('submission_photo_processing_total', { outcome: 'failed' });
      if (err instanceof StorageObjectNotFoundError)
        throw AppError.conflict('UPLOAD_NOT_RECEIVED', 'Upload the photo before submitting');
      if (err instanceof StorageObjectTooLargeError)
        throw AppError.badRequest('FILE_TOO_LARGE', 'Photo exceeds the upload limit');
      if (err instanceof ProviderUnavailableError)
        throw AppError.serviceUnavailable(
          'UPLOAD_STORAGE_UNAVAILABLE',
          'Object storage is unavailable',
        );
      contributionStorageFailure(err);
    } finally {
      this.inFlight--;
      this.metrics.observe('submission_photo_processing_duration_ms', Date.now() - started);
    }
  }

  async attach(tx: Tx, actor: Actor, submissionId: string, prepared: PreparedPhotos) {
    const existing = await tx
      .select()
      .from(schema.placeSubmissionPhotos)
      .where(eq(schema.placeSubmissionPhotos.submissionId, submissionId));
    if (
      prepared.reusedIds.some((id) => !existing.some((p) => p.id === id && p.status === 'pending'))
    ) {
      throw AppError.conflict('SUBMISSION_CHANGED', 'Photos changed; reload the submission');
    }
    // A concurrent retry may already have claimed the same upload here.
    // Keep its committed derivative; the unused prepared one retains its cleanup job.
    const fresh = prepared.photos.filter((p) => {
      const prior = existing.find((e) => e.mediaUploadId === p.upload.id);
      if (prior && prior.status !== 'pending') {
        throw AppError.conflict('SUBMISSION_CHANGED', 'Photos changed; reload the submission');
      }
      return !prior;
    });
    if (existing.filter((p) => p.status !== 'rejected').length + fresh.length > 5) {
      throw AppError.conflict('SUBMISSION_PHOTO_LIMIT', 'The submission already has five photos');
    }
    if (!fresh.length) return;
    // Serialise claims of the same upload across different submissions.
    await tx
      .select({ id: schema.mediaUploads.id })
      .from(schema.mediaUploads)
      .where(
        inArray(
          schema.mediaUploads.id,
          fresh.map((p) => p.upload.id),
        ),
      )
      .orderBy(schema.mediaUploads.id)
      .for('update');
    // Recheck retained ownership/expiry under the account and upload locks.
    for (const p of fresh.filter((p) => p.upload.attachedToType === 'contribution_draft')) {
      await this.assertDraftClaim(tx, actor, p.upload);
      const claimed = await tx
        .update(schema.mediaUploads)
        .set({
          attachedToType: 'place_submission',
          attachedToId: submissionId,
          attachedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.mediaUploads.id, p.upload.id),
            eq(schema.mediaUploads.storageKey, p.upload.storageKey),
            eq(schema.mediaUploads.attachedToType, 'contribution_draft'),
            eq(schema.mediaUploads.attachedToId, p.upload.attachedToId!),
          ),
        )
        .returning({ id: schema.mediaUploads.id });
      if (!claimed.length) throw AppError.conflict('SUBMISSION_CHANGED', 'Draft photos changed');
    }
    await this.uploads.attach(
      actor,
      fresh.filter((p) => p.upload.status === 'pending').map((p) => p.upload.storageKey),
      {
        type: 'place_submission',
        id: submissionId,
        purposes: ['place_photo'],
      },
      tx,
      prepared.verified,
    );
    for (const p of fresh) {
      await tx.insert(schema.placeSubmissionPhotos).values({
        submissionId,
        mediaUploadId: p.upload.id,
        storageKey: p.key,
        uploadedByUserId: actor.type === 'user' ? actor.id : null,
        width: p.width,
        height: p.height,
      });
      await tx
        .delete(schema.mediaCleanupQueue)
        .where(inArray(schema.mediaCleanupQueue.id, p.cleanupIds));
      // Transfer removes the retained cleanup deadline; the old derivative is now unused.
      if (p.upload.attachedToType === 'contribution_draft')
        await tx
          .delete(schema.mediaCleanupQueue)
          .where(eq(schema.mediaCleanupQueue.objectKey, p.upload.storageKey));
      // PUT URL may still be live: delete originals after it expires, never serve them.
      await this.cleanup.enqueue(
        tx,
        [
          {
            bucket: 'private',
            objectKey: p.upload.storageKey,
            reason: 'submission_photo_original',
          },
        ],
        {
          delaySeconds:
            p.upload.attachedToType === 'contribution_draft'
              ? 0
              : Math.max(900, Math.ceil((p.upload.expiresAt.getTime() - Date.now()) / 1000)),
        },
      );
    }
  }

  private async assertDraftClaim(db: Pick<Db, 'select'>, actor: Actor, upload: Upload) {
    const [draft] = await db
      .select()
      .from(schema.placeContributionDrafts)
      .where(
        and(
          eq(schema.placeContributionDrafts.id, upload.attachedToId!),
          eq(schema.placeContributionDrafts.userId, actor.id),
        ),
      );
    if (
      !draft ||
      draft.expiresAt <= new Date() ||
      upload.expiresAt <= new Date() ||
      !draft.enrichment.photos?.some((p) => p.mediaId.toLowerCase() === upload.id)
    )
      throw AppError.badRequest('INVALID_SUBMISSION_PHOTOS', 'Draft photo is unavailable');
  }

  /** Claim immutable derivatives outside tmp/ for the full draft lifetime. */
  async retainDraft(
    tx: Tx,
    actor: Actor,
    draftId: string,
    prepared: PreparedPhotos,
    expiresAt: Date,
  ) {
    const ids = prepared.photos.map((p) => p.upload.id);
    if (ids.length) {
      const locked = await tx
        .select()
        .from(schema.mediaUploads)
        .where(inArray(schema.mediaUploads.id, ids))
        .orderBy(schema.mediaUploads.id)
        .for('update');
      for (const p of prepared.photos) {
        const live = locked.find((u) => u.id === p.upload.id);
        if (
          !live ||
          live.storageKey !== p.upload.storageKey ||
          live.status !== p.upload.status ||
          live.attachedToType !== p.upload.attachedToType ||
          live.attachedToId !== p.upload.attachedToId ||
          live.expiresAt <= new Date()
        )
          throw AppError.conflict('DRAFT_MODIFIED', 'Photo claim changed');
      }
      await this.uploads.attach(
        actor,
        prepared.photos
          .filter((p) => p.upload.status === 'pending')
          .map((p) => p.upload.storageKey),
        { type: 'contribution_draft', id: draftId, purposes: ['place_photo'] },
        tx,
        prepared.verified,
      );
    }
    for (const p of prepared.photos) {
      await tx
        .update(schema.mediaUploads)
        .set({
          storageKey: p.key,
          contentType: 'image/webp',
          contentLength: p.size!,
          status: 'attached',
          attachedToType: 'contribution_draft',
          attachedToId: draftId,
          attachedAt: sql`now()`,
          expiresAt,
        })
        .where(eq(schema.mediaUploads.id, p.upload.id));
      await tx
        .update(schema.mediaCleanupQueue)
        .set({ nextAttemptAt: expiresAt })
        .where(inArray(schema.mediaCleanupQueue.id, p.cleanupIds));
      await tx
        .delete(schema.mediaCleanupQueue)
        .where(eq(schema.mediaCleanupQueue.objectKey, p.upload.storageKey));
      await this.cleanup.enqueue(
        tx,
        [{ bucket: 'private', objectKey: p.upload.storageKey, reason: 'draft_photo_replaced' }],
        { delaySeconds: p.upload.attachedToType === 'contribution_draft' ? 0 : 900 },
      );
    }
    // Removing references releases their bytes too; shared claims are never permitted.
    await this.releaseDraft(tx, draftId, ids);
  }

  async releaseDraft(tx: Tx, draftId: string, keep: string[] = []) {
    const rows = await tx
      .select()
      .from(schema.mediaUploads)
      .where(
        and(
          eq(schema.mediaUploads.attachedToType, 'contribution_draft'),
          eq(schema.mediaUploads.attachedToId, draftId),
        ),
      )
      .orderBy(schema.mediaUploads.id)
      .for('update');
    for (const row of rows.filter((r) => !keep.includes(r.id))) {
      await tx
        .update(schema.mediaUploads)
        .set({ status: 'expired', expiresAt: sql`now()` })
        .where(eq(schema.mediaUploads.id, row.id));
      await tx
        .update(schema.mediaCleanupQueue)
        .set({ nextAttemptAt: sql`now()` })
        .where(eq(schema.mediaCleanupQueue.objectKey, row.storageKey));
    }
  }

  async list(submissionId: string) {
    const photos = await this.db
      .select()
      .from(schema.placeSubmissionPhotos)
      .where(eq(schema.placeSubmissionPhotos.submissionId, submissionId))
      .orderBy(schema.placeSubmissionPhotos.createdAt, schema.placeSubmissionPhotos.id);
    return photos.map((p) => ({
      id: p.id,
      mediaId: p.mediaUploadId,
      width: p.width,
      height: p.height,
      status: p.status,
      kind: isBill(p.storageKey) ? 'bill' : 'menu',
      url:
        p.status === 'pending'
          ? `/v1/cms/place-submissions/${submissionId}/photos/${p.id}/content`
          : null,
    }));
  }

  async readForReview(submissionId: string, photoId: string) {
    const [photo] = await this.db
      .select({ key: schema.placeSubmissionPhotos.storageKey })
      .from(schema.placeSubmissionPhotos)
      .innerJoin(
        schema.placeSubmissions,
        eq(schema.placeSubmissions.id, schema.placeSubmissionPhotos.submissionId),
      )
      .where(
        and(
          eq(schema.placeSubmissionPhotos.id, photoId),
          eq(schema.placeSubmissionPhotos.submissionId, submissionId),
          eq(schema.placeSubmissionPhotos.status, 'pending'),
          eq(schema.placeSubmissions.status, 'pending'),
        ),
      );
    if (!photo) throw AppError.notFound('SUBMISSION_PHOTO_NOT_FOUND', 'Photo not found');
    return this.read(photo.key);
  }

  async readPublic(placeId: string, mediaId: string) {
    const [userPhoto] = await this.db
      .select({ key: schema.placeSubmissionPhotos.storageKey })
      .from(schema.placeSubmissionPhotos)
      .innerJoin(schema.places, eq(schema.places.id, schema.placeSubmissionPhotos.placeId))
      .where(
        and(
          eq(schema.placeSubmissionPhotos.id, mediaId),
          eq(schema.placeSubmissionPhotos.placeId, placeId),
          eq(schema.placeSubmissionPhotos.status, 'approved'),
          sql`${schema.places.status} in ('published', 'community_submitted')`,
        ),
      );
    // Preserve URLs of previously published #794 gallery rows. New contributions
    // only use the user-photo set; this fallback does not promote them.
    const [galleryPhoto] = await this.db
      .select({ key: schema.placeMedia.storageKey })
      .from(schema.placeMedia)
      .innerJoin(schema.places, eq(schema.places.id, schema.placeMedia.placeId))
      .where(
        and(
          eq(schema.placeMedia.id, mediaId),
          eq(schema.placeMedia.placeId, placeId),
          eq(schema.placeMedia.moderation, 'approved'),
          sql`${schema.places.status} in ('published', 'community_submitted')`,
        ),
      );
    const photo = userPhoto ?? galleryPhoto;
    if (!photo || !photo.key.startsWith(SUBMISSION_PHOTO_PREFIX))
      throw AppError.notFound('PLACE_PHOTO_NOT_FOUND', 'Photo not found');
    return this.read(photo.key);
  }

  private async read(key: string) {
    try {
      const object = await this.storage.getObject(key, { maxBytes: MAX_UPLOAD_BYTES });
      return Buffer.from(object.body);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError)
        throw AppError.notFound('PHOTO_NOT_FOUND', 'Photo not found');
      if (err instanceof ProviderUnavailableError)
        throw AppError.serviceUnavailable(
          'UPLOAD_STORAGE_UNAVAILABLE',
          'Object storage is unavailable',
        );
      contributionStorageFailure(err);
    }
  }

  async remove(adminId: string, submissionId: string, photoId: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const [submission] = await tx
        .select()
        .from(schema.placeSubmissions)
        .where(eq(schema.placeSubmissions.id, submissionId))
        .for('update');
      if (!submission) throw AppError.notFound('SUBMISSION_NOT_FOUND', 'Submission not found');
      if (submission.status !== 'pending')
        throw AppError.conflict('ALREADY_DECIDED', 'Submission already decided');
      const [photo] = await tx
        .update(schema.placeSubmissionPhotos)
        .set({ status: 'rejected' })
        .where(
          and(
            eq(schema.placeSubmissionPhotos.id, photoId),
            eq(schema.placeSubmissionPhotos.submissionId, submissionId),
            eq(schema.placeSubmissionPhotos.status, 'pending'),
          ),
        )
        .returning();
      if (!photo) throw AppError.notFound('SUBMISSION_PHOTO_NOT_FOUND', 'Photo not found');
      await this.retire(tx, photo.storageKey);
      await tx
        .update(schema.placeSubmissions)
        .set({
          updatedAt: sql`clock_timestamp()`,
          submissionRevision: sql`submission_revision + 1`,
        })
        .where(eq(schema.placeSubmissions.id, submissionId));
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'place_submission.photo_rejected',
        resourceType: 'place_submission',
        resourceId: submissionId,
        diff: { photoId, reason },
      });
    });
    return { removed: true };
  }

  /** Called with the submission locked, in the same transaction as its decision. */
  async decide(
    tx: Tx,
    submissionId: string,
    placeId: string | null,
    adminId: string,
    reason: string | undefined,
    approvedPhotoIds?: string[],
  ) {
    const photos = await tx
      .select()
      .from(schema.placeSubmissionPhotos)
      .where(
        and(
          eq(schema.placeSubmissionPhotos.submissionId, submissionId),
          eq(schema.placeSubmissionPhotos.status, 'pending'),
        ),
      );
    if (placeId && photos.length && approvedPhotoIds === undefined) {
      throw AppError.conflict('PHOTO_REVIEW_REQUIRED', 'Explicitly choose which photos to approve');
    }
    if (
      approvedPhotoIds &&
      (new Set(approvedPhotoIds).size !== approvedPhotoIds.length ||
        approvedPhotoIds.some((id) => !photos.some((p) => p.id === id)) ||
        (!placeId && approvedPhotoIds.length))
    ) {
      throw AppError.badRequest(
        'INVALID_SUBMISSION_PHOTOS',
        'Only pending photos on this submission can be approved',
      );
    }
    const [submission] = await tx
      .select({ enrichment: schema.placeSubmissions.enrichment })
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, submissionId));
    const evidenceIds = new Set(
      submission?.enrichment?.photos?.map((p) => p.mediaId.toLowerCase()) ?? [],
    );
    const cleanupIds: string[] = [];
    const originalKeys: string[] = [];
    for (const photo of photos) {
      const approved = placeId !== null && (approvedPhotoIds ?? []).includes(photo.id);
      const bill = photo.storageKey.startsWith(BILL_PHOTO_PREFIX);
      const userPhoto =
        bill ||
        photo.storageKey.startsWith(WIZARD_MENU_PHOTO_PREFIX) ||
        evidenceIds.has(photo.mediaUploadId);
      // Ordinary #794 gallery behavior is unchanged; #804 tracks its migration.
      // Wizard menu/bill evidence is always a user contribution, never a cover.
      if (approved && !userPhoto) {
        await tx.insert(schema.placeMedia).values({
          placeId: placeId!,
          storageKey: photo.storageKey,
          width: photo.width,
          height: photo.height,
          sourceType: 'community',
          moderation: 'approved',
          uploadedByUserId: photo.uploadedByUserId,
          mediaUploadId: photo.mediaUploadId,
          moderatedBy: adminId,
          moderatedAt: new Date(),
          moderationReason: reason,
        });
      } else if (!approved && bill) {
        const [upload] = await tx
          .select()
          .from(schema.mediaUploads)
          .where(eq(schema.mediaUploads.id, photo.mediaUploadId));
        cleanupIds.push(
          ...(await this.cleanup.enqueue(
            tx,
            [
              { bucket: 'private', objectKey: photo.storageKey, reason: 'bill_photo_decided' },
              ...(upload && upload.storageKey !== photo.storageKey
                ? [
                    {
                      bucket: 'private' as const,
                      objectKey: upload.storageKey,
                      reason: 'bill_photo_original_decided',
                    },
                  ]
                : []),
            ],
            { delaySeconds: 0 },
          )),
        );
        if (upload && upload.storageKey !== photo.storageKey) originalKeys.push(upload.storageKey);
        // A still-live PUT URL can recreate the original; retain its delayed cleanup too.
      } else if (!approved) await this.retire(tx, photo.storageKey);
      await tx
        .update(schema.placeSubmissionPhotos)
        .set({
          status: approved ? 'approved' : 'rejected',
          placeId: approved && userPhoto ? placeId : null,
        })
        .where(eq(schema.placeSubmissionPhotos.id, photo.id));
    }
    return { cleanupIds, originalKeys };
  }

  /** After commit only. Durable jobs cover failures; originals retain their expiry cleanup. */
  async cleanupDecidedBills(cleanup: { cleanupIds: string[]; originalKeys: string[] }) {
    await this.cleanup.attemptNow(cleanup.cleanupIds).catch(() => undefined);
    for (const key of cleanup.originalKeys) {
      try {
        await this.storage.deleteObject(key);
      } catch {
        /* Durable expiry job retries; never log provider errors. */
      }
    }
  }

  private async retire(tx: Tx, key: string) {
    await this.cleanup.enqueue(
      tx,
      [{ bucket: 'private', objectKey: key, reason: 'submission_photo_rejected' }],
      { delaySeconds: key.startsWith(BILL_PHOTO_PREFIX) ? 0 : SUBMISSION_PHOTO_RETENTION_SECONDS },
    );
  }
}
