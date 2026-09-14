import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { ProfileModule } from '../../profile/presentation/profile.module';
import { PlaceReviewsService } from '../application/place-reviews.service';
import { ReviewReactionsService } from '../application/review-reactions.service';
import { UserContentService } from '../application/user-content.service';
import { PlaceReviewsController } from './place-reviews.controller';
import { ReviewReactionsController } from './review-reactions.controller';
import { UserContentController } from './user-content.controller';

@Module({
  imports: [IdentityModule, ProfileModule],
  controllers: [UserContentController, PlaceReviewsController, ReviewReactionsController],
  providers: [UserContentService, PlaceReviewsService, ReviewReactionsService],
  exports: [UserContentService],
})
export class ReviewsModule {}
