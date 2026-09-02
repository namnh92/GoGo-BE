import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PlaceDedupService } from '../application/place-dedup.service';
import { PlaceImportJobService } from '../application/place-import-job.service';
import { PlaceResolverService } from '../application/place-resolver.service';
import { PlaceSubmissionService } from '../application/place-submission.service';
import { ProviderContentService } from '../application/provider-content.service';
import { CmsSubmissionController, IngestionController } from './ingestion.controller';
import { PlaceImportController } from './place-import.controller';

@Module({
  imports: [IdentityModule],
  controllers: [IngestionController, CmsSubmissionController, PlaceImportController],
  providers: [
    PlaceResolverService,
    PlaceDedupService,
    PlaceSubmissionService,
    PlaceImportJobService,
    // #341 — the one door for rich Google content that is not persisted.
    ProviderContentService,
  ],
  exports: [
    PlaceResolverService,
    PlaceDedupService,
    PlaceSubmissionService,
    PlaceImportJobService,
    ProviderContentService,
  ],
})
export class IngestionModule {}
