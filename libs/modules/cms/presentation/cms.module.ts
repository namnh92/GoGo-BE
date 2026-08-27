import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { AdminAuthService } from '../application/admin-auth.service';
import { CmsCatalogService } from '../application/cms-catalog.service';
import { CmsContentService } from '../application/cms-content.service';
import { CmsOpsService } from '../application/cms-ops.service';
import { EmergencyTakedownService } from '../application/emergency-takedown.service';
import { AdminGuard } from './admin.guard';
import { EmergencyController } from './emergency.controller';
import {
  CmsAuthController,
  CmsCatalogController,
  CmsContentController,
  CmsModerationController,
  CmsOpsController,
} from './cms.controllers';

@Module({
  imports: [IdentityModule],
  controllers: [
    CmsAuthController,
    CmsCatalogController,
    CmsContentController,
    CmsModerationController,
    CmsOpsController,
    EmergencyController,
  ],
  providers: [
    AdminAuthService,
    CmsCatalogService,
    CmsContentService,
    CmsOpsService,
    EmergencyTakedownService,
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
})
export class CmsModule {}
