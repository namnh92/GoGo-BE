import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentActor, Public, RateLimit } from '../../identity/presentation/decorators';
import type { Actor } from '../../identity/domain/actor';
import { AdminAuthService } from '../application/admin-auth.service';
import {
  CmsCatalogService,
  PLACE_SORTS,
  PLACE_SOURCES,
  type PlaceEditInput,
} from '../application/cms-catalog.service';
import { CmsContentService } from '../application/cms-content.service';
import { CmsAuditService } from '../application/cms-audit.service';
import { CmsOpsService } from '../application/cms-ops.service';
import { FLAG_ENVIRONMENTS, FLAG_PLATFORMS } from '../../shared/feature-flags';
import {
  CHECKIN_MODERATION_STATUSES,
  ModerationQueueService,
  REPORT_MODERATION_STATUSES,
  REPORT_TARGET_TYPES,
  REVIEW_MODERATION_STATUSES,
} from '../application/moderation-queue.service';
import { ExperimentsAdminService } from '../application/experiments-admin.service';
import { RankingEvaluationService } from '../application/ranking-evaluation.service';
import { SearchAnalyticsService } from '../application/search-analytics.service';
import { RequireRole, type AdminActor } from './admin.guard';
import { Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG, type IdentityConfig } from '../../shared/config';
import { AppError } from '../../shared/app-error';
import { REFRESH_COOKIE } from '../../identity/presentation/auth.guard';
import { clearAuthCookies, setAuthCookies } from '../../identity/presentation/cookies';
import { clientMeta } from '../../identity/presentation/client-meta';

const Uuid = new ZodValidationPipe(z.string().uuid());

// ---------------------------------------------------------------- auth

const refreshSchema = z.object({ refreshToken: z.string().min(20).optional() }).default({});
const logoutSchema = z.object({ allDevices: z.boolean().default(false) }).default({});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
  totp: z.string().length(6).optional(),
});
const totpSetupSchema = z.object({ password: z.string().min(1).max(128) });
const totpConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const adminListQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['editor', 'moderator', 'ops_admin', 'super_admin']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
const createAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(50),
  role: z.enum(['editor', 'moderator', 'ops_admin', 'super_admin']),
});

@Controller('cms/auth')
export class CmsAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    @Inject(APP_CONFIG) private readonly config: IdentityConfig,
  ) {}

  @Public()
  @RateLimit({ action: 'cms.login', limit: 5, windowSeconds: 60, keyBy: 'ip' })
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login({ ...body, meta: clientMeta(req) });
    // Browser clients authenticate by cookie; the body tokens exist for
    // non-browser callers. A CMS that stores the body token is doing it wrong.
    setAuthCookies(reply, result, this.cookieOpts());
    return result;
  }

  /** SEC-003 — rotating refresh so a shift does not end every 15 minutes. */
  @Public()
  @RateLimit({ action: 'cms.refresh', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  @Post('refresh')
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!token) throw AppError.unauthorized('INVALID_REFRESH_TOKEN', 'Session is not valid');
    const result = await this.auth.refresh(token, clientMeta(req));
    setAuthCookies(reply, result, this.cookieOpts());
    return result;
  }

  @RequireRole('editor', 'moderator', 'ops_admin')
  @Post('logout')
  async logout(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(logoutSchema)) body: z.infer<typeof logoutSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(actor.sessionId, body.allDevices);
    clearAuthCookies(reply, this.config.COOKIE_SECURE, '/v1/cms/auth/refresh');
    return { loggedOut: true };
  }

  private cookieOpts() {
    return {
      secure: this.config.COOKIE_SECURE,
      accessTtlSeconds: this.config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: this.config.AUTH_ADMIN_REFRESH_TTL_SECONDS,
      refreshPath: '/v1/cms/auth/refresh',
    };
  }

  @RequireRole('editor', 'moderator', 'ops_admin')
  @Post('totp/setup')
  setupTotp(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(totpSetupSchema)) body: { password: string },
  ) {
    return this.auth.setupTotp(actor.id, body.password);
  }

  /**
   * #62 — enrollment only takes effect once a code from the new secret
   * verifies. Enrolling and activating in one step locked an admin out of the
   * console whenever the authenticator never received the secret.
   */
  @RateLimit({ action: 'cms.totp_confirm', limit: 5, windowSeconds: 60, keyBy: 'actor' })
  @Post('totp/confirm')
  confirmTotp(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(totpConfirmSchema)) body: { code: string },
  ) {
    return this.auth.confirmTotp(actor.id, body.code);
  }

  @RequireRole('super_admin')
  @Post('admins')
  createAdmin(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createAdminSchema)) body: z.infer<typeof createAdminSchema>,
  ) {
    return this.auth.createAdmin({ ...body, createdBy: actor.id });
  }

  /**
   * BE-CMS-G2 (#220) — the read that was missing next to the create.
   *
   * `super_admin` only, matching the write: who holds which role is the shape
   * of the whole authorization model, and the guard's rank-read does not open
   * it up because no lower rank reaches 3.
   */
  @RequireRole('super_admin')
  @Get('admins')
  listAdmins(@Query(new ZodValidationPipe(adminListQuery)) query: z.infer<typeof adminListQuery>) {
    return this.auth.listAdmins(query);
  }
}

// ---------------------------------------------------------------- catalog

const placeEditSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  addressText: z.string().max(400).optional(),
  areaKey: z.string().max(64).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  avgVisitMinutes: z.number().int().min(10).max(720).optional(),
  suitability: z.record(z.string(), z.number().min(0).max(1)).optional(),
  isLodging: z.boolean().optional(),
  curatedRank: z.number().int().min(0).nullable().optional(),
  taxonomyIds: z.array(z.string().uuid()).max(30).optional(),
});
const placeStatusSchema = z.object({
  status: z.enum(['draft', 'community_submitted', 'review', 'published', 'suspended', 'archived']),
});
const hoursSchema = z.object({
  hours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        openMinute: z.number().int().min(0).max(1439),
        closeMinute: z.number().int().min(0).max(1439),
        isOvernight: z.boolean().default(false),
      }),
    )
    .max(21),
});
const priceSchema = z.object({
  priceMin: z.number().int().min(0),
  priceMax: z.number().int().min(0),
  unit: z.enum(['per_person', 'per_item', 'per_hour', 'per_night']).default('per_person'),
});
const mergeSchema = z.object({ duplicateId: z.string().uuid() });

/** BE-IMP-001 — server-side filter/sort/paginate for the CMS place table. */
const placeListQuery = z.object({
  status: z
    .enum(['draft', 'community_submitted', 'review', 'published', 'suspended', 'archived'])
    .optional(),
  q: z.string().trim().min(1).max(120).optional(),
  areaKey: z.string().trim().max(64).optional(),
  category: z.string().trim().max(64).optional(),
  source: z.enum(PLACE_SOURCES).optional(),
  /** Places whose freshness was last checked before N days ago (or never). */
  staleDays: z.coerce.number().int().min(0).max(3650).optional(),
  sort: z.enum(PLACE_SORTS).default('updated_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

@RequireRole('editor')
@Controller('cms/places')
export class CmsCatalogController {
  constructor(private readonly catalog: CmsCatalogService) {}

  @Get()
  list(@Query(new ZodValidationPipe(placeListQuery)) query: z.infer<typeof placeListQuery>) {
    const { staleDays, ...rest } = query;
    return this.catalog.listPlaces({
      ...rest,
      ...(staleDays !== undefined
        ? { staleBefore: new Date(Date.now() - staleDays * 86_400_000) }
        : {}),
    });
  }

  @Get('stale')
  stale(@Query('days') days?: string, @Query('limit') limit?: string) {
    return this.catalog.staleQueue(Number(days) || 30, Math.min(Number(limit) || 50, 200));
  }

  @Get('duplicates')
  duplicates(@Query('limit') limit?: string) {
    return this.catalog.duplicateCandidates(Math.min(Number(limit) || 50, 200));
  }

  /**
   * Declared after the literal routes above: Nest matches in declaration
   * order, so `:id` first would swallow `/stale` and `/duplicates`.
   */
  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.catalog.getPlace(id);
  }

  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(placeEditSchema)) body: PlaceEditInput,
  ) {
    return this.catalog.updatePlace(actor.id, id, body);
  }

  @Patch(':id/status')
  transition(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(placeStatusSchema)) body: z.infer<typeof placeStatusSchema>,
  ) {
    return this.catalog.transitionPlace(actor.id, id, body.status);
  }

  @Put(':id/hours')
  setHours(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(hoursSchema)) body: z.infer<typeof hoursSchema>,
  ) {
    return this.catalog.setHours(actor.id, id, body.hours);
  }

  @Post(':id/prices')
  addPrice(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(priceSchema)) body: z.infer<typeof priceSchema>,
  ) {
    return this.catalog.addPrice(actor.id, id, body);
  }

  @Post(':id/verify-freshness')
  verifyFreshness(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.catalog.touchFreshness(actor.id, id);
  }

  @Post(':id/merge')
  merge(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(mergeSchema)) body: { duplicateId: string },
  ) {
    return this.catalog.mergePlaces(actor.id, id, body.duplicateId);
  }
}

// ---------------------------------------------------------------- content

const taxonomyCreateSchema = z.object({
  kind: z.enum([
    'mood',
    'category',
    'setting',
    'dietary',
    'accessibility',
    'spending_style',
    'suitability',
  ]),
  key: z.string().regex(/^[a-z0-9_]{2,40}$/),
  labels: z.record(z.string(), z.string().max(80)),
  sortOrder: z.number().int().min(0).optional(),
});
const taxonomyUpdateSchema = z.object({
  labels: z.record(z.string(), z.string().max(80)).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
const synonymSchema = z.object({
  term: z.string().trim().min(1).max(80),
  locale: z.string().max(8).optional(),
});
const collectionCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  locale: z.string().max(8).optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
});
const collectionStatusSchema = z.object({
  status: z.enum(['draft', 'scheduled', 'published', 'archived']),
});
const collectionItemsSchema = z.object({ placeIds: z.array(z.string().uuid()).max(100) });
/** The CMS list defaults to BOTH active and inactive — that is the point. */
const taxonomyListQuery = z.object({
  kind: z
    .enum([
      'mood',
      'category',
      'setting',
      'dietary',
      'accessibility',
      'spending_style',
      'suitability',
      'checkin_tag',
    ])
    .optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

@RequireRole('editor', 'ops_admin')
@Controller('cms')
export class CmsContentController {
  constructor(private readonly content: CmsContentService) {}

  @Post('taxonomies')
  createTaxonomy(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(taxonomyCreateSchema)) body: z.infer<typeof taxonomyCreateSchema>,
  ) {
    return this.content.createTaxonomy(actor.id, body);
  }

  @Patch('taxonomies/:id')
  updateTaxonomy(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(taxonomyUpdateSchema)) body: z.infer<typeof taxonomyUpdateSchema>,
  ) {
    return this.content.updateTaxonomy(actor.id, id, body);
  }

  @Post('taxonomies/:id/synonyms')
  addSynonym(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(synonymSchema)) body: z.infer<typeof synonymSchema>,
  ) {
    return this.content.addSynonym(actor.id, id, body);
  }

  @Get('taxonomies')
  listTaxonomies(
    @Query(new ZodValidationPipe(taxonomyListQuery)) query: z.infer<typeof taxonomyListQuery>,
  ) {
    return this.content.listTaxonomies(query);
  }

  @Get('collections')
  listCollections(@Query('status') status?: string) {
    return this.content.listCollections({ status: status as never });
  }

  @Post('collections')
  createCollection(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(collectionCreateSchema))
    body: z.infer<typeof collectionCreateSchema>,
  ) {
    return this.content.createCollection(actor.id, body);
  }

  @Patch('collections/:id/status')
  setCollectionStatus(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(collectionStatusSchema))
    body: z.infer<typeof collectionStatusSchema>,
  ) {
    return this.content.setCollectionStatus(actor.id, id, body.status);
  }

  @Get('collections/:id/items')
  collectionItems(@Param('id', Uuid) id: string) {
    return this.content.listCollectionItems(id);
  }

  @Put('collections/:id/items')
  setCollectionItems(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(collectionItemsSchema)) body: { placeIds: string[] },
  ) {
    return this.content.setCollectionItems(actor.id, id, body.placeIds);
  }
}

// ---------------------------------------------------------------- moderation

const decisionSchema = z.object({
  decision: z.enum(['published', 'rejected', 'approved', 'actioned', 'dismissed']),
  reason: z.string().trim().min(3).max(500),
});

/**
 * BE-CMS-G1 (#219) — filters shared by every moderation queue.
 *
 * `dateTo` is exclusive so consecutive day filters tile without dropping or
 * double-counting the row on the seam.
 */
const queuePaging = {
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
};
const bool = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const reviewQueueQuery = z.object({
  status: z.enum(REVIEW_MODERATION_STATUSES).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  reported: bool,
  placeId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  ...queuePaging,
});
const reportQueueQuery = z.object({
  status: z.enum(REPORT_MODERATION_STATUSES).optional(),
  targetType: z.enum(REPORT_TARGET_TYPES).optional(),
  targetId: z.string().uuid().optional(),
  reasonCode: z.string().trim().max(64).optional(),
  ...queuePaging,
});
const checkinQueueQuery = z.object({
  status: z.enum(CHECKIN_MODERATION_STATUSES).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  hasBill: bool,
  placeId: z.string().uuid().optional(),
  ...queuePaging,
});
const communityPlaceQueueQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  areaKey: z.string().trim().max(64).optional(),
  ...queuePaging,
});

@RequireRole('moderator')
@Controller('cms/moderation')
export class CmsModerationController {
  constructor(
    private readonly ops: CmsOpsService,
    private readonly queues: ModerationQueueService,
  ) {}

  /**
   * Superseded by the per-queue reads below (#219). Kept because the console
   * ships against it today: four unfiltered arrays sharing one `limit`, with
   * no total, so the badge had to add the array lengths together and was
   * wrong for any backlog longer than a page.
   *
   * @deprecated Use `/cms/moderation/counts` and the per-type queues.
   */
  @Get()
  queue(@Query('limit') limit?: string) {
    return this.ops.moderationQueue(Math.min(Number(limit) || 50, 200));
  }

  /** The sidebar badge: what is waiting, not what this page happens to hold. */
  @Get('counts')
  counts() {
    return this.queues.counts();
  }

  @Get('reviews')
  listReviews(
    @Query(new ZodValidationPipe(reviewQueueQuery)) query: z.infer<typeof reviewQueueQuery>,
  ) {
    return this.queues.reviews(query);
  }

  @Get('reports')
  listReports(
    @Query(new ZodValidationPipe(reportQueueQuery)) query: z.infer<typeof reportQueueQuery>,
  ) {
    return this.queues.reports(query);
  }

  @Get('checkins')
  listCheckins(
    @Query(new ZodValidationPipe(checkinQueueQuery)) query: z.infer<typeof checkinQueueQuery>,
  ) {
    return this.queues.checkins(query);
  }

  @Get('community-places')
  listCommunityPlaces(
    @Query(new ZodValidationPipe(communityPlaceQueueQuery))
    query: z.infer<typeof communityPlaceQueueQuery>,
  ) {
    return this.queues.communityPlaces(query);
  }

  @Post('reviews/:id')
  decideReview(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ) {
    return this.ops.decideReview(
      actor.id,
      id,
      body.decision as 'published' | 'rejected',
      body.reason,
    );
  }

  @Post('checkins/:id')
  decideCheckin(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ) {
    return this.ops.decideCheckin(
      actor.id,
      id,
      body.decision as 'approved' | 'rejected',
      body.reason,
    );
  }

  @Post('reports/:id')
  decideReport(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ) {
    return this.ops.decideReport(
      actor.id,
      id,
      body.decision as 'actioned' | 'dismissed',
      body.reason,
    );
  }
}

// ---------------------------------------------------------------- ops

const rankingCreateSchema = z.object({
  key: z.enum(['suggestion.scoring', 'search.ranking']),
  weights: z.record(z.string(), z.number()),
});
const rankingListQuery = z.object({
  key: z.enum(['suggestion.scoring', 'search.ranking']).optional(),
  status: z.enum(['draft', 'approved', 'active', 'rolled_back']).optional(),
});
const evaluateQuery = z.object({
  sampleSize: z.coerce.number().int().min(1).max(500).default(100),
});
const experimentSchema = z.object({
  description: z.string().max(500).optional(),
  enabled: z.boolean(),
  /**
   * Variant name -> share in [0, 1]. Names are ranking config versions; the
   * remainder goes to control, so a half-configured split exposes fewer
   * subjects rather than more.
   */
  variants: z.record(z.string().max(64), z.number().min(0).max(1)),
});
const searchAnalyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
/**
 * BE-CMS-G3 (#221) — a flag write carries what it applies to and what it is.
 *
 * `payload` is still accepted so the shipped flags console keeps working; it
 * means the same thing as `value`, and sending both disagreeing values is a
 * rejection rather than a silent pick.
 */
const flagSchema = z
  .object({
    enabled: z.boolean(),
    value: z.unknown().optional(),
    /** @deprecated use `value`. */
    payload: z.unknown().optional(),
    environment: z.enum(FLAG_ENVIRONMENTS).optional(),
    platform: z.enum(FLAG_PLATFORMS).optional(),
  })
  .refine(
    (body) => body.value === undefined || body.payload === undefined || body.value === body.payload,
    { message: 'value and payload disagree', path: ['value'] },
  );
const flagListQuery = z.object({
  environment: z.enum(FLAG_ENVIRONMENTS).optional(),
  platform: z.enum(FLAG_PLATFORMS).optional(),
});

/**
 * `resourceId` is text, not uuid: audit rows reference feature flags and
 * ranking configs by key as well as entities by id.
 */
const auditListQuery = z.object({
  resourceType: z.string().max(64).optional(),
  resourceId: z.string().max(128).optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().max(64).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  breakGlass: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/**
 * BE-IMP-010 — the audit log, readable at last.
 *
 * Declared at `editor` so rank-based read lets every admin role open a
 * resource's history; the staff IP inside it is narrowed separately, to
 * ops_admin and above. Read-only by design: FR-CMS-008 makes the log
 * immutable, so there is deliberately no write route on this controller.
 */
@RequireRole('editor')
@Controller('cms')
export class CmsAuditController {
  constructor(private readonly audit: CmsAuditService) {}

  @Get('audit')
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(auditListQuery)) query: z.infer<typeof auditListQuery>,
  ) {
    const role = (actor as AdminActor).role;
    return this.audit.list(query, { includeIp: role === 'ops_admin' || role === 'super_admin' });
  }

  /** The place editor's history drawer; same query, scoped for it. */
  @Get('places/:id/audit')
  forPlace(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Query(new ZodValidationPipe(auditListQuery)) query: z.infer<typeof auditListQuery>,
  ) {
    const role = (actor as AdminActor).role;
    return this.audit.list(
      { ...query, resourceType: 'place', resourceId: id },
      { includeIp: role === 'ops_admin' || role === 'super_admin' },
    );
  }
}

@RequireRole('ops_admin')
@Controller('cms')
export class CmsOpsController {
  constructor(
    private readonly ops: CmsOpsService,
    private readonly searchAnalyticsService: SearchAnalyticsService,
    private readonly evaluation: RankingEvaluationService,
    private readonly experimentsAdmin: ExperimentsAdminService,
  ) {}

  @Post('ranking-configs')
  createRanking(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(rankingCreateSchema)) body: z.infer<typeof rankingCreateSchema>,
  ) {
    return this.ops.createRankingConfig(actor.id, body);
  }

  @Get('ranking-configs')
  listRanking(
    @Query(new ZodValidationPipe(rankingListQuery)) query: z.infer<typeof rankingListQuery>,
  ) {
    return this.ops.listRankingConfigs(query);
  }

  /**
   * SG-010 — replay a candidate config against real stored snapshots before
   * anyone is exposed to it. Writes nothing: no plan, no run, no user.
   */
  @Get('ranking-configs/:id/evaluate')
  evaluateRanking(
    @Param('id', Uuid) id: string,
    @Query(new ZodValidationPipe(evaluateQuery)) query: z.infer<typeof evaluateQuery>,
  ) {
    return this.evaluation.evaluate(id, query.sampleSize);
  }

  @Get('experiments')
  listExperiments() {
    return this.experimentsAdmin.list();
  }

  @Put('experiments/:key')
  upsertExperiment(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(experimentSchema)) body: z.infer<typeof experimentSchema>,
  ) {
    return this.experimentsAdmin.upsert(actor.id, key, body);
  }

  @Post('ranking-configs/:id/approve')
  approveRanking(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.ops.approveRankingConfig(actor.id, id);
  }

  @Post('ranking-configs/:id/activate')
  activateRanking(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.ops.activateRankingConfig(actor.id, id);
  }

  @Post('ranking-configs/:key/rollback')
  rollbackRanking(@CurrentActor() actor: Actor, @Param('key') key: string) {
    return this.ops.rollbackRankingConfig(actor.id, key);
  }

  @Get('feature-flags')
  listFlags(@Query(new ZodValidationPipe(flagListQuery)) query: z.infer<typeof flagListQuery>) {
    return this.ops.listFeatureFlags(query);
  }

  /**
   * Every configurable key with its type and default. Without it the console
   * cannot tell "not configured" from "does not exist", and a number or a
   * version cannot be edited safely without seeing what it falls back to.
   *
   * Declared before `feature-flags/:key` — Nest matches in declaration order.
   */
  @Get('feature-flags/catalog')
  flagCatalog() {
    return this.ops.flagCatalog();
  }

  @Put('feature-flags/:key')
  setFlag(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(flagSchema)) body: z.infer<typeof flagSchema>,
  ) {
    const { enabled, environment, platform } = body;
    return this.ops.setFeatureFlag(actor.id, key, {
      enabled,
      value: body.value ?? body.payload,
      environment,
      platform,
    });
  }

  @Get('ops/kpis')
  kpis() {
    return this.ops.kpis();
  }

  /**
   * SE-006 — search quality. Answers "is search getting worse" and "which
   * queries fail" from a daily aggregate; there is no per-request search log
   * to drill into, and that absence is the privacy design, not a gap.
   */
  @Get('search-analytics')
  searchAnalytics(
    @Query(new ZodValidationPipe(searchAnalyticsQuery))
    query: z.infer<typeof searchAnalyticsQuery>,
  ) {
    return this.searchAnalyticsService.overview(query.days, query.limit);
  }
}
