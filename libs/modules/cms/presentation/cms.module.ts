import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { SuggestionsModule } from '../../suggestions/presentation/suggestions.module';
// #246 — the console reuses the consumer erase/export rather than growing a
// second implementation of them.
import { ReviewsModule } from '../../reviews/presentation/reviews.module';
import { AdminAuthService } from '../application/admin-auth.service';
import { CloudflareAccessService } from '../application/cf-access.service';
import { CmsAuditService } from '../application/cms-audit.service';
import { CmsCatalogService } from '../application/cms-catalog.service';
import { CmsContentService } from '../application/cms-content.service';
import { CmsUploadsService } from '../application/cms-uploads.service';
import { BannersService } from '../application/banners.service';
import { CampaignsService } from '../../notifications/application/campaigns.service';
import { SafetyRulesService } from '../application/safety-rules.service';
import { RecommendationsService } from '../application/recommendations.service';
import { PlanTemplatesService } from '../application/plan-templates.service';
import { CmsOpsService } from '../application/cms-ops.service';
import { CmsObservabilityService } from '../application/cms-observability.service';
import { CmsOpsMetricsService } from '../application/cms-ops-metrics.service';
import { CmsUsersService } from '../application/cms-users.service';
import { PrivacyRequestsService } from '../application/privacy-requests.service';
import { ModerationQueueService } from '../application/moderation-queue.service';
import { EmergencyTakedownService } from '../application/emergency-takedown.service';
import { ExperimentsAdminService } from '../application/experiments-admin.service';
import { RankingEvaluationService } from '../application/ranking-evaluation.service';
import { SearchAnalyticsService } from '../application/search-analytics.service';
import { AdminGuard } from './admin.guard';
import { EmergencyController } from './emergency.controller';
import {
  CmsAuditController,
  CmsAuthController,
  CmsBannersController,
  CmsCampaignsController,
  CmsCatalogController,
  CmsContentController,
  CmsModerationController,
  CmsOpsController,
  CmsPlanTemplatesController,
  CmsRecommendationsController,
  CmsSafetyRulesController,
  CmsUploadsController,
  CmsUsersController,
  PrivacyRequestsController,
} from './cms.controllers';

@Module({
  imports: [IdentityModule, SuggestionsModule, ReviewsModule],
  controllers: [
    CmsAuditController,
    CmsAuthController,
    CmsBannersController,
    CmsCampaignsController,
    CmsCatalogController,
    CmsContentController,
    CmsModerationController,
    CmsOpsController,
    CmsPlanTemplatesController,
    CmsRecommendationsController,
    CmsSafetyRulesController,
    CmsUploadsController,
    CmsUsersController,
    PrivacyRequestsController,
    EmergencyController,
  ],
  providers: [
    AdminAuthService,
    CloudflareAccessService,
    CmsAuditService,
    CmsCatalogService,
    CmsContentService,
    CmsUploadsService,
    CmsObservabilityService,
    CmsOpsMetricsService,
    CmsUsersService,
    PrivacyRequestsService,
    BannersService,
    CampaignsService,
    SafetyRulesService,
    RecommendationsService,
    PlanTemplatesService,
    CmsOpsService,
    ModerationQueueService,
    EmergencyTakedownService,
    SearchAnalyticsService,
    RankingEvaluationService,
    ExperimentsAdminService,
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
})
export class CmsModule {}
