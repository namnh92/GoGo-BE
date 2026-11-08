import { NotificationInboxService } from '../application/notification-inbox.service';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PushIdentityService } from '../application/push-identity.service';
import { PushDeviceIdentityService } from '../application/push-device-identity.service';
import { PushSubscriptionsService } from '../application/push-subscriptions.service';
import { NotificationsController } from './notifications.controller';
import { PushDeviceController } from './push-device.controller';
import { PushIdentityController } from './push-identity.controller';

@Module({
  imports: [IdentityModule],
  controllers: [NotificationsController, PushIdentityController, PushDeviceController],
  providers: [
    NotificationInboxService,
    PushIdentityService,
    PushSubscriptionsService,
    PushDeviceIdentityService,
  ],
  exports: [PushIdentityService, PushSubscriptionsService, PushDeviceIdentityService],
})
export class NotificationsModule {}
