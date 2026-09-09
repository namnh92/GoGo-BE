import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema, type Db } from '@gogo/database';
import {
  ProviderUnavailableError,
  PUBLIC_STORAGE_PROVIDER,
  STORAGE_PROVIDER,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type StoragePort,
} from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { MAX_UPLOAD_BYTES, UploadsService } from '../../uploads/application/uploads.service';
import { MediaCleanupService, type CleanupEntry } from './media-cleanup.service';
import { ProfileService, type UserProfile } from './profile.service';

/** ADR-0022 §Processing limits. */
export const AVATAR_OUTPUT_SIZE = 512;
export const AVATAR_MAX_INPUT_PIXELS = 16_000_000;
export const AVATAR_PROCESS_TIMEOUT_S = 3;
export const AVATAR_MAX_CONCURRENT = 2;
export const AVATAR_WEBP_QUALITY = 80;
/** A day, not a year: a removed avatar must stop answering from the edge soon. */
export const AVATAR_CACHE_CONTROL = 'public, max-age=86400';
export const AVATAR_PUBLIC_PREFIX = 'avatars';
/**
 * A failed request schedules its original away with this much grace, so a
 * retry with the same upload key still finds the bytes, and an abandoned
 * original still goes before the bucket lifecycle would have taken it.
 */
export const AVATAR_FAILED_CLEANUP_DELAY_S = 15 * 60;

/** What `sharp` must report for each type the presign accepted. */
const FORMAT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function requireUser(actor: Actor): string {
  if (actor.type !== 'user') {
    throw AppError.forbidden('USER_ONLY', 'Register an account to use this feature');
  }
  return actor.id;
}

/**
 * PROF-BE-004 (#534) — the avatar pipeline, synchronous in the request.
 *
 * Ownership first, then bytes, then a public object, then one transaction
 * that swaps the key and schedules every object that just became
 * unreferenced. Nothing is deleted inside the transaction; the queue rows
 * are attempted right after it commits and retried by the worker after that.
 */
@Injectable()
export class AvatarService {
  private inFlight = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uploads: UploadsService,
    private readonly profile: ProfileService,
    private readonly cleanup: MediaCleanupService,
    @Inject(STORAGE_PROVIDER) private readonly privateStorage: StoragePort,
    @Inject(PUBLIC_STORAGE_PROVIDER) private readonly publicStorage: StoragePort,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async setAvatar(actor: Actor, uploadKey: string): Promise<UserProfile> {
    const userId = requireUser(actor);

    // Ownership. The same rule check-in uses: the key must be this actor's,
    // for this purpose, pending and unexpired — or already attached to this
    // same user, so a retry is not a second attachment. Every miss is the
    // same answer.
    await this.uploads.attach(actor, [uploadKey], {
      type: 'user',
      id: userId,
      purposes: ['avatar'],
    });
    const [upload] = await this.db
      .select({ contentType: schema.mediaUploads.contentType })
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, uploadKey))
      .limit(1);
    if (!upload) throw AppError.badRequest('INVALID_UPLOAD_KEY', 'Upload key is not usable');

    let originalRead = false;
    let publicKey: string | null = null;
    const started = Date.now();
    try {
      if (this.inFlight >= AVATAR_MAX_CONCURRENT) {
        throw AppError.serviceUnavailable(
          'AVATAR_BUSY',
          'Too many avatars are being processed right now, try again shortly',
        );
      }
      this.inFlight += 1;
      let webp: Uint8Array;
      try {
        const original = await this.readOriginal(uploadKey);
        originalRead = true;
        webp = await this.process(original.body, upload.contentType);
      } finally {
        this.inFlight -= 1;
      }

      const candidateKey = `${AVATAR_PUBLIC_PREFIX}/${randomBytes(16).toString('hex')}.webp`;
      try {
        await this.publicStorage.putObject(candidateKey, webp, 'image/webp', {
          cacheControl: AVATAR_CACHE_CONTROL,
        });
      } catch (err) {
        throw new AppError(
          'AVATAR_STORAGE_UNAVAILABLE',
          'Object storage is not answering, try again shortly',
          503,
          { retryable: true, cause: err },
        );
      }
      // Only now is there a public object to clean up if what follows fails.
      publicKey = candidateKey;

      const enqueued = await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ avatarKey: schema.users.avatarKey })
          .from(schema.users)
          .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active')))
          .for('update')
          .limit(1);
        if (!current)
          throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
        await tx
          .update(schema.users)
          .set({ avatarKey: publicKey, updatedAt: sql`now()` })
          .where(eq(schema.users.id, userId));
        const entries: CleanupEntry[] = [
          { bucket: 'private', objectKey: uploadKey, reason: 'avatar_original' },
        ];
        if (current.avatarKey) {
          entries.push({
            bucket: 'public',
            objectKey: current.avatarKey,
            reason: 'avatar_replaced',
          });
        }
        const ids = await this.cleanup.enqueue(tx, entries);
        await writeAudit(tx, {
          actorType: 'user',
          actorId: userId,
          action: 'user.avatar_set',
          resourceType: 'user',
          resourceId: userId,
          diff: { replaced: Boolean(current.avatarKey) },
        });
        return ids;
      });

      this.metrics.increment('avatar_set_total', { outcome: 'ok' });
      this.metrics.observe('avatar_set_duration_seconds', (Date.now() - started) / 1000);
      await this.cleanup.attemptNow(enqueued);
      return this.profile.getProfile(actor);
    } catch (err) {
      // Ownership was proven, so whatever this request left behind is ours to
      // remove: the original once it was actually read, and a public object
      // if one was written before the transaction failed. In their own
      // transaction, because the one that would have owned them never
      // committed. With a grace period, so a retry with the same key works.
      const entries: CleanupEntry[] = [];
      if (originalRead) {
        entries.push({ bucket: 'private', objectKey: uploadKey, reason: 'avatar_failed_original' });
      }
      if (publicKey) {
        entries.push({ bucket: 'public', objectKey: publicKey, reason: 'avatar_failed_public' });
      }
      await this.cleanup
        .enqueueNow(entries, { delaySeconds: AVATAR_FAILED_CLEANUP_DELAY_S })
        .catch(() => undefined);
      this.metrics.increment('avatar_set_total', {
        outcome: err instanceof AppError ? err.code.toLowerCase() : 'error',
      });
      throw err;
    }
  }

  /** Idempotent: an account with no avatar answers the same profile it had. */
  async removeAvatar(actor: Actor): Promise<UserProfile> {
    const userId = requireUser(actor);
    const enqueued = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ avatarKey: schema.users.avatarKey })
        .from(schema.users)
        .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active')))
        .for('update')
        .limit(1);
      if (!current) throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
      if (!current.avatarKey) return [];
      await tx
        .update(schema.users)
        .set({ avatarKey: null, updatedAt: sql`now()` })
        .where(eq(schema.users.id, userId));
      const ids = await this.cleanup.enqueue(tx, [
        { bucket: 'public', objectKey: current.avatarKey, reason: 'avatar_removed' },
      ]);
      await writeAudit(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'user.avatar_removed',
        resourceType: 'user',
        resourceId: userId,
      });
      return ids;
    });
    this.metrics.increment('avatar_removed_total');
    await this.cleanup.attemptNow(enqueued);
    return this.profile.getProfile(actor);
  }

  private async readOriginal(key: string): Promise<{ body: Uint8Array }> {
    try {
      return await this.privateStorage.getObject(key, { maxBytes: MAX_UPLOAD_BYTES });
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw AppError.badRequest('AVATAR_UPLOAD_MISSING', 'No file was uploaded for that key');
      }
      if (err instanceof StorageObjectTooLargeError) {
        throw AppError.badRequest('FILE_TOO_LARGE', 'File exceeds the upload limit');
      }
      if (err instanceof ProviderUnavailableError) {
        throw AppError.serviceUnavailable(
          'AVATAR_STORAGE_UNAVAILABLE',
          'Object storage is not answering, try again shortly',
        );
      }
      throw err;
    }
  }

  /**
   * Decode under a pixel cap and a clock, apply the EXIF orientation, centre
   * crop to a square WebP. `withMetadata` is deliberately not called: the
   * output carries no EXIF, no GPS, no ICC. The declared type must match what
   * the bytes decode as, so a declared JPEG that is a PNG is refused rather
   * than quietly accepted.
   */
  private async process(body: Uint8Array, declaredType: string): Promise<Uint8Array> {
    const expected = FORMAT_FOR_TYPE[declaredType];
    try {
      const image = sharp(body, {
        limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
        failOn: 'error',
      }).timeout({ seconds: AVATAR_PROCESS_TIMEOUT_S });
      const meta = await image.metadata();
      if (!expected || meta.format !== expected) {
        throw new AppError(
          'AVATAR_UNPROCESSABLE',
          'The file is not the image type it claims to be',
          422,
        );
      }
      const out = await image
        .rotate()
        .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: AVATAR_WEBP_QUALITY })
        .toBuffer();
      return new Uint8Array(out);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Undecodable, over the pixel cap, or over the clock: the same answer,
      // and never the library's own message, which describes our limits.
      throw new AppError('AVATAR_UNPROCESSABLE', 'The image could not be read', 422, {
        cause: err,
      });
    }
  }
}
