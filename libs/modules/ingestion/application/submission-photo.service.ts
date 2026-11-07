import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { PUBLIC_STORAGE_PROVIDER, type StoragePort } from '@gogo/providers';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Tx } from '../../shared/outbox';
import { CATALOGUE_STORAGE_CONFIGURED } from '../../uploads/application/tokens';
import { ProviderPhotosService } from '../../search/application/provider-photos.service';

type PreparedPhoto = {
  key: string;
  cleanupId: string;
  metadata: NonNullable<typeof schema.placeMedia.$inferInsert.providerPhoto>;
};

/** ADR-0043: approval and the explicitly authorized #797 backfill share persistence. */
@Injectable()
export class SubmissionPhotoService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly photos: ProviderPhotosService,
    @Inject(PUBLIC_STORAGE_PROVIDER) private readonly storage: StoragePort,
    @Inject(CATALOGUE_STORAGE_CONFIGURED) private readonly configured: boolean,
  ) {}

  async prepare(googlePlaceId: string): Promise<PreparedPhoto | undefined> {
    const answer = await this.photos.firstForProvider(googlePlaceId);
    if (answer.status !== 'ok' && answer.status !== 'disabled')
      throw AppError.serviceUnavailable(
        'SUBMISSION_PHOTO_UNAVAILABLE',
        'Provider photo unavailable; retry approval',
      );
    const photo = answer.photos[0];
    if (!photo) return undefined;
    if (!this.configured)
      throw AppError.serviceUnavailable(
        'SUBMISSION_PHOTO_UNAVAILABLE',
        'Photo storage unavailable; retry approval',
      );
    const extensions: Record<string, string | undefined> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const extension = extensions[photo.contentType];
    if (!extension)
      throw AppError.serviceUnavailable(
        'SUBMISSION_PHOTO_UNAVAILABLE',
        'Provider photo unavailable; retry approval',
      );
    const key = `places/provider/${randomUUID()}.${extension}`;
    // Durable compensation BEFORE storage: a crash, partial upload or rollback
    // leaves a worker-visible cleanup intent. Commit removes it atomically with
    // the media row. Delay exceeds both bounded provider/storage stages.
    const [cleanup] = await this.db
      .insert(schema.mediaCleanupQueue)
      .values({
        bucket: 'public',
        objectKey: key,
        reason: 'submission_provider_photo_uncommitted',
        nextAttemptAt: sql`now() + interval '1 hour'`,
      })
      .returning({ id: schema.mediaCleanupQueue.id });
    const prepared: PreparedPhoto = {
      key,
      cleanupId: cleanup!.id,
      metadata: {
        provider: 'google',
        sourceReference: googlePlaceId,
        fetchedAt: new Date().toISOString(),
        authorAttributions: photo.authorAttributions,
        googleMapsUri: photo.googleMapsUri,
      },
    };
    try {
      await this.storage.putObject(
        key,
        Buffer.from(photo.dataBase64, 'base64'),
        photo.contentType,
        {
          cacheControl: 'private, no-store',
          signal: AbortSignal.timeout(10_000),
        },
      );
      return prepared;
    } catch {
      await this.discard(prepared);
      throw AppError.serviceUnavailable(
        'SUBMISSION_PHOTO_UNAVAILABLE',
        'Photo storage unavailable; retry approval',
      );
    }
  }

  async attach(
    tx: Tx,
    placeId: string,
    adminId: string | null,
    photo: PreparedPhoto,
    reason = 'Approved with place submission',
  ): Promise<void> {
    await tx.insert(schema.placeMedia).values({
      placeId,
      storageKey: photo.key,
      sourceType: 'google_derived',
      attribution: 'Google Maps',
      providerPhoto: photo.metadata,
      moderation: 'approved',
      moderationReason: reason,
      moderatedBy: adminId,
      moderatedAt: new Date(),
      isCover: true,
    });
    await tx
      .delete(schema.mediaCleanupQueue)
      .where(eq(schema.mediaCleanupQueue.id, photo.cleanupId));
  }

  async discard(photo: PreparedPhoto): Promise<void> {
    try {
      const live = await this.db
        .select({ id: schema.placeMedia.id })
        .from(schema.placeMedia)
        .where(eq(schema.placeMedia.storageKey, photo.key))
        .limit(1);
      if (live.length) return;
      await this.storage.deleteObject(photo.key, { signal: AbortSignal.timeout(10_000) });
      await this.db
        .delete(schema.mediaCleanupQueue)
        .where(eq(schema.mediaCleanupQueue.id, photo.cleanupId));
    } catch {
      // The already committed cleanup intent is retried by the existing worker.
    }
  }
}
