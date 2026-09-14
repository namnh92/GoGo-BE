import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { ProfileModule } from '../../profile/presentation/profile.module';
import { PlaceReviewsService } from '../application/place-reviews.service';
import { UserContentService } from '../application/user-content.service';
import { PlaceReviewsController } from './place-reviews.controller';
import { UserContentController } from './user-content.controller';

@Module({
  imports: [IdentityModule, ProfileModule],
  controllers: [UserContentController, PlaceReviewsController],
  providers: [UserContentService, PlaceReviewsService],
  exports: [UserContentService],
})
export class ReviewsModule {}
