import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { UploadsService } from '../../uploads/application/uploads.service';
import type { Actor } from '../../identity/domain/actor';

/**
 * BE-CMS-M1 (#191) — the place-photo write path the console did not have.
 *
 * `CmsPlaceDetail` has returned `media` since DB-005 — a storage key, its
 * dimensions, a sort order and a moderation state — and nothing could change
 * any of it. `PATCH /cms/places/{id}` does not accept media at all, so a place
 * imported with an unusable photo had no fix inside the console and moderating
 * an image meant going to the database. GoGo-CMS listed media read-only and
 * said so rather than shipping a button that could only fail (GoGo-CMS#21).
 *
 * This is not a second upload pipeline. The bytes still go through the
 * presigner in `UploadsService` via `POST /cms/uploads`, with the same
 * content-type allowlist, the same size ceiling and the same `media_uploads`
 * row. What this adds is the step after: turning a key the actor was
 * authorized for into a photo attached to a place, and letting an editor
 * reorder, caption, moderate and detach it.
 *
 * The authorization that matters is `UploadsService#attach`, and it is
 * deliberately reused rather than re-implemented: it refuses a key belonging to
 * another actor, a key authorized for another purpose, an expired one, and one
 * already attached elsewhere — all with the same message, so a caller learns
 * only that *their* key is unusable, never whether somebody else's exists.
 */
@Injectable()
export class CmsPlaceMediaService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uploads: UploadsService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: MediaConfig,
  ) {}

  /**
   * Where the object is readable, or null when media hosting is not configured
   * in this environment. An honest absence beats a URL that would 404 — and
   * the console can tell the two apart, which is what lets it explain why a
   * thumbnail is missing instead of showing a broken image.
   */
  readUrl(key: string): string | null {
    const base = this.config?.MEDIA_PUBLIC_BASE_URL?.replace(/\/$/, '');
    return base ? `${base}/${key.replace(/^\//, '')}` : null;
  }

  private async place(placeId: string) {
    const [row] = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
    return row;
  }

  private async row(placeId: string, mediaId: string) {
    const [row] = await this.db
      .select()
      .from(schema.placeMedia)
      .where(and(eq(schema.placeMedia.id, mediaId), eq(schema.placeMedia.placeId, placeId)))
      .limit(1);
    // Scoped by place as well as id: a media id from another place is a
    // not-found here, not a 403, because the caller has no business learning
    // that the id exists at all.
    if (!row) throw AppError.notFound('PLACE_MEDIA_NOT_FOUND', 'Media not found on this place');
    return row;
  }

  /**
   * Staff uploads this actor may still attach: their own `place_image` keys
   * that are pending and unexpired, or already on this place.
   *
   * Never consumer purposes. A member's `checkin_photo` is their picture of
   * their evening, and it does not become catalog art because an editor can
   * see the list — which is why the query filters on purpose and actor rather
   * than on "images we happen to have".
   */
  async attachable(actor: Actor, placeId: string) {
    await this.place(placeId);
    const rows = await this.db.execute(sql`
      select mu.id, mu.storage_key, mu.content_type, mu.content_length,
             mu.status, mu.expires_at, mu.created_at,
             (pm.id is not null) as attached_here
      from media_uploads mu
      left join place_media pm
        on pm.storage_key = mu.storage_key and pm.place_id = ${placeId}::uuid
      where mu.purpose = 'place_image'
        and mu.actor_id = ${actor.id}::uuid
        and (
          (mu.status = 'pending' and mu.expires_at > now())
          or pm.id is not null
        )
      order by mu.created_at desc
      limit 100
    `);

    type Row = {
      id: string;
      storage_key: string;
      content_type: string;
      content_length: number;
      status: string;
      expires_at: Date | string;
      created_at: Date | string;
      attached_here: boolean;
    };

    return {
      items: (rows.rows as Row[]).map((r) => ({
        id: r.id,
        storageKey: r.storage_key,
        contentType: r.content_type,
        contentLength: r.content_length,
        status: r.status,
        attachedHere: r.attached_here,
        url: this.readUrl(r.storage_key),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  /**
   * Attach an authorized key to a place.
   *
   * `uploads.attach` runs first and does the deciding. Only once it has agreed
   * the key is this actor's, for this purpose, and unclaimed does a
   * `place_media` row exist — so a rejected attach leaves nothing behind to
   * clean up.
   */
  async attach(
    actor: Actor,
    placeId: string,
    input: {
      storageKey: string;
      caption?: string | null | undefined;
      attribution?: string | null | undefined;
      isCover?: boolean | undefined;
      width?: number | null | undefined;
      height?: number | null | undefined;
    },
  ) {
    await this.place(placeId);

    const [existing] = await this.db
      .select({ id: schema.placeMedia.id })
      .from(schema.placeMedia)
      .where(
        and(
          eq(schema.placeMedia.placeId, placeId),
          eq(schema.placeMedia.storageKey, input.storageKey),
        ),
      )
      .limit(1);
    if (existing) {
      throw AppError.conflict('PLACE_MEDIA_EXISTS', 'That image is already on this place');
    }

    await this.uploads.attach(actor, [input.storageKey], {
      type: 'place',
      id: placeId,
      purposes: ['place_image'],
    });

    const [upload] = await this.db
      .select({ id: schema.mediaUploads.id })
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, input.storageKey))
      .limit(1);

    const [{ next }] = (await this.db
      .execute(
        sql`
      select coalesce(max(sort_order), -1) + 1 as next
      from place_media where place_id = ${placeId}::uuid
    `,
      )
      .then((r) => r.rows)) as [{ next: number }];

    const row = await this.db.transaction(async (tx) => {
      if (input.isCover === true) await this.clearCover(tx, placeId, null);
      const [inserted] = await tx
        .insert(schema.placeMedia)
        .values({
          placeId,
          storageKey: input.storageKey,
          sortOrder: Number(next),
          // Pending, always. An editor uploading a photo is not the same
          // person as the one who decides it may be published, and the route
          // that decides is `update` below (FR-CMS-002).
          moderation: 'pending',
          caption: input.caption ?? null,
          attribution: input.attribution ?? null,
          isCover: input.isCover ?? false,
          sourceType: 'editorial',
          width: input.width ?? null,
          height: input.height ?? null,
          mediaUploadId: upload?.id ?? null,
        })
        .returning();
      return inserted!;
    });

    await this.audit(actor.id, 'place.media_attached', placeId, {
      mediaId: row.id,
      storageKey: row.storageKey,
      isCover: row.isCover,
    });
    return this.present(row);
  }

  /** One cover per place; the partial unique index would otherwise refuse. */
  private async clearCover(tx: Pick<Db, 'update'>, placeId: string, exceptId: string | null) {
    await tx
      .update(schema.placeMedia)
      .set({ isCover: false })
      .where(
        exceptId === null
          ? eq(schema.placeMedia.placeId, placeId)
          : and(eq(schema.placeMedia.placeId, placeId), ne(schema.placeMedia.id, exceptId)),
      );
  }

  /**
   * Reorder, caption, choose the cover, and decide moderation.
   *
   * A moderation decision carries a reason and the person who made it. A
   * rejection with no recorded reason is not auditable, and the editor who
   * looks at the photo next has no idea whether it was rejected for being
   * blurry or for being somebody's face.
   */
  async update(
    actor: Actor,
    placeId: string,
    mediaId: string,
    patch: {
      sortOrder?: number | undefined;
      moderation?: 'pending' | 'approved' | 'rejected' | undefined;
      moderationReason?: string | undefined;
      caption?: string | null | undefined;
      attribution?: string | null | undefined;
      isCover?: boolean | undefined;
    },
  ) {
    const before = await this.row(placeId, mediaId);

    if (patch.moderation !== undefined && patch.moderation !== before.moderation) {
      if (!patch.moderationReason || patch.moderationReason.trim().length < 3) {
        throw AppError.badRequest('VALIDATION_FAILED', 'Request validation failed', [
          {
            field: 'moderationReason',
            code: 'required',
            message: 'Quyết định kiểm duyệt phải có lý do',
          },
        ]);
      }
    }

    // A rejected photo must not also be the cover: consumers filter on
    // `approved`, so a rejected cover would leave the place with no lead image
    // and nothing on screen saying why.
    const rejecting = patch.moderation === 'rejected';
    const isCover = rejecting ? false : patch.isCover;

    const after = await this.db.transaction(async (tx) => {
      if (isCover === true) await this.clearCover(tx, placeId, mediaId);
      const [row] = await tx
        .update(schema.placeMedia)
        .set({
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
          ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
          ...(patch.attribution !== undefined ? { attribution: patch.attribution } : {}),
          ...(isCover !== undefined ? { isCover } : {}),
          ...(patch.moderation !== undefined
            ? {
                moderation: patch.moderation,
                moderationReason: patch.moderationReason ?? null,
                moderatedBy: actor.id,
                moderatedAt: sql`now()`,
              }
            : {}),
        })
        .where(eq(schema.placeMedia.id, mediaId))
        .returning();
      return row!;
    });

    await this.audit(actor.id, 'place.media_updated', placeId, {
      mediaId,
      before: {
        sortOrder: before.sortOrder,
        moderation: before.moderation,
        isCover: before.isCover,
        caption: before.caption,
      },
      after: {
        sortOrder: after.sortOrder,
        moderation: after.moderation,
        isCover: after.isCover,
        caption: after.caption,
      },
      ...(patch.moderationReason ? { reason: patch.moderationReason } : {}),
    });
    return this.present(after);
  }

  /**
   * Detach a photo from a place.
   *
   * Detach is not delete. The `place_media` row goes; the object in storage and
   * its `media_uploads` row stay, because the same key may be referenced by
   * another place after a merge — and because an editor removing a photo from
   * one place has not asked to destroy a file. Only when nothing else
   * references the key is the upload released back to `pending`, so the
   * existing sweeper can reclaim it on its own schedule.
   */
  async detach(actor: Actor, placeId: string, mediaId: string) {
    const row = await this.row(placeId, mediaId);

    await this.db.transaction(async (tx) => {
      await tx.delete(schema.placeMedia).where(eq(schema.placeMedia.id, mediaId));

      const [{ refs }] = (await tx
        .execute(
          sql`select count(*)::int as refs from place_media where storage_key = ${row.storageKey}`,
        )
        .then((r) => r.rows)) as [{ refs: number }];
      if (Number(refs) === 0) {
        await tx
          .update(schema.mediaUploads)
          .set({ status: 'pending', attachedToType: null, attachedToId: null, attachedAt: null })
          .where(eq(schema.mediaUploads.storageKey, row.storageKey));
      }
    });

    await this.audit(actor.id, 'place.media_detached', placeId, {
      mediaId,
      storageKey: row.storageKey,
      wasCover: row.isCover,
    });
    return { detached: true };
  }

  private present(row: typeof schema.placeMedia.$inferSelect) {
    return {
      id: row.id,
      storageKey: row.storageKey,
      url: this.readUrl(row.storageKey),
      width: row.width,
      height: row.height,
      sortOrder: row.sortOrder,
      moderation: row.moderation,
      moderationReason: row.moderationReason,
      caption: row.caption,
      attribution: row.attribution,
      isCover: row.isCover,
      sourceType: row.sourceType,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private audit(adminId: string, action: string, resourceId: string, diff?: unknown) {
    return writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'place',
      resourceId,
      diff,
    });
  }
}
