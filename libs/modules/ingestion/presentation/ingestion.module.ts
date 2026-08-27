import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PlaceDedupService } from '../application/place-dedup.service';
import { PlaceResolverService } from '../application/place-resolver.service';
import { PlaceSubmissionService } from '../application/place-submission.service';
import { CmsSubmissionController, IngestionController } from './ingestion.controller';

@Module({
  imports: [IdentityModule],
  controllers: [IngestionController, CmsSubmissionController],
  providers: [PlaceResolverService, PlaceDedupService, PlaceSubmissionService],
  exports: [PlaceResolverService, PlaceDedupService, PlaceSubmissionService],
})
export class IngestionModule {}
