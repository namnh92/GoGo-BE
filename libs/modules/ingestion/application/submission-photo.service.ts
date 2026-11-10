import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { PUBLIC_STORAGE_PROVIDER, type StoragePort } from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG, type ProviderPhotosConfig, type MediaConfig } from '../../shared/config';
import { flagEnvironmentOf, resolveFlag } from '../../shared/feature-flags';
import {
  submissionProviderPhotoSchema,
  type StoredSubmissionPhoto,
} from '../domain/submission-provider-photo';
import { scheduleRetirement } from '../../profile/application/media-cleanup.service';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Tx } from '../../shared/outbox';
import { CATALOGUE_STORAGE_CONFIGURED } from '../../uploads/application/tokens';
import { ProviderPhotosService } from '../../search/application/provider-photos.service';

export type PreparedPhoto = {
  stored: StoredSubmissionPhoto;
  key: string;
  cleanupId: string;
  metadata: NonNullable<typeof schema.placeMedia.$inferInsert.providerPhoto>;
};

/** ADR-0043: approval and the explicitly authorized #797 backfill share persistence. */
@Injectable()
export class SubmissionPhotoService {
  private readonly logger = new Logger(SubmissionPhotoService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly photos: ProviderPhotosService,
    @Inject(PUBLIC_STORAGE_PROVIDER) private readonly storage: StoragePort,
    @Inject(CATALOGUE_STORAGE_CONFIGURED) private readonly configured: boolean,
    @Optional()
    @Inject(APP_CONFIG)
    private readonly config?: ProviderPhotosConfig & Partial<MediaConfig>,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async acquisitionEnabled(): Promise<boolean> {
    if (!this.configured || !this.config) return false;
    if (this.config.FLAG_PLACE_PROVIDER_PHOTO_ACQUIRE === false) return false;
    const flag = await resolveFlag(this.db, 'place_provider_photo_acquire.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
    return flag.isDefault ? true : flag.enabled;
  }

  /** One shared, committed purchase protocol for submit, approve and future backfill. */
  async claim(id: string, lockPending = false): Promise<string | undefined> {
    return this.db.transaction(async (tx) => {
      if (lockPending)
        await tx.execute(
          sql`select id from place_submissions where id = ${id}::uuid and status = 'pending' for update`,
        );
      const claimed = await tx.execute(sql`update place_submissions
        set provider_photo_claim_id = gen_random_uuid(), provider_photo_claimed_at = now(),
            provider_photo_attempts = provider_photo_attempts + 1
        where id = ${id}::uuid and status = 'pending' and provider_photo is null
          and provider_photo_attempts < 2
          and (provider_photo_claimed_at is null or provider_photo_claimed_at < now() - interval '15 minutes')
        returning provider_photo_claim_id as "claimId"`);
      return (claimed.rows[0] as { claimId: string } | undefined)?.claimId;
    });
  }

  /** Compensation never refunds a possibly paid call. */
  async release(id: string, claimId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`update place_submissions set provider_photo_claim_id = null, provider_photo_claimed_at = null
        where id = ${id}::uuid and provider_photo_claim_id = ${claimId}::uuid`);
    });
  }

  async claimApproval(id: string): Promise<string | undefined> {
    if (!(await this.photos.enabled())) return undefined;
    return this.claim(id, true);
  }

  async complete(id: string, claimId: string, photo: PreparedPhoto): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.placeSubmissions)
        .where(eq(schema.placeSubmissions.id, id))
        .for('update')
        .limit(1);
      if (
        !current ||
        current.status !== 'pending' ||
        current.providerPhoto ||
        current.providerPhotoClaimId !== claimId
      )
        return false;
      await tx
        .update(schema.placeSubmissions)
        .set({
          providerPhoto: photo.stored,
          providerPhotoClaimId: null,
          providerPhotoClaimedAt: null,
        })
        .where(eq(schema.placeSubmissions.id, id));
      await tx
        .delete(schema.mediaCleanupQueue)
        .where(eq(schema.mediaCleanupQueue.id, photo.cleanupId));
      return true;
    });
  }

  async acquireSubmission(id: string, googlePlaceId: string): Promise<void> {
    let claimId: string | undefined;
    let photo: PreparedPhoto | undefined;
    let attached = false;
    try {
      if (!(await this.acquisitionEnabled())) return;
      claimId = await this.claim(id);
      if (!claimId) {
        this.count('submit', 'skipped');
        return;
      }
      photo = await this.prepare(googlePlaceId, 'submit');
      if (photo) attached = await this.complete(id, claimId, photo);
      this.count('submit', attached ? 'stored' : 'empty');
    } catch {
      this.count('submit', 'error');
    } finally {
      if (photo && !attached) await this.discard(photo);
      if (claimId) await this.release(id, claimId).catch(() => undefined);
    }
  }

  count(
    stage: 'submit' | 'approve' | 'preview' | 'cms_create' | 'backfill',
    outcome: 'stored' | 'empty' | 'skipped' | 'error',
  ): void {
    this.metrics.increment('provider_photo_acquisition_total', { stage, outcome });
    // Closed stage label only: provider errors may contain names, URLs or credits.
    if (outcome === 'error') this.logger.warn(`Provider photo acquisition failed at ${stage}`);
  }

  async attachStored(
    tx: Tx,
    placeId: string,
    adminId: string | null,
    stored: StoredSubmissionPhoto,
  ): Promise<void> {
    await tx.insert(schema.placeMedia).values({
      placeId,
      storageKey: stored.storageKey,
      sourceType: 'google_derived',
      attribution: stored.attribution,
      providerPhoto: {
        provider: stored.provider,
        sourceReference: stored.sourceReference,
        fetchedAt: stored.fetchedAt,
        authorAttributions: stored.authorAttributions,
        googleMapsUri: stored.googleMapsUri,
      },
      moderation: 'approved',
      moderationReason: 'Stored submission provider cover',
      moderatedBy: adminId,
      moderatedAt: new Date(),
      isCover: true,
    });
  }

  /** Marker and schedule commit with the moderation/detach that retires the reference. */
  async retire(
    tx: Tx,
    id: string,
    stored: StoredSubmissionPhoto,
    rejected: boolean,
    decidedAt = new Date(),
  ): Promise<void> {
    const at = new Date(decidedAt.getTime() + (rejected ? 7 * 86400_000 : 0));
    await tx
      .update(schema.placeSubmissions)
      .set({
        providerPhoto: {
          ...stored,
          retiredAt: new Date().toISOString(),
          deleteAfter: at.toISOString(),
        },
      })
      .where(eq(schema.placeSubmissions.id, id));
    await scheduleRetirement(
      tx,
      {
        bucket: 'public',
        objectKey: stored.storageKey,
        reason: rejected
          ? 'submission_provider_photo_rejected'
          : 'submission_provider_photo_discarded',
      },
      at,
    );
  }

  async prepare(
    googlePlaceId: string,
    stage: 'submit' | 'approve' | 'cms_create' | 'backfill' = 'approve',
  ): Promise<PreparedPhoto | undefined> {
    const answer = await this.photos.firstForProvider(googlePlaceId, stage);
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
    const stored = submissionProviderPhotoSchema.parse({
      provider: 'google',
      storageKey: key,
      contentType: photo.contentType,
      // Provider dimensions describe the original, not the bounded downloaded bytes.
      width: null,
      height: null,
      fetchedAt: new Date().toISOString(),
      sourceReference: googlePlaceId,
      attribution: 'Google Maps',
      authorAttributions: photo.authorAttributions,
      googleMapsUri: photo.googleMapsUri,
    });
    const prepared: PreparedPhoto = {
      stored,
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
          cacheControl: 'public, max-age=31536000, immutable',
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
      const submission = await this.db
        .select({ id: schema.placeSubmissions.id })
        .from(schema.placeSubmissions)
        .where(
          sql`provider_photo->>'storageKey' = ${photo.key} and
          (provider_photo->>'deleteAfter' is null or (provider_photo->>'deleteAfter')::timestamptz > now())`,
        )
        .limit(1);
      if (submission.length) return;
      await this.storage.deleteObject(photo.key, { signal: AbortSignal.timeout(10_000) });
      await this.db
        .delete(schema.mediaCleanupQueue)
        .where(eq(schema.mediaCleanupQueue.id, photo.cleanupId));
    } catch {
      // The already committed cleanup intent is retried by the existing worker.
    }
  }
}
