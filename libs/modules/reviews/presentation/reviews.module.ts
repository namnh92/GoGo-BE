import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { ProfileModule } from '../../profile/presentation/profile.module';
import { PlaceReportsService } from '../application/place-reports.service';
import { PlaceReviewsService } from '../application/place-reviews.service';
import { ReviewReactionsService } from '../application/review-reactions.service';
import { UserContentService } from '../application/user-content.service';
import { PlaceReportsController } from './place-reports.controller';
import { PlaceReviewsController } from './place-reviews.controller';
import { ReviewReactionsController } from './review-reactions.controller';
import { UserContentController } from './user-content.controller';

@Module({
  imports: [IdentityModule, ProfileModule],
  controllers: [
    UserContentController,
    PlaceReviewsController,
    ReviewReactionsController,
    PlaceReportsController,
  ],
  providers: [UserContentService, PlaceReviewsService, ReviewReactionsService, PlaceReportsService],
  exports: [UserContentService],
})
export class ReviewsModule {}
