import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PlaceDedupService } from '../application/place-dedup.service';
import { PlaceImportJobService } from '../application/place-import-job.service';
import { PlaceResolverService } from '../application/place-resolver.service';
import { PlaceSubmissionService } from '../application/place-submission.service';
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
  ],
  exports: [PlaceResolverService, PlaceDedupService, PlaceSubmissionService, PlaceImportJobService],
})
export class IngestionModule {}
