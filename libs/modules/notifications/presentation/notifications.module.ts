import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PushIdentityService } from '../application/push-identity.service';
import { PushSubscriptionsService } from '../application/push-subscriptions.service';
import { NotificationsController } from './notifications.controller';
import { PushIdentityController } from './push-identity.controller';

@Module({
  imports: [IdentityModule],
  controllers: [NotificationsController, PushIdentityController],
  providers: [PushIdentityService, PushSubscriptionsService],
  exports: [PushIdentityService, PushSubscriptionsService],
})
export class NotificationsModule {}
