import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema, type Db } from '@gogo/database';
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
  ): Promise<PreparedPhotos> {
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
            (u.attachedToType !== 'place_submission' || u.attachedToId !== existingSubmissionId)) ||
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
        if (upload.status === 'attached') {
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
        const key = `${SUBMISSION_PHOTO_PREFIX}${randomUUID()}.webp`;
        // Durable before PUT: a process crash or uncertain PUT leaves a cleanup job.
        const cleanupIds = await this.cleanup.enqueueNow(
          [{ bucket: 'private', objectKey: key, reason: 'submission_photo_unclaimed' }],
          { delaySeconds: 86400 },
        );
        await this.storage.putObject(key, image.body, 'image/webp', {
          cacheControl: 'private, no-store',
        });
        result.photos.push({ upload, key, width: image.width, height: image.height, cleanupIds });
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
      throw err;
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
    await this.uploads.attach(
      actor,
      fresh.map((p) => p.upload.storageKey),
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
          delaySeconds: Math.max(
            900,
            Math.ceil((p.upload.expiresAt.getTime() - Date.now()) / 1000),
          ),
        },
      );
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
    const [photo] = await this.db
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
      throw err;
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
    for (const photo of photos) {
      const approved = placeId !== null && (approvedPhotoIds ?? []).includes(photo.id);
      if (approved) {
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
      } else await this.retire(tx, photo.storageKey);
      await tx
        .update(schema.placeSubmissionPhotos)
        .set({ status: approved ? 'approved' : 'rejected' })
        .where(eq(schema.placeSubmissionPhotos.id, photo.id));
    }
  }

  private async retire(tx: Tx, key: string) {
    await this.cleanup.enqueue(
      tx,
      [{ bucket: 'private', objectKey: key, reason: 'submission_photo_rejected' }],
      { delaySeconds: SUBMISSION_PHOTO_RETENTION_SECONDS },
    );
  }
}
