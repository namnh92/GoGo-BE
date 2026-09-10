import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { PUBLIC_STORAGE_PROVIDER, STORAGE_PROVIDER, type StoragePort } from '@gogo/providers';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { PUBLIC_UPLOAD_PREFIXES } from '../../shared/media-url';
import {
  AVATAR_STORAGE_CONFIGURED,
  CATALOGUE_STORAGE_CONFIGURED,
  MEDIA_UPLOADS_CONFIGURED,
} from './tokens';

/**
 * BE-BFF-016 (#171) — the upload path a client can actually use.
 *
 * Presigned rather than multipart: a phone PUTs a 4 MB photo straight to
 * storage and the API only ever handles the key. Image bytes through the API
 * would be the same bytes, an extra hop, and a memory cost per request.
 */
export const UPLOAD_PURPOSES = ['checkin_photo', 'bill_photo', 'place_photo', 'avatar'] as const;

/**
 * ADR-0022 — an avatar is read back by the API and decoded with `sharp`, whose
 * prebuilt binaries cannot decode HEIC. The client converts HEIC to JPEG
 * before upload; the server refuses it here rather than at processing time,
 * when the bytes would already have crossed the network.
 */
export const AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Where an avatar original lands: the private bucket, under `tmp/`, which the
 * bucket's lifecycle rule empties after a day. The processed object lives in
 * the public bucket under a key of its own; this one is never served.
 */
export const AVATAR_ORIGINAL_PREFIX = 'tmp/avatars';

/**
 * BE-CMS-G5 (#227) — purposes only a staff account may ask for.
 *
 * Kept apart from the consumer set rather than merged into it: a phone must
 * not be able to authorize a banner image, and an editor uploading a banner
 * must not be handed a key the check-in flow would accept. Each controller
 * validates against its own list, so the split is enforced at the door.
 */
export const CMS_UPLOAD_PURPOSES = ['banner_image', 'campaign_image', 'place_image'] as const;

/**
 * BE-CMS-M1 (#191) — `place_image` is a staff purpose, deliberately not the
 * consumer `place_photo`.
 *
 * They are the same kind of picture and a different kind of claim. A
 * `place_photo` key is bound to the phone that took it and arrives through
 * moderation as somebody's contribution; an editor attaching a catalog image is
 * making an editorial decision on GoGo's behalf. Merging them would let the CMS
 * attach a key a member uploaded for their own check-in, which is the one thing
 * #191 says the admin path must not do.
 */

export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number] | (typeof CMS_UPLOAD_PURPOSES)[number];

/**
 * A `Db` or an open transaction on one — the same shape `unit-lookup` uses.
 *
 * `attach` takes one so the claim can be made *inside* the caller's
 * transaction. Run on its own connection it decides correctly but commits
 * separately, and a write that fails after it leaves the upload marked
 * `attached` to a resource that does not reference it — the mirror image of
 * the orphan row the ordering fix removed.
 */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

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
    @Inject(PUBLIC_STORAGE_PROVIDER) private readonly publicStorage: StoragePort,
    @Inject(MEDIA_UPLOADS_CONFIGURED) private readonly configured: boolean,
    @Inject(AVATAR_STORAGE_CONFIGURED) private readonly avatarConfigured: boolean,
    @Inject(CATALOGUE_STORAGE_CONFIGURED) private readonly catalogueConfigured: boolean,
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

    const isAvatar = input.purpose === 'avatar';
    if (isAvatar) {
      // A guest has no account to hang a picture on, and the client is told
      // before the picker opens (`capabilities.avatarUpload`); this is the
      // enforcement behind that promise.
      if (actor.type !== 'user') {
        throw AppError.forbidden('USER_ONLY', 'Register an account to use this feature');
      }
      if (!this.avatarConfigured) {
        throw new AppError(
          'UPLOAD_NOT_CONFIGURED',
          'Avatar storage is not configured in this environment',
          503,
        );
      }
    }

    const allowedTypes: readonly string[] = isAvatar
      ? AVATAR_CONTENT_TYPES
      : Object.keys(ALLOWED_CONTENT_TYPES);
    const extension = allowedTypes.includes(input.contentType)
      ? ALLOWED_CONTENT_TYPES[input.contentType]
      : undefined;
    if (!extension) {
      throw AppError.badRequest('UNSUPPORTED_CONTENT_TYPE', 'That file type cannot be uploaded', [
        {
          field: 'contentType',
          code: 'unsupported',
          message: `allowed: ${allowedTypes.join(', ')}`,
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
    //
    // The prefix decides the bucket, so the object lands where the URL that
    // will be handed out actually reads from (ADR-0005).
    const publicPrefix = PUBLIC_UPLOAD_PREFIXES[input.purpose];
    if (publicPrefix && !this.catalogueConfigured) {
      // Without the public half the presigner falls back to the fake adapter,
      // which answers with a `fake-storage.local` URL. Refusing here is the
      // difference between "this environment cannot host catalogue images" and
      // an upload that appears to be authorized and silently goes nowhere.
      throw new AppError(
        'UPLOAD_NOT_CONFIGURED',
        'Public media storage is not configured in this environment',
        503,
      );
    }
    const key = isAvatar
      ? `${AVATAR_ORIGINAL_PREFIX}/${actor.id}/${randomUUID()}.${extension}`
      : publicPrefix
        ? `${publicPrefix}/${actor.id}/${randomUUID()}.${extension}`
        : `u/${actor.type}/${actor.id}/${randomUUID()}.${extension}`;
    const presigned = await (publicPrefix ? this.publicStorage : this.storage).presignUpload(
      key,
      input.contentType,
    );
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
    executor: Executor = this.db,
  ): Promise<void> {
    if (keys.length === 0) return;

    const db = executor as Db;
    const rows = await db
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

    await db
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
