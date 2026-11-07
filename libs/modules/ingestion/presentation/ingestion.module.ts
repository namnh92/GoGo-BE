import { SubmissionDisplayService } from '../application/submission-display.service';
import { SearchModule } from '../../search/presentation/search.module';
import { SubmissionPhotoService } from '../application/submission-photo.service';
import { ProfileModule } from '../../profile/presentation/profile.module';
import { SubmissionPhotosService } from '../application/submission-photos.service';
import {
  SubmissionPhotoController,
  CommunityPhotoController,
} from './submission-photos.controller';
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
import {
  CmsSubmissionController,
  IngestionController,
  MyPlaceSubmissionsController,
} from './ingestion.controller';
import { MyPlaceSubmissionsService } from '../application/my-place-submissions.service';
import { PlaceImportController } from './place-import.controller';

@Module({
  imports: [IdentityModule, AdministrativeModule, SearchModule, ProfileModule],
  controllers: [
    IngestionController,
    CmsSubmissionController,
    MyPlaceSubmissionsController,
    PlaceImportController,
    SubmissionPhotoController,
    CommunityPhotoController,
  ],
  providers: [
    SubmissionPhotoService,
    SubmissionPhotosService,
    MyPlaceSubmissionsService,
    SubmissionDisplayService,
    PlaceResolverService,
    PlaceDedupService,
    PlaceSubmissionService,
    PlaceImportJobService,
  ],
  exports: [PlaceResolverService, PlaceDedupService, PlaceSubmissionService, PlaceImportJobService],
})
export class IngestionModule {}
