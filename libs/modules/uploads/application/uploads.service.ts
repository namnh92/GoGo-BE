import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { STORAGE_PROVIDER, type StoragePort } from '@gogo/providers';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';

/**
 * BE-BFF-016 (#171) — the upload path a client can actually use.
 *
 * Presigned rather than multipart: a phone PUTs a 4 MB photo straight to
 * storage and the API only ever handles the key. Image bytes through the API
 * would be the same bytes, an extra hop, and a memory cost per request.
 */
export const UPLOAD_PURPOSES = ['checkin_photo', 'bill_photo', 'place_photo'] as const;

/**
 * BE-CMS-G5 (#227) — purposes only a staff account may ask for.
 *
 * Kept apart from the consumer set rather than merged into it: a phone must
 * not be able to authorize a banner image, and an editor uploading a banner
 * must not be handed a key the check-in flow would accept. Each controller
 * validates against its own list, so the split is enforced at the door.
 */
export const CMS_UPLOAD_PURPOSES = ['banner_image', 'campaign_image'] as const;

export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number] | (typeof CMS_UPLOAD_PURPOSES)[number];

/**
 * Enforced server-side, not advertised. The content type is part of what gets
 * signed, so storage rejects a mismatch too — a client cannot ask for a JPEG
 * URL and PUT an executable through it.
 */
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** 10 MB — comfortably above a phone photo, far below anything worth hosting. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const UPLOAD_TTL_SECONDS = 900;

@Injectable()
export class UploadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE_PROVIDER) private readonly storage: StoragePort,
    @Inject('MEDIA_UPLOADS_CONFIGURED') private readonly configured: boolean,
  ) {}

  async createUpload(
    actor: Actor,
    input: { purpose: UploadPurpose; contentType: string; contentLength: number },
  ) {
    if (!this.configured) {
      // Honest rather than a fake URL that would 404 on PUT: the client can
      // tell "not available here" from "your file was rejected".
      throw new AppError(
        'UPLOAD_NOT_CONFIGURED',
        'Object storage is not configured in this environment',
        503,
      );
    }

    const extension = ALLOWED_CONTENT_TYPES[input.contentType];
    if (!extension) {
      throw AppError.badRequest('UNSUPPORTED_CONTENT_TYPE', 'That file type cannot be uploaded', [
        {
          field: 'contentType',
          code: 'unsupported',
          message: `allowed: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}`,
        },
      ]);
    }
    if (input.contentLength <= 0 || input.contentLength > MAX_UPLOAD_BYTES) {
      throw AppError.badRequest('FILE_TOO_LARGE', 'File exceeds the upload limit', [
        { field: 'contentLength', code: 'max', message: `max ${MAX_UPLOAD_BYTES} bytes` },
      ]);
    }

    // The actor is in the key, so an object is traceable to its uploader even
    // if the row is later pruned. It is not the authorization: that is the row.
    const key = `u/${actor.type}/${actor.id}/${randomUUID()}.${extension}`;
    const presigned = await this.storage.presignUpload(key, input.contentType);
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);

    const [row] = await this.db
      .insert(schema.mediaUploads)
      .values({
        storageKey: key,
        actorType: actor.type,
        actorId: actor.id,
        purpose: input.purpose,
        contentType: input.contentType,
        contentLength: input.contentLength,
        expiresAt,
      })
      .returning({ id: schema.mediaUploads.id });

    return {
      id: row!.id,
      key,
      uploadUrl: presigned.url,
      expiresAt: expiresAt.toISOString(),
      maxBytes: MAX_UPLOAD_BYTES,
    };
  }

  /**
   * Claims keys for one resource. Called from the write that references them,
   * inside its own flow, so a key cannot be attached by anyone but the actor
   * who created it — a member cannot pick up another member's upload.
   *
   * Unknown, expired, foreign or already-attached keys all fail the same way:
   * the caller does not learn whether a key exists, only that theirs is not
   * usable.
   */
  async attach(
    actor: Actor,
    keys: string[],
    target: { type: string; id: string; purposes: UploadPurpose[] },
  ): Promise<void> {
    if (keys.length === 0) return;

    const rows = await this.db
      .select()
      .from(schema.mediaUploads)
      .where(
        and(
          inArray(schema.mediaUploads.storageKey, keys),
          eq(schema.mediaUploads.actorId, actor.id),
        ),
      );

    const usable = new Set(
      rows
        .filter(
          (row) =>
            (row.status === 'pending' || row.status === 'attached') &&
            target.purposes.includes(row.purpose as UploadPurpose) &&
            // An expired pending key is not usable; one already attached to
            // this same resource is, so re-saving a check-in is idempotent.
            (row.status === 'attached'
              ? row.attachedToType === target.type && row.attachedToId === target.id
              : row.expiresAt.getTime() > Date.now()),
        )
        .map((row) => row.storageKey),
    );

    const rejected = keys.filter((key) => !usable.has(key));
    if (rejected.length > 0) {
      throw AppError.badRequest('INVALID_UPLOAD_KEY', 'Upload key is not usable', [
        { field: 'photoKeys', code: 'invalid', message: `${rejected.length} key(s) rejected` },
      ]);
    }

    await this.db
      .update(schema.mediaUploads)
      .set({
        status: 'attached',
        attachedToType: target.type,
        attachedToId: target.id,
        attachedAt: sql`now()`,
      })
      .where(inArray(schema.mediaUploads.storageKey, [...usable]));
  }
}
