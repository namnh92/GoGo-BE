import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
// ADM-017 — both import doors classify their geometry through the one resolver:
// the bulk job when it creates a place, and `resolveLink` when it previews one.
// Administrative depends only on Identity, so the import is one-way.
import { AdministrativeModule } from '../../administrative/presentation/administrative.module';
import { PlaceDedupService } from '../application/place-dedup.service';
import { PlaceImportJobService } from '../application/place-import-job.service';
import { PlaceResolverService } from '../application/place-resolver.service';
import { PlaceSubmissionService } from '../application/place-submission.service';
import { CmsSubmissionController, IngestionController } from './ingestion.controller';
import { PlaceImportController } from './place-import.controller';

@Module({
  imports: [IdentityModule, AdministrativeModule],
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
