import { Inject, Injectable, Optional } from '@nestjs/common';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import {
  ACQUISITION_LINK_PROVIDER,
  NoAcquisitionLinkProvider,
  type AcquisitionLinkPort,
} from '@gogo/providers';
import type { Actor } from '../../identity/domain/actor';
import { TokenService } from '../../identity/application/token.service';
import { RoomsService } from '../../rooms/application/rooms.service';
import { RoomPolicy } from '../../rooms/presentation/room-policy';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type ShareLinksConfig } from '../../shared/config';
import {
  ISSUED_SHARE_LINK_TYPES,
  canonicalShareUrl,
  newShareSlug,
  shareLinkTarget,
  type ShareLinkProvider,
  type ShareLinkTarget,
  type ShareLinkType,
} from '../domain/share-link';
import { ShareLinksRepository, type ShareLinkRow } from '../infrastructure/share-links.repository';

/** String building today; the bound is for the day an adapter makes a call. */
const ATTRIBUTION_TIMEOUT_MS = 2_000;

export type CreateShareLinkInput = {
  type: ShareLinkType;
  entityId: string;
  source?: string | undefined;
  medium?: string | undefined;
  campaign?: string | undefined;
};

export type ShareLinkCreated = {
  id: string;
  url: string;
  type: ShareLinkType;
  expiresAt: string | null;
};

export type ShareLinkResolution = {
  type: ShareLinkType;
  target: ShareLinkTarget;
  expiresAt: string | null;
  provider: ShareLinkProvider;
  trackingUrl: string | null;
  source: string | null;
  campaign: string | null;
};

/**
 * LNK-BE-002 (#205) — mint, resolve, revoke.
 *
 * Resolve first, authorise after (FR-LINK-002): the public resolve answers with
 * the target's *type and id* and nothing private about it; whatever the client
 * then fetches goes through that entity's own authorisation. Creation is where
 * the sharer's right to point at the entity is checked — a host for an invite,
 * a member for a plan, anyone signed in for a published place.
 */
@Injectable()
export class ShareLinksService {
  constructor(
    private readonly repo: ShareLinksRepository,
    private readonly rooms: RoomsService,
    private readonly policy: RoomPolicy,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: ShareLinksConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional()
    @Inject(ACQUISITION_LINK_PROVIDER)
    private readonly acquisition: AcquisitionLinkPort = new NoAcquisitionLinkProvider(),
  ) {}

  async create(actor: Actor, input: CreateShareLinkInput): Promise<ShareLinkCreated> {
    if (actor.type !== 'user') {
      throw AppError.forbidden('USER_ONLY', 'Sign in to create a share link');
    }
    if (!this.config.SHARE_LINK_BASE_URL) {
      // Not retryable: a missing host does not come back on its own.
      throw AppError.serviceUnavailable(
        'SHARE_LINKS_UNAVAILABLE',
        'Share links are not configured in this environment',
        false,
      );
    }
    if (!ISSUED_SHARE_LINK_TYPES.includes(input.type)) {
      throw AppError.badRequest(
        'SHARE_LINK_TYPE_UNSUPPORTED',
        `${input.type} links are reserved and not issued yet`,
      );
    }

    const slug = newShareSlug();
    let inviteId: string | undefined;
    let expiresAt: Date | null = null;

    switch (input.type) {
      case 'ROOM_INVITE': {
        // The slug is the invite code: host check, room joinable, one invite row
        // whose hash is the slug's hash. Joining goes through the same door as
        // a typed code — POST /rooms/join { inviteCode: slug }.
        const invite = await this.rooms.createInvite(actor, input.entityId, undefined, {
          code: slug,
        });
        inviteId = invite.inviteId;
        expiresAt = new Date(invite.expiresAt);
        break;
      }
      case 'PLAN': {
        const roomId = await this.repo.planRoomId(input.entityId);
        if (!roomId) throw AppError.notFound('PLAN_NOT_FOUND', 'Plan not found');
        await this.policy.requireMember(actor, roomId);
        break;
      }
      case 'PLACE': {
        if (!(await this.repo.placeIsPublished(input.entityId))) {
          throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
        }
        break;
      }
      default:
        throw AppError.badRequest('SHARE_LINK_TYPE_UNSUPPORTED', 'Unsupported link type');
    }

    const url = canonicalShareUrl(this.config.SHARE_LINK_BASE_URL, slug);
    // Review finding 1: the vendor URL embeds the canonical link, which embeds
    // the slug — for a ROOM_INVITE the join credential the row keeps hashed.
    // Only *which vendor* is recorded; the URL is rebuilt on every resolve from
    // the slug the caller presents.
    const provider = await this.attributionProvider(url, input);
    const row = await this.repo.insert({
      slugHash: this.tokens.hashOpaqueToken(slug),
      type: input.type,
      targetId: input.entityId,
      ...(inviteId ? { inviteId } : {}),
      createdByUserId: actor.id,
      provider,
      ...(input.source ? { source: input.source } : {}),
      ...(input.medium ? { medium: input.medium } : {}),
      ...(input.campaign ? { campaign: input.campaign } : {}),
      expiresAt,
    });
    this.metrics.increment('share_link_created_total', { type: input.type });
    return {
      id: row.id,
      url,
      type: input.type,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  }

  /**
   * LNK-BE-003 (#206): attribution never blocks a share link (FR-LINK-006). The
   * vendor receives the canonical URL and bounded campaign words — no token,
   * no id, no personal data — and a vendor error or timeout leaves the link
   * minted with `provider: NONE`. Nothing the vendor returns is stored.
   */
  private async attributionProvider(
    canonicalUrl: string,
    input: Pick<CreateShareLinkInput, 'campaign' | 'source' | 'medium'>,
  ): Promise<ShareLinkProvider> {
    try {
      const trackingUrl = await this.composeTrackingUrl(canonicalUrl, input);
      if (!trackingUrl) {
        this.metrics.increment('share_link_attribution_total', { result: 'none' });
        return 'NONE';
      }
      this.metrics.increment('share_link_attribution_total', { result: 'attached' });
      return 'TENJIN';
    } catch {
      this.metrics.increment('share_link_attribution_total', { result: 'fallback' });
      return 'NONE';
    }
  }

  /**
   * The vendor click URL for one resolve, built from the slug the caller just
   * presented. Bounded so a hung vendor cannot hold the request (string
   * building today; the bound is for the day an adapter makes a call).
   */
  private composeTrackingUrl(
    canonicalUrl: string,
    meta: {
      campaign?: string | null | undefined;
      source?: string | null | undefined;
      medium?: string | null | undefined;
    },
  ): Promise<string | null> {
    return Promise.race([
      this.acquisition.createTrackingUrl({
        canonicalUrl,
        ...(meta.campaign ? { campaign: meta.campaign } : {}),
        ...(meta.source ? { source: meta.source } : {}),
        ...(meta.medium ? { medium: meta.medium } : {}),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('attribution timed out')), ATTRIBUTION_TIMEOUT_MS),
      ),
    ]);
  }

  /**
   * Resolve-time attribution. Only a link minted with a vendor gets one, and
   * only while this environment can still compose it; any failure is the
   * canonical link alone (FR-LINK-006), never an error.
   */
  private async trackingUrlFor(row: ShareLinkRow, slug: string): Promise<string | null> {
    if (row.provider === 'NONE' || !this.config.SHARE_LINK_BASE_URL) return null;
    try {
      return await this.composeTrackingUrl(
        canonicalShareUrl(this.config.SHARE_LINK_BASE_URL, slug),
        row,
      );
    } catch {
      return null;
    }
  }

  /** Public. 404 for a slug nobody minted, 410 for one that no longer opens. */
  async resolve(slug: string): Promise<ShareLinkResolution> {
    const row = await this.repo.findBySlugHash(this.tokens.hashOpaqueToken(slug));
    if (!row) {
      this.metrics.increment('share_link_resolved_total', { type: 'unknown', result: 'not_found' });
      throw AppError.notFound('SHARE_LINK_NOT_FOUND', 'No such link');
    }
    if (!(await this.isOpen(row))) {
      this.metrics.increment('share_link_resolved_total', { type: row.type, result: 'gone' });
      throw AppError.gone('SHARE_LINK_GONE', 'Link expired or revoked');
    }
    this.metrics.increment('share_link_resolved_total', { type: row.type, result: 'ok' });
    // Composed here from the presented slug — never read from the row, which
    // deliberately holds no URL that would embed it (review finding 1).
    const trackingUrl = await this.trackingUrlFor(row, slug);
    return {
      type: row.type,
      target: shareLinkTarget(row.type, row.targetId, slug),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      provider: trackingUrl ? row.provider : 'NONE',
      trackingUrl,
      source: row.source,
      campaign: row.campaign,
    };
  }

  /** Creator, or the host of the room a ROOM_INVITE / PLAN link points into. */
  async revoke(actor: Actor, slug: string): Promise<{ revoked: true }> {
    if (actor.type !== 'user') {
      throw AppError.forbidden('USER_ONLY', 'Sign in to revoke a share link');
    }
    const row = await this.repo.findBySlugHash(this.tokens.hashOpaqueToken(slug));
    if (!row) throw AppError.notFound('SHARE_LINK_NOT_FOUND', 'No such link');
    if (row.createdByUserId !== actor.id) {
      const roomId =
        row.type === 'ROOM_INVITE'
          ? row.targetId
          : row.type === 'PLAN'
            ? await this.repo.planRoomId(row.targetId)
            : undefined;
      if (!roomId)
        throw AppError.forbidden('NOT_LINK_OWNER', 'Only the creator can revoke this link');
      await this.policy.requireHost(actor, roomId);
    }
    if (!row.revokedAt) await this.repo.revoke(row);
    return { revoked: true };
  }

  private async isOpen(row: ShareLinkRow): Promise<boolean> {
    if (row.revokedAt) return false;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;
    if (row.type === 'ROOM_INVITE') {
      return row.inviteId ? this.repo.inviteUsable(row.inviteId) : false;
    }
    return true;
  }
}
