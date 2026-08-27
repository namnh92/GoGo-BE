import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [IdentityModule],
  controllers: [NotificationsController],
})
export class NotificationsModule {}
