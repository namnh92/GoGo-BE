import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { SuggestionsModule } from '../../suggestions/presentation/suggestions.module';
import { AdminAuthService } from '../application/admin-auth.service';
import { CmsAuditService } from '../application/cms-audit.service';
import { CmsCatalogService } from '../application/cms-catalog.service';
import { CmsContentService } from '../application/cms-content.service';
import { CmsOpsService } from '../application/cms-ops.service';
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
  CmsCatalogController,
  CmsContentController,
  CmsModerationController,
  CmsOpsController,
} from './cms.controllers';

@Module({
  imports: [IdentityModule, SuggestionsModule],
  controllers: [
    CmsAuditController,
    CmsAuthController,
    CmsCatalogController,
    CmsContentController,
    CmsModerationController,
    CmsOpsController,
    EmergencyController,
  ],
  providers: [
    AdminAuthService,
    CmsAuditService,
    CmsCatalogService,
    CmsContentService,
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
