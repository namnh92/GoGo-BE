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
import { CmsOpsService } from '../application/cms-ops.service';
import { RequireRole } from './admin.guard';

const Uuid = new ZodValidationPipe(z.string().uuid());

// ---------------------------------------------------------------- auth

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
  totp: z.string().length(6).optional(),
});
const totpSetupSchema = z.object({ password: z.string().min(1).max(128) });
const createAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(50),
  role: z.enum(['editor', 'moderator', 'ops_admin', 'super_admin']),
});

@Controller('cms/auth')
export class CmsAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Public()
  @RateLimit({ action: 'cms.login', limit: 5, windowSeconds: 60, keyBy: 'ip' })
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body);
  }

  @RequireRole('editor', 'moderator', 'ops_admin')
  @Post('totp/setup')
  setupTotp(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(totpSetupSchema)) body: { password: string },
  ) {
    return this.auth.setupTotp(actor.id, body.password);
  }

  @RequireRole('super_admin')
  @Post('admins')
  createAdmin(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createAdminSchema)) body: z.infer<typeof createAdminSchema>,
  ) {
    return this.auth.createAdmin({ ...body, createdBy: actor.id });
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

@RequireRole('moderator')
@Controller('cms/moderation')
export class CmsModerationController {
  constructor(private readonly ops: CmsOpsService) {}

  @Get()
  queue(@Query('limit') limit?: string) {
    return this.ops.moderationQueue(Math.min(Number(limit) || 50, 200));
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
const flagSchema = z.object({
  enabled: z.boolean(),
  payload: z.unknown().optional(),
});

@RequireRole('ops_admin')
@Controller('cms')
export class CmsOpsController {
  constructor(private readonly ops: CmsOpsService) {}

  @Post('ranking-configs')
  createRanking(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(rankingCreateSchema)) body: z.infer<typeof rankingCreateSchema>,
  ) {
    return this.ops.createRankingConfig(actor.id, body);
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

  @Put('feature-flags/:key')
  setFlag(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(flagSchema)) body: { enabled: boolean; payload?: unknown },
  ) {
    return this.ops.setFeatureFlag(actor.id, key, body.enabled, body.payload);
  }

  @Get('ops/kpis')
  kpis() {
    return this.ops.kpis();
  }
}
