import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import type { ShareLinkProvider, ShareLinkType } from '../domain/share-link';

export type ShareLinkRow = typeof schema.shareLinks.$inferSelect;

@Injectable()
export class ShareLinksRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async insert(input: {
    slugHash: string;
    type: ShareLinkType;
    targetId: string;
    inviteId?: string;
    createdByUserId: string;
    provider: ShareLinkProvider;
    providerTrackingUrl?: string | null;
    source?: string;
    medium?: string;
    campaign?: string;
    expiresAt: Date | null;
  }): Promise<ShareLinkRow> {
    const [row] = await this.db
      .insert(schema.shareLinks)
      .values({
        slugHash: input.slugHash,
        type: input.type,
        targetId: input.targetId,
        inviteId: input.inviteId ?? null,
        createdByUserId: input.createdByUserId,
        provider: input.provider,
        providerTrackingUrl: input.providerTrackingUrl ?? null,
        source: input.source ?? null,
        medium: input.medium ?? null,
        campaign: input.campaign ?? null,
        expiresAt: input.expiresAt,
      })
      .returning();
    return row!;
  }

  findBySlugHash(slugHash: string): Promise<ShareLinkRow | undefined> {
    return this.db
      .select()
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.slugHash, slugHash))
      .limit(1)
      .then((rows) => rows[0]);
  }

  /** ROOM_INVITE links answer 410 the moment their invite stops being usable. */
  async inviteUsable(inviteId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.roomInvites.id })
      .from(schema.roomInvites)
      .where(
        and(
          eq(schema.roomInvites.id, inviteId),
          isNull(schema.roomInvites.revokedAt),
          sql`${schema.roomInvites.expiresAt} > now()`,
          sql`(${schema.roomInvites.maxUses} is null or ${schema.roomInvites.useCount} < ${schema.roomInvites.maxUses})`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  planRoomId(planId: string): Promise<string | undefined> {
    return this.db
      .select({ roomId: schema.plans.roomId })
      .from(schema.plans)
      .where(eq(schema.plans.id, planId))
      .limit(1)
      .then((rows) => rows[0]?.roomId);
  }

  async placeIsPublished(placeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(and(eq(schema.places.id, placeId), eq(schema.places.status, 'published')))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Revoke the link and, for a ROOM_INVITE, the invite it joins through — in
   * one transaction, so a link that says "gone" cannot leave a code that still
   * lets people in.
   */
  async revoke(link: ShareLinkRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.shareLinks)
        .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(schema.shareLinks.id, link.id), isNull(schema.shareLinks.revokedAt)));
      if (link.inviteId) {
        await tx
          .update(schema.roomInvites)
          .set({ revokedAt: sql`now()` })
          .where(
            and(eq(schema.roomInvites.id, link.inviteId), isNull(schema.roomInvites.revokedAt)),
          );
      }
    });
  }
}
