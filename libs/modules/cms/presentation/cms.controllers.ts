import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { COST_WINDOWS, isCalendarDay, MANUAL_COST_PERIODS } from '@gogo/cost-observability';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentActor, Public, RateLimit } from '../../identity/presentation/decorators';
import type { Actor } from '../../identity/domain/actor';
import { AdminAuthService } from '../application/admin-auth.service';
import {
  CF_ACCESS_ASSERTION_HEADER,
  CloudflareAccessService,
} from '../application/cf-access.service';
import {
  CmsCatalogService,
  PLACE_SORTS,
  PLACE_SOURCES,
  type PlaceEditInput,
} from '../application/cms-catalog.service';
import { HOURS_ENTRY_KINDS } from '../domain/place-hours';
import { CmsPlaceMediaService } from '../application/cms-place-media.service';
import { CmsContentService } from '../application/cms-content.service';
import { CmsUploadsService } from '../application/cms-uploads.service';
import {
  BANNER_DESTINATIONS,
  BANNER_EFFECTIVE_STATUSES,
  BANNER_PLACEMENTS,
  BANNER_STATUSES,
  BannersService,
} from '../application/banners.service';
import { CampaignsService } from '../../notifications/application/campaigns.service';
import {
  CAMPAIGN_AUDIENCES,
  CAMPAIGN_DESTINATIONS,
  CAMPAIGN_STATUSES,
} from '../../notifications/domain/campaign';
import { SafetyRulesService } from '../application/safety-rules.service';
import {
  SAFETY_RULE_ACTIONS,
  SAFETY_RULE_SEVERITIES,
  SAFETY_RULE_STATUSES,
  SAFETY_RULE_TRIGGERS,
  SAFETY_RULE_TYPES,
} from '../domain/safety-rule-conditions';
import {
  RECOMMENDATION_STATUSES,
  RecommendationsService,
} from '../application/recommendations.service';
import { CONTENT_AUDIENCES } from '../../shared/audience';
import {
  BUDGET_SCOPES,
  PLAN_TEMPLATE_STATUSES,
  PlanTemplatesService,
} from '../application/plan-templates.service';
import { CMS_UPLOAD_PURPOSES, MAX_UPLOAD_BYTES } from '../../uploads/application/uploads.service';
import { CmsAuditService } from '../application/cms-audit.service';
import { CmsOpsService } from '../application/cms-ops.service';
import { CmsObservabilityService } from '../application/cms-observability.service';
import { CmsCostCenterService } from '../application/cms-cost-center.service';
import { CmsOpsMetricsService } from '../application/cms-ops-metrics.service';
import { OPS_PROVIDERS, OPS_WINDOWS } from '../domain/ops-metrics';
import { CmsUsersService } from '../application/cms-users.service';
import { PrivacyRequestsService } from '../application/privacy-requests.service';
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
import { AllowWhilePasswordChangePending, RequireRole, type AdminActor } from './admin.guard';
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
/**
 * #248 — a reason is required on every staff-account mutation. An audit row
 * that records what changed but not why answers the easy half of the question
 * a reviewer is actually asking.
 */
const reasonSchema = z.string().trim().min(3).max(500);
const updateAdminSchema = z
  .object({
    role: z.enum(['editor', 'moderator', 'ops_admin', 'super_admin']).optional(),
    displayName: z.string().trim().min(1).max(50).optional(),
    reason: reasonSchema,
  })
  .refine((v) => v.role !== undefined || v.displayName !== undefined, {
    message: 'Nothing to change: provide role or displayName',
  });
const adminReasonSchema = z.object({ reason: reasonSchema });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  // Same floor as account creation: a temporary password must not be
  // replaceable by something weaker than the account was created with.
  newPassword: z.string().min(12).max(128),
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
    private readonly access: CloudflareAccessService,
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

  /**
   * #62 / ADR-0010 — exchange a Cloudflare Access assertion for a console
   * session. `@Public()` in the sense that no GoGo session is required yet;
   * the request still has to carry an assertion this deployment can verify.
   *
   * An exchange rather than per-request header trust: one place decides that
   * an identity is real, and everything downstream — `AdminGuard`, the audit
   * trail, session revocation, logout-all — keeps working on the session model
   * it already has. Reading the header on every request would mean an admin
   * revoked in the console keeps their access until Cloudflare's own session
   * expires, because nothing of ours would be in the loop.
   */
  @Public()
  @RateLimit({ action: 'cms.access_exchange', limit: 10, windowSeconds: 60, keyBy: 'ip' })
  @Post('access-exchange')
  async accessExchange(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const assertion = req.headers[CF_ACCESS_ASSERTION_HEADER];
    if (typeof assertion !== 'string' || !assertion) {
      throw AppError.unauthorized(
        'ACCESS_ASSERTION_MISSING',
        'This endpoint is reachable only through Cloudflare Access',
      );
    }
    const identity = await this.access.verify(assertion);
    const result = await this.auth.loginWithAccessIdentity(identity, clientMeta(req));
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

  /**
   * BE-CMS-G9 (#248) — edit a staff account.
   *
   * `super_admin` only, like the create and the list: who holds which role is
   * the shape of the authorization model, so changing it is not an editorial
   * action.
   */
  @RequireRole('super_admin')
  @Patch('admins/:id')
  updateAdmin(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(updateAdminSchema)) body: z.infer<typeof updateAdminSchema>,
  ) {
    return this.auth.updateAdmin({ ...body, id, actorId: actor.id });
  }

  @RequireRole('super_admin')
  @Post('admins/:id/suspend')
  suspendAdmin(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(adminReasonSchema)) body: { reason: string },
  ) {
    return this.auth.setAdminStatus({ id, status: 'suspended', ...body, actorId: actor.id });
  }

  @RequireRole('super_admin')
  @Post('admins/:id/reactivate')
  reactivateAdmin(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(adminReasonSchema)) body: { reason: string },
  ) {
    return this.auth.setAdminStatus({ id, status: 'active', ...body, actorId: actor.id });
  }

  /**
   * #248 — the temporary password is in the response body and nowhere else:
   * not in a log, not readable again, not recoverable if the tab closes. It is
   * a credential, and it is handed over exactly like one.
   *
   * Rate-limited per actor rather than per IP. The limit here is not about
   * brute force — the caller is already `super_admin` — it is about a script
   * looping over the account list and resetting everyone.
   */
  @RequireRole('super_admin')
  @RateLimit({ action: 'cms.admin_password_reset', limit: 5, windowSeconds: 300, keyBy: 'actor' })
  @Post('admins/:id/reset-password')
  resetAdminPassword(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(adminReasonSchema)) body: { reason: string },
  ) {
    return this.auth.resetAdminPassword({ id, ...body, actorId: actor.id });
  }

  /**
   * #248 — an admin replaces their own password. Every role, because everyone
   * has one; and the only route reachable while a change is owed, which is
   * what keeps the obligation from being a deadlock.
   */
  @RequireRole('editor', 'moderator', 'ops_admin', 'super_admin')
  @AllowWhilePasswordChangePending()
  @RateLimit({ action: 'cms.change_password', limit: 5, windowSeconds: 300, keyBy: 'actor' })
  @Post('change-password')
  changePassword(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    return this.auth.changeOwnPassword({
      adminId: actor.id,
      ...body,
      // The session doing the changing survives; every other one does not.
      keepSessionId: actor.sessionId,
    });
  }
}

// ---------------------------------------------------------------- app users

const appUserListQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'suspended', 'banned', 'deleted']).optional(),
  // Each row costs four indexed counter lookups, so the page size is what
  // keeps this from being a table scan wearing a filter.
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
const userReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const roomListQuery = z.object({
  status: z.enum(['draft', 'active', 'planning', 'completed', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
const planListQuery = z.object({
  status: z.enum(['draft', 'current', 'superseded', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/**
 * BE-CMS-G7 (#246) — app users, rooms and plans.
 *
 * `ops_admin` and above, and deliberately **not** open to the guard's
 * rank-read: an editor reading catalogue data is ordinary, an editor reading
 * the user base is not. Account data is the one collection here where the
 * read is as sensitive as the write.
 */
@RequireRole('ops_admin', 'super_admin')
@Controller('cms')
export class CmsUsersController {
  constructor(private readonly users: CmsUsersService) {}

  @Get('users')
  listUsers(
    @Query(new ZodValidationPipe(appUserListQuery)) query: z.infer<typeof appUserListQuery>,
  ) {
    return this.users.list(query);
  }

  @Get('users/:id')
  userDetail(@Param('id', Uuid) id: string) {
    return this.users.detail(id);
  }

  @Post('users/:id/suspend')
  suspendUser(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(userReasonSchema)) body: { reason: string },
  ) {
    return this.users.setStatus({ id, status: 'suspended', ...body, actorId: actor.id });
  }

  @Post('users/:id/ban')
  banUser(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(userReasonSchema)) body: { reason: string },
  ) {
    return this.users.setStatus({ id, status: 'banned', ...body, actorId: actor.id });
  }

  @Post('users/:id/reactivate')
  reactivateUser(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(userReasonSchema)) body: { reason: string },
  ) {
    return this.users.setStatus({ id, status: 'active', ...body, actorId: actor.id });
  }

  /**
   * Erasure, run on the account holder's behalf. `super_admin` only: it is the
   * one action here that cannot be undone, and the account it destroys is
   * somebody else's.
   */
  @RequireRole('super_admin')
  @Post('users/:id/delete')
  deleteUser(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(userReasonSchema)) body: { reason: string },
  ) {
    return this.users.deleteAccount({ id, ...body, actorId: actor.id });
  }

  /**
   * A subject-access request made through support instead of the app. Rate
   * limited per actor: the payload is one person's entire history, and a loop
   * over the user list is a data export nobody authorized.
   */
  @RateLimit({ action: 'cms.user_export', limit: 10, windowSeconds: 300, keyBy: 'actor' })
  @Post('users/:id/export')
  exportUser(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(userReasonSchema)) body: { reason: string },
  ) {
    return this.users.exportData({ id, ...body, actorId: actor.id });
  }

  @Get('rooms')
  listRooms(@Query(new ZodValidationPipe(roomListQuery)) query: z.infer<typeof roomListQuery>) {
    return this.users.listRooms(query);
  }

  /** BE-CMS-G11 (#254) — room-scoped only; there is no global guest list. */
  @Get('rooms/:id/guests')
  roomGuests(@Param('id', Uuid) id: string) {
    return this.users.roomGuests(id);
  }

  /**
   * #254 — "remove from room", which is what it actually does. Not a ban:
   * a guest holding a still-valid invite can rejoin with a fresh session, and
   * both the contract and the console say so instead of promising otherwise.
   */
  @Post('rooms/:id/guests/:memberId/remove')
  removeGuest(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Param('memberId', Uuid) memberId: string,
    @Body(new ZodValidationPipe(userReasonSchema)) body: { reason: string },
  ) {
    return this.users.removeGuest({ roomId: id, memberId, ...body, actorId: actor.id });
  }

  @Get('plans')
  listPlans(@Query(new ZodValidationPipe(planListQuery)) query: z.infer<typeof planListQuery>) {
    return this.users.listPlans(query);
  }
}

// ---------------------------------------------------------------- privacy requests

const privacyTypes = z.enum(['export', 'delete', 'correction']);
const privacyOutcomes = z.enum([
  'completed',
  'no_account_found',
  'identity_not_verified',
  'rejected',
  'failed',
]);
/**
 * #255 — operator note is deliberately short. Privacy systems grow their own
 * PII through free text; 256 characters holds a ticket id and a sentence, not
 * a conversation. The console shows guidance next to the field.
 */
const operatorNote = z.string().trim().max(256).optional();
const privacyCreateSchema = z
  .object({
    type: privacyTypes,
    subjectType: z.enum(['user', 'email', 'external']),
    userId: z.string().uuid().optional(),
    contactEmail: z.string().email().max(254).optional(),
    externalReference: z.string().trim().min(1).max(120).optional(),
    reasonCode: z.string().trim().max(64).optional(),
    ticketReference: z.string().trim().max(64).optional(),
    operatorNote,
  })
  .refine(
    (v) =>
      (v.subjectType === 'user' && v.userId) ||
      (v.subjectType === 'email' && v.contactEmail) ||
      (v.subjectType === 'external' && v.externalReference),
    { message: 'subjectType must be accompanied by its identifier' },
  );
const privacyListQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'in_progress', 'closed']).optional(),
  type: privacyTypes.optional(),
  outcome: privacyOutcomes.optional(),
  sla: z.enum(['overdue', 'due_soon']).optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
const privacyCloseSchema = z.object({
  outcome: z.enum(['no_account_found', 'identity_not_verified', 'rejected', 'failed']),
  reasonCode: z.string().trim().max(64).optional(),
  operatorNote,
});
const privacyDeliveredSchema = z.object({
  deliveryMethod: z.enum(['in_app', 'secure_download', 'other']),
});
const retentionHoldSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  legalBasis: z.string().trim().min(3).max(500),
  reviewAt: z.coerce.date(),
  holdUntil: z.coerce.date().optional(),
});

/**
 * BE-CMS-G12 (#255) — the privacy-request compliance ledger. ADR-0011.
 *
 * `ops_admin` and above for the workflow; `super_admin` for the two actions
 * that are irreversible or legal in nature: executing a delete, and placing or
 * releasing a retention hold.
 */
@RequireRole('ops_admin', 'super_admin')
@Controller('cms/privacy-requests')
export class PrivacyRequestsController {
  constructor(private readonly requests: PrivacyRequestsService) {}

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(privacyCreateSchema)) body: z.infer<typeof privacyCreateSchema>,
  ) {
    return this.requests.create({ ...body, actorId: actor.id });
  }

  @Get()
  list(@Query(new ZodValidationPipe(privacyListQuery)) query: z.infer<typeof privacyListQuery>) {
    return this.requests.list(query);
  }

  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.requests.detail(id);
  }

  @Post(':id/acknowledge')
  acknowledge(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.requests.acknowledge({ id, actorId: actor.id });
  }

  /**
   * Executes THIS request. The role check for a delete lives in the service
   * because the route cannot know the type before loading the row; an
   * `ops_admin` executing a delete request gets 403 from there.
   */
  @RateLimit({ action: 'cms.privacy_execute', limit: 10, windowSeconds: 300, keyBy: 'actor' })
  @Post(':id/execute')
  execute(@CurrentActor() actor: AdminActor, @Param('id', Uuid) id: string) {
    return this.requests.execute({ id, actorId: actor.id, actorRole: actor.role });
  }

  @Post(':id/close')
  close(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(privacyCloseSchema)) body: z.infer<typeof privacyCloseSchema>,
  ) {
    return this.requests.close({ id, ...body, actorId: actor.id });
  }

  @Post(':id/delivered')
  delivered(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(privacyDeliveredSchema))
    body: z.infer<typeof privacyDeliveredSchema>,
  ) {
    return this.requests.markDelivered({ id, ...body, actorId: actor.id });
  }

  @RequireRole('super_admin')
  @Post(':id/retention-hold')
  hold(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(retentionHoldSchema)) body: z.infer<typeof retentionHoldSchema>,
  ) {
    return this.requests.holdRetention({ id, ...body, actorId: actor.id });
  }

  @RequireRole('super_admin')
  @Post(':id/retention-hold/release')
  release(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(userReasonSchema)) body: { reason: string },
  ) {
    return this.requests.releaseHold({ id, ...body, actorId: actor.id });
  }
}

// ---------------------------------------------------------------- catalog

/**
 * BE-CMS-PE-001 (#425).
 *
 * `.nullable()` on the text fields is the point of this revision: an editor
 * could fill `areaKey` and never empty it again, because the console had no
 * way to say "clear this" that this schema would accept. `null` clears,
 * absence leaves alone.
 *
 * `avgVisitMinutes` keeps its 10..720 floor — a place worth ten minutes is a
 * typo — but gains `null`, which is what an empty box actually means. The
 * console used to coerce that empty box to `0` and get a 400 on every save of
 * a place that had no visit duration.
 */
const placeEditSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  addressText: z.string().max(400).nullable().optional(),
  areaKey: z.string().trim().max(64).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  district: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  website: z.string().trim().max(500).nullable().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  avgVisitMinutes: z.number().int().min(10).max(720).nullable().optional(),
  suitability: z.record(z.string(), z.number().min(0).max(1)).optional(),
  isLodging: z.boolean().optional(),
  curatedRank: z.number().int().min(0).nullable().optional(),
  taxonomyIds: z.array(z.string().uuid()).max(30).optional(),
  /** Optimistic concurrency — the `updatedAt` the form was loaded from. */
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});
const placeStatusSchema = z.object({
  status: z.enum(['draft', 'community_submitted', 'review', 'published', 'suspended', 'archived']),
});
/**
 * #425 — a row now says which of the three things it asserts about its day.
 *
 * `kind` defaults to `interval`, so a body written against the previous
 * contract still validates and still means what it meant. `closed` and
 * `open_24h` carry no minutes; the domain rejects a body that sends them
 * anyway, before the column check has to.
 *
 * `source` lets the console re-save a week without claiming to have verified
 * it. Absent means `editor`, because a row arriving from this endpoint is
 * normally something a person typed.
 */
const hoursSchema = z.object({
  hours: z
    .array(
      z
        .object({
          dayOfWeek: z.number().int().min(0).max(6),
          kind: z.enum(HOURS_ENTRY_KINDS).default('interval'),
          openMinute: z.number().int().min(0).max(1439).default(0),
          closeMinute: z.number().int().min(0).max(1439).default(0),
          isOvernight: z.boolean().default(false),
          source: z.enum(['provider', 'editor']).optional(),
        })
        .strict(),
    )
    // 7 days x 4 services. The old cap of 21 predated multiple services a day.
    .max(28),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
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
    return this.catalog.setHours(actor.id, id, body.hours, body.expectedUpdatedAt);
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

// ------------------------------------------------------------------ media

const mediaAttachSchema = z.object({
  storageKey: z.string().trim().min(1).max(400),
  caption: z.string().trim().max(300).nullable().optional(),
  attribution: z.string().trim().max(300).nullable().optional(),
  isCover: z.boolean().optional(),
  width: z.number().int().positive().max(20000).nullable().optional(),
  height: z.number().int().positive().max(20000).nullable().optional(),
});

const mediaPatchSchema = z
  .object({
    sortOrder: z.number().int().min(0).max(999).optional(),
    moderation: z.enum(['pending', 'approved', 'rejected']).optional(),
    /** Required when `moderation` changes — enforced in the service. */
    moderationReason: z.string().trim().min(3).max(500).optional(),
    caption: z.string().trim().max(300).nullable().optional(),
    attribution: z.string().trim().max(300).nullable().optional(),
    isCover: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Không có thay đổi nào',
  });

/**
 * BE-CMS-M1 (#191) — place photos, editable at last.
 *
 * `@RequireRole('editor')` like the rest of the catalog: this is catalog
 * editing, not moderation of user content, so `moderator` and `ops_admin` are
 * refused the writes and the read stays rank-based like every other catalog
 * read.
 *
 * Bytes do not pass through here. An editor asks `POST /cms/uploads` for a
 * presigned PUT with purpose `place_image`, PUTs the file to storage, and then
 * hands the key to `POST /cms/places/{id}/media`. Splitting it that way is what
 * keeps the API off the upload path and lets a failed attach leave nothing
 * behind.
 */
@RequireRole('editor')
@Controller('cms/places/:placeId/media')
export class CmsPlaceMediaController {
  constructor(private readonly media: CmsPlaceMediaService) {}

  /**
   * Declared before `:mediaId` routes for the usual reason — Nest matches in
   * declaration order, and `:mediaId` would otherwise swallow `/attachable`.
   */
  @Get('attachable')
  attachable(@CurrentActor() actor: Actor, @Param('placeId', Uuid) placeId: string) {
    return this.media.attachable(actor, placeId);
  }

  @Post()
  attach(
    @CurrentActor() actor: Actor,
    @Param('placeId', Uuid) placeId: string,
    @Body(new ZodValidationPipe(mediaAttachSchema)) body: z.infer<typeof mediaAttachSchema>,
  ) {
    return this.media.attach(actor, placeId, body);
  }

  @Patch(':mediaId')
  update(
    @CurrentActor() actor: Actor,
    @Param('placeId', Uuid) placeId: string,
    @Param('mediaId', Uuid) mediaId: string,
    @Body(new ZodValidationPipe(mediaPatchSchema)) body: z.infer<typeof mediaPatchSchema>,
  ) {
    return this.media.update(actor, placeId, mediaId, body);
  }

  @Delete(':mediaId')
  detach(
    @CurrentActor() actor: Actor,
    @Param('placeId', Uuid) placeId: string,
    @Param('mediaId', Uuid) mediaId: string,
  ) {
    return this.media.detach(actor, placeId, mediaId);
  }
}

// ------------------------------------------------------------------ areas

const areaListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  /**
   * A retired area is not offered as a new choice, but a place already filed
   * under one must still resolve its label — so the console asks for the
   * inactive rows too when it is rendering a value it already holds.
   */
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

/**
 * BE-CMS-PE-001 (#425) — the catalog behind `areaKey`.
 *
 * The console shipped `areaKey` as a free text box under a hint telling the
 * editor to pick a taxonomy, and there is no `area` taxonomy kind — so the
 * hint pointed at nothing and the box accepted anything, including keys the
 * place filter would never match.
 *
 * The vocabulary was there the whole time: `service_areas` is what community
 * import checks a submitted place's coordinates against, and its keys are
 * exactly the values `places.area_key` holds. This exposes it rather than
 * building a second list that would drift from the first.
 */
@RequireRole('editor')
@Controller('cms/areas')
export class CmsAreasController {
  constructor(private readonly catalog: CmsCatalogService) {}

  @Get()
  list(@Query(new ZodValidationPipe(areaListQuery)) query: z.infer<typeof areaListQuery>) {
    return this.catalog.listAreas(query);
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

// ---------------------------------------------------------------- recommendations

/**
 * BE-CMS-G4a (#222) — a recommendation is a targeted collection (ADR-0009):
 * the same ordered list of places, plus who it is for.
 */
const recommendationBody = {
  internalName: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(200).optional(),
  description: z.string().max(2000).optional(),
  locale: z.string().max(8).optional(),
  audience: z.enum(CONTENT_AUDIENCES),
  /** Same vocabulary as `places.areaKey`; "city" is one concept, not two. */
  areaKey: z.string().trim().max(64).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  /** Stable taxonomy ids (category / mood); labels resolve client-side. */
  taxonomyIds: z.array(z.string().uuid()).max(30).optional(),
  /** Ordered: position is the index, and the order round-trips. */
  placeIds: z.array(z.string().uuid()).max(100).optional(),
};
const recommendationCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  ...recommendationBody,
});
const recommendationPatchSchema = z.object(recommendationBody).partial();
const recommendationStatusSchema = z.object({ status: z.enum(RECOMMENDATION_STATUSES) });
const recommendationPlacesSchema = z.object({
  placeIds: z.array(z.string().uuid()).max(100),
});
const recommendationListQuery = z.object({
  status: z.enum(RECOMMENDATION_STATUSES).optional(),
  audience: z.enum(CONTENT_AUDIENCES).optional(),
  areaKey: z.string().trim().max(64).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

@RequireRole('editor', 'ops_admin')
@Controller('cms/recommendations')
export class CmsRecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(recommendationListQuery))
    query: z.infer<typeof recommendationListQuery>,
  ) {
    return this.recommendations.list(query);
  }

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(recommendationCreateSchema))
    body: z.infer<typeof recommendationCreateSchema>,
  ) {
    return this.recommendations.create(actor.id, body);
  }

  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.recommendations.get(id);
  }

  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(recommendationPatchSchema))
    body: z.infer<typeof recommendationPatchSchema>,
  ) {
    return this.recommendations.update(actor.id, id, body);
  }

  @Patch(':id/status')
  setStatus(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(recommendationStatusSchema))
    body: z.infer<typeof recommendationStatusSchema>,
  ) {
    return this.recommendations.setStatus(actor.id, id, body.status);
  }

  /** Replaces the ordered list wholesale; the array order is the order. */
  @Put(':id/places')
  setPlaces(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(recommendationPlacesSchema))
    body: z.infer<typeof recommendationPlacesSchema>,
  ) {
    return this.recommendations.setPlaces(actor.id, id, body.placeIds);
  }
}

// ---------------------------------------------------------------- plan templates

/**
 * BE-CMS-G4b (#223) — templates the CMS owns, as source material for future
 * plans. Nothing here reaches a live plan, and nothing should be added that
 * does.
 */
const budgetSchema = z.object({
  /** Integer minor units — 150000 is 1.500,00 ₫, never 150000.0. */
  min: z.number().int().min(0),
  max: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO-4217, uppercase'),
  /** What the amount is *per*. Never assumed. */
  scope: z.enum(BUDGET_SCOPES),
});
const templateStopSchema = z.object({
  categoryTaxonomyId: z.string().uuid(),
  preferredPlaceId: z.string().uuid().optional(),
  isOptional: z.boolean().optional(),
  expectedDurationMinutes: z.number().int().min(5).max(1440),
  budget: budgetSchema.optional(),
  note: z.string().max(500).optional(),
});
const templateBody = {
  internalName: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  locale: z.string().max(8).optional(),
  audience: z.enum(CONTENT_AUDIENCES).optional(),
  areaKey: z.string().trim().max(64).optional(),
  budget: budgetSchema.optional(),
  expectedDurationMinutes: z.number().int().min(15).max(1440).optional(),
  /** Mood/setting keys for the template as a whole. */
  taxonomyIds: z.array(z.string().uuid()).max(20).optional(),
  /** Ordered: the array index becomes the stored position. */
  stops: z.array(templateStopSchema).max(20).optional(),
};
const templateCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  ...templateBody,
});
const templatePatchSchema = z.object(templateBody).partial();
const templateStatusSchema = z.object({ status: z.enum(PLAN_TEMPLATE_STATUSES) });
const templateStopsSchema = z.object({ stops: z.array(templateStopSchema).max(20) });
const templateListQuery = z.object({
  status: z.enum(PLAN_TEMPLATE_STATUSES).optional(),
  audience: z.enum(CONTENT_AUDIENCES).optional(),
  areaKey: z.string().trim().max(64).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

@RequireRole('editor', 'ops_admin')
@Controller('cms/plan-templates')
export class CmsPlanTemplatesController {
  constructor(private readonly templates: PlanTemplatesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(templateListQuery)) query: z.infer<typeof templateListQuery>) {
    return this.templates.list(query);
  }

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(templateCreateSchema))
    body: z.infer<typeof templateCreateSchema>,
  ) {
    return this.templates.create(actor.id, body);
  }

  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.templates.get(id);
  }

  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(templatePatchSchema)) body: z.infer<typeof templatePatchSchema>,
  ) {
    return this.templates.update(actor.id, id, body);
  }

  @Patch(':id/status')
  setStatus(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(templateStatusSchema)) body: z.infer<typeof templateStatusSchema>,
  ) {
    return this.templates.setStatus(actor.id, id, body.status);
  }

  @Put(':id/stops')
  setStops(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(templateStopsSchema)) body: z.infer<typeof templateStopsSchema>,
  ) {
    return this.templates.setStops(actor.id, id, body.stops);
  }
}

// ---------------------------------------------------------------- trust & safety

/**
 * BE-CMS-G4d (#225) — rule definitions, not a rule builder.
 *
 * `conditions` is passed through as `unknown` here on purpose: the closed
 * schema for the rule type lives in the domain and is applied in the service,
 * so there is exactly one place that decides what a condition may say.
 */
const safetyRuleCreateSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().max(1000).optional(),
  ruleType: z.enum(SAFETY_RULE_TYPES),
  trigger: z.enum(SAFETY_RULE_TRIGGERS),
  conditions: z.unknown().optional(),
  action: z.enum(SAFETY_RULE_ACTIONS),
  severity: z.enum(SAFETY_RULE_SEVERITIES).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  /** Machine-readable: what a decision this rule causes will be tagged with. */
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
});
const safetyRulePatchSchema = safetyRuleCreateSchema.omit({ ruleType: true }).partial();
const safetyRuleStatusSchema = z.object({ status: z.enum(SAFETY_RULE_STATUSES) });
const safetyRuleListQuery = z.object({
  ruleType: z.enum(SAFETY_RULE_TYPES).optional(),
  status: z.enum(SAFETY_RULE_STATUSES).optional(),
  action: z.enum(SAFETY_RULE_ACTIONS).optional(),
  severity: z.enum(SAFETY_RULE_SEVERITIES).optional(),
  trigger: z.enum(SAFETY_RULE_TRIGGERS).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/**
 * `ops_admin`, both ways.
 *
 * A rule here can suspend an account with no human in the loop — that is
 * policy, not day-to-day moderation. Reads do not climb (BE-IMP-008), so a
 * moderator sees neither the list nor a rule; the queue they work is the
 * moderation resource, not this one.
 */
@RequireRole('ops_admin')
@Controller('cms/safety-rules')
export class CmsSafetyRulesController {
  constructor(private readonly rules: SafetyRulesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(safetyRuleListQuery)) query: z.infer<typeof safetyRuleListQuery>,
  ) {
    return this.rules.list(query);
  }

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(safetyRuleCreateSchema))
    body: z.infer<typeof safetyRuleCreateSchema>,
  ) {
    return this.rules.create(actor.id, body);
  }

  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.rules.get(id);
  }

  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(safetyRulePatchSchema))
    body: z.infer<typeof safetyRulePatchSchema>,
  ) {
    return this.rules.update(actor.id, id, body);
  }

  @Patch(':id/status')
  setStatus(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(safetyRuleStatusSchema))
    body: z.infer<typeof safetyRuleStatusSchema>,
  ) {
    return this.rules.setStatus(actor.id, id, body.status);
  }
}

// ---------------------------------------------------------------- campaigns

/**
 * BE-CMS-G4e (#226) — composing a campaign. Nothing here sends one.
 *
 * Every write is a row transition; the worker is what turns a scheduled row
 * into messages. A campaign that has gone out cannot be recalled, so the API
 * deliberately has no path that reaches a provider.
 */
const campaignBody = {
  name: z.string().trim().min(3).max(120),
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(300),
  /** Key from POST /cms/uploads with purpose `campaign_image`. */
  imageKey: z.string().max(300).optional(),
  ctaLabel: z.string().trim().max(40).optional(),
  audienceType: z.enum(CAMPAIGN_AUDIENCES),
  audienceFilter: z.unknown().optional(),
  destinationType: z.enum(CAMPAIGN_DESTINATIONS).optional(),
  destinationValue: z.string().max(2000).optional(),
};
const campaignCreateSchema = z.object(campaignBody);
const campaignPatchSchema = z.object(campaignBody).partial();
const campaignScheduleSchema = z
  .object({
    /** Omitted means now: the next worker tick picks it up. */
    sendAt: z.coerce.date().optional(),
  })
  .default({});
const campaignListQuery = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  audienceType: z.enum(CAMPAIGN_AUDIENCES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

@RequireRole('ops_admin')
@Controller('cms/campaigns')
export class CmsCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(campaignListQuery)) query: z.infer<typeof campaignListQuery>) {
    return this.campaigns.list(query);
  }

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(campaignCreateSchema)) body: z.infer<typeof campaignCreateSchema>,
  ) {
    return this.campaigns.create(actor.id, body);
  }

  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.campaigns.get(id);
  }

  /** Read-only, no side effect: the size of a send before committing to it. */
  @Get(':id/audience-estimate')
  estimate(@Param('id', Uuid) id: string) {
    return this.campaigns.estimateAudience(id);
  }

  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(campaignPatchSchema)) body: z.infer<typeof campaignPatchSchema>,
  ) {
    return this.campaigns.update(actor.id, id, body);
  }

  /**
   * Marks the campaign due. The request returns before a single message
   * exists — delivery happens on the worker's tick, through the provider
   * adapter, and never here.
   */
  @Post(':id/schedule')
  schedule(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(campaignScheduleSchema))
    body: z.infer<typeof campaignScheduleSchema>,
  ) {
    return this.campaigns.schedule(actor.id, id, body.sendAt);
  }

  @Post(':id/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.campaigns.cancel(actor.id, id);
  }

  /**
   * One copy to the composer's own account, queued for the worker like
   * everything else. Rate-limited because it is the one send path a person can
   * trigger repeatedly.
   */
  @RateLimit({ action: 'cms.campaign_test', limit: 10, windowSeconds: 300, keyBy: 'actor' })
  @Post(':id/test-send')
  testSend(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    return this.campaigns.requestTestSend(actor.id, id);
  }
}

// ---------------------------------------------------------------- banners

/**
 * BE-CMS-G4c (#224) — banners.
 *
 * `image` is mandatory because a banner is an image; the key comes from
 * `POST /cms/uploads` (purpose `banner_image`) and is bound to the banner on
 * save through the same attach path check-in uses.
 */
const bannerBody = {
  name: z.string().trim().min(3).max(120),
  imageKey: z.string().min(1).max(300),
  title: z.string().trim().max(120).optional(),
  subtitle: z.string().trim().max(200).optional(),
  ctaLabel: z.string().trim().max(40).optional(),
  destinationType: z.enum(BANNER_DESTINATIONS).optional(),
  destinationValue: z.string().max(2000).optional(),
  audience: z.enum(CONTENT_AUDIENCES).optional(),
  placement: z.enum(BANNER_PLACEMENTS),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
};
const bannerCreateSchema = z.object(bannerBody);
const bannerPatchSchema = z.object(bannerBody).partial();
const bannerStatusSchema = z.object({ status: z.enum(BANNER_STATUSES) });
const bannerListQuery = z.object({
  placement: z.enum(BANNER_PLACEMENTS).optional(),
  /** Includes `expired`, which the server computes rather than stores. */
  status: z.enum(BANNER_EFFECTIVE_STATUSES).optional(),
  audience: z.enum(CONTENT_AUDIENCES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

@RequireRole('editor', 'ops_admin')
@Controller('cms/banners')
export class CmsBannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  list(@Query(new ZodValidationPipe(bannerListQuery)) query: z.infer<typeof bannerListQuery>) {
    return this.banners.list(query);
  }

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(bannerCreateSchema)) body: z.infer<typeof bannerCreateSchema>,
  ) {
    return this.banners.create(actor, body);
  }

  @Get(':id')
  detail(@Param('id', Uuid) id: string) {
    return this.banners.get(id);
  }

  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(bannerPatchSchema)) body: z.infer<typeof bannerPatchSchema>,
  ) {
    return this.banners.update(actor, id, body);
  }

  @Patch(':id/status')
  setStatus(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(bannerStatusSchema)) body: z.infer<typeof bannerStatusSchema>,
  ) {
    return this.banners.setStatus(actor.id, id, body.status);
  }
}

// ---------------------------------------------------------------- uploads

/**
 * BE-CMS-G5 (#227) — the console's own upload door.
 *
 * Same presigner, allowlist and size ceiling as `/v1/uploads`; what differs is
 * that the key is bound to a staff account and to a purpose only staff may ask
 * for. `contentLength` is declared up front so an oversized file is refused
 * before a URL exists, rather than after the bytes have crossed the network.
 */
const cmsUploadSchema = z.object({
  purpose: z.enum(CMS_UPLOAD_PURPOSES),
  contentType: z.string().min(1).max(100),
  contentLength: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

@RequireRole('editor', 'ops_admin')
@Controller('cms/uploads')
export class CmsUploadsController {
  constructor(private readonly uploads: CmsUploadsService) {}

  /**
   * Rate-limited per actor like the consumer path: each call costs a signature
   * and a pending row, and an unbounded loop would fill the table.
   */
  @RateLimit({ action: 'cms.uploads.create', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(cmsUploadSchema)) body: z.infer<typeof cmsUploadSchema>,
  ) {
    return this.uploads.create(actor, body);
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

  /**
   * BE-CMS-G6 (#232) — read one review.
   *
   * The list defaults to `pending`, which is right for a queue and wrong for
   * a link: a shared URL pointing at a review someone already decided has to
   * open, rather than the console saying "not in the current filter" about a
   * row that plainly exists. So this is not status-filtered.
   *
   * Same role gate as the list it belongs to.
   */
  @Get('reviews/:id')
  review(@Param('id', Uuid) id: string) {
    return this.queues.reviewById(id);
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
/**
 * #315 — the entire client-controlled surface of the ops metrics endpoints.
 *
 * An enum, deliberately, not a duration string and not a start/end pair. A
 * free-form range is an arbitrary load on the store and an arbitrary number of
 * points at the browser; four fixed windows are the product decision, and they
 * are also what makes "no client-supplied PromQL" true by construction rather
 * than by escaping.
 */
const opsWindowQuery = z.object({
  window: z.enum(OPS_WINDOWS).default('24h'),
});

const opsProviderParam = z.object({
  provider: z.enum(OPS_PROVIDERS),
});

/**
 * COST-BE-022 (#381) — the Cost API v2 input surface.
 *
 * `window` is an enum of day-shaped windows: the daily tables cannot answer
 * `1h`, and a free cap is monthly, so `mtd` is the default the cards are
 * built for. Ids are registry ids (`google`, `google.places`), validated by
 * shape here and by existence in the service — an unknown id is a 404, not a
 * 400, because the registry is data and the list of valid ids is not fixed
 * at build time (epic §44.2).
 */
const costWindowQuery = z.object({
  window: z.enum(COST_WINDOWS).default('mtd'),
});
const registryId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);
const costProviderParam = z.object({ providerId: registryId });
const costServiceParam = z.object({ providerId: registryId, serviceId: registryId });
const testRunListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
/**
 * COST-BE-023 (#382) — a manual cost item as the CMS sends it. Money is
 * micros of `currency` per period (the fee, never a daily share); days are
 * real calendar days. Whether the service may carry a manual cost is the
 * registry's answer, given in the service as a field error — not an enum
 * here, for the same reason as the ids above.
 */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDay, { message: 'expected a real YYYY-MM-DD day' });
const manualCostItemFields = {
  providerId: registryId,
  serviceId: registryId,
  name: z.string().trim().min(1).max(120),
  amountMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(MANUAL_COST_PERIODS),
  effectiveFrom: calendarDay,
  effectiveTo: calendarDay.nullable(),
  note: z.string().trim().max(1000).nullable(),
};
const manualCostItemCreate = z.object({
  ...manualCostItemFields,
  currency: manualCostItemFields.currency.default('USD'),
  effectiveTo: manualCostItemFields.effectiveTo.default(null),
  note: manualCostItemFields.note.default(null),
});
const manualCostItemPatch = z
  .object(manualCostItemFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

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
    private readonly observability: CmsObservabilityService,
    private readonly opsMetrics: CmsOpsMetricsService,
    private readonly costCenter: CmsCostCenterService,
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
   * BE-CMS-G8 (#247) — the operations view.
   *
   * `/health` and `/metrics` already exist and neither is reachable from the
   * console: the CMS Worker proxies `/v1/*` only, and Prometheus text is not
   * something a client should parse. Same information, inside the contract,
   * shaped for a screen.
   *
   * `ops_admin` and above. Dependency topology and queue depth describe how
   * the system is built and where it is weak, which is not editorial data.
   */
  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/health')
  opsHealth() {
    return this.observability.health();
  }

  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/queues')
  opsQueues() {
    return this.observability.queueStats();
  }

  /**
   * COST-BE-022 (#381) — the Cost Center overview: the legacy #335 payload
   * (kept whole, one release, for the deployed dashboard) plus the epic §35
   * cards and registry-keyed `providerRows`. The two never share a key, so a
   * client on either shape reads what it expects.
   */
  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs')
  async opsCosts(
    @Query(new ZodValidationPipe(costWindowQuery)) query: z.infer<typeof costWindowQuery>,
  ) {
    const [legacy, v2] = await Promise.all([
      this.observability.costs(),
      this.costCenter.overview(query.window),
    ]);
    return { ...legacy, ...v2 };
  }

  /**
   * Epic §34 — extend the namespace, never `/costs/<provider>`. Static
   * segments are declared before their parametric siblings; Fastify prefers
   * them anyway, and the order makes that visible.
   */
  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs/providers')
  async opsCostProviders(
    @Query(new ZodValidationPipe(costWindowQuery)) query: z.infer<typeof costWindowQuery>,
  ) {
    return { window: query.window, providers: await this.costCenter.providers(query.window) };
  }

  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs/providers/:providerId')
  async opsCostProvider(
    @Param(new ZodValidationPipe(costProviderParam)) params: z.infer<typeof costProviderParam>,
    @Query(new ZodValidationPipe(costWindowQuery)) query: z.infer<typeof costWindowQuery>,
  ) {
    return {
      window: query.window,
      provider: await this.costCenter.provider(params.providerId, query.window),
    };
  }

  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs/providers/:providerId/services/:serviceId')
  async opsCostService(
    @Param(new ZodValidationPipe(costServiceParam)) params: z.infer<typeof costServiceParam>,
    @Query(new ZodValidationPipe(costWindowQuery)) query: z.infer<typeof costWindowQuery>,
  ) {
    return {
      window: query.window,
      service: await this.costCenter.service(params.providerId, params.serviceId, query.window),
    };
  }

  /** Epic §36 — the test-run report, newest first, for this deployment. */
  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs/test-runs')
  async opsCostTestRuns(
    @Query(new ZodValidationPipe(testRunListQuery)) query: z.infer<typeof testRunListQuery>,
  ) {
    return { testRuns: await this.costCenter.testRuns(query.limit) };
  }

  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs/test-runs/:id')
  async opsCostTestRun(@Param('id', Uuid) id: string) {
    return { testRun: await this.costCenter.testRun(id) };
  }

  /**
   * COST-BE-023 (#382) — epic §27, manual / fixed costs. The list carries
   * `eligibleServices` — the registry's services with `MANUAL_COST` — so the
   * form's provider/service picker is the registry, not a list in the CMS.
   * Every write is audited (`cost.manual_item.*`) and rebuilds the item's
   * MANUAL rows before it returns; `Idempotency-Key` replays a create.
   */
  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs/manual-items')
  opsManualCostItems() {
    return this.costCenter.manualItems();
  }

  @RequireRole('ops_admin', 'super_admin')
  @Post('ops/costs/manual-items')
  async opsCreateManualCostItem(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(manualCostItemCreate))
    body: z.infer<typeof manualCostItemCreate>,
  ) {
    return { item: await this.costCenter.createManualItem(body, { adminId: actor.id }) };
  }

  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/costs/manual-items/:id')
  async opsManualCostItem(@Param('id', Uuid) id: string) {
    return { item: await this.costCenter.manualItem(id) };
  }

  @RequireRole('ops_admin', 'super_admin')
  @Patch('ops/costs/manual-items/:id')
  async opsUpdateManualCostItem(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(manualCostItemPatch)) body: z.infer<typeof manualCostItemPatch>,
  ) {
    return { item: await this.costCenter.updateManualItem(id, body, { adminId: actor.id }) };
  }

  @RequireRole('ops_admin', 'super_admin')
  @Delete('ops/costs/manual-items/:id')
  async opsDeleteManualCostItem(@CurrentActor() actor: Actor, @Param('id', Uuid) id: string) {
    await this.costCenter.removeManualItem(id, { adminId: actor.id });
    return { deleted: true };
  }

  /**
   * BE-CMS-P2 (#315) — the monitoring view, from the time-series store.
   *
   * `/v1/metrics` is a machine surface: one shared token granting read of
   * every internal series, no per-user authorization, no audit of who looked
   * at what, and a text format with no version. The console reads these
   * instead, and GoGo-BE is the only thing that ever holds a Grafana
   * credential.
   *
   * `window` is an enum, not a duration and not a range. There is no
   * client-supplied PromQL anywhere in this path — every query is a constant
   * in `domain/ops-metrics.ts` parameterised by that enum and this
   * deployment's own `env` label — so the answer to "can a caller inject a
   * query" is that there is no hole to inject into.
   *
   * `ops_admin` and above, like the three endpoints above it. Provider spend
   * and infrastructure health are not editorial data.
   */
  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/summary')
  opsSummary(@Query(new ZodValidationPipe(opsWindowQuery)) query: z.infer<typeof opsWindowQuery>) {
    return this.opsMetrics.summary(query.window);
  }

  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/providers')
  opsProviders(
    @Query(new ZodValidationPipe(opsWindowQuery)) query: z.infer<typeof opsWindowQuery>,
  ) {
    return this.opsMetrics.providers(query.window);
  }

  @RequireRole('ops_admin', 'super_admin')
  @Get('ops/providers/:provider')
  opsProvider(
    @Param(new ZodValidationPipe(opsProviderParam)) params: z.infer<typeof opsProviderParam>,
    @Query(new ZodValidationPipe(opsWindowQuery)) query: z.infer<typeof opsWindowQuery>,
  ) {
    return this.opsMetrics.provider(params.provider, query.window);
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
