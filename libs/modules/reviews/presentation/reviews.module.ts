import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { UserContentService } from '../application/user-content.service';
import { UserContentController } from './user-content.controller';

@Module({
  imports: [IdentityModule],
  controllers: [UserContentController],
  providers: [UserContentService],
  exports: [UserContentService],
})
export class ReviewsModule {}
