import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { ShareLinksService } from '../application/share-links.service';
import { ShareLinksRepository } from '../infrastructure/share-links.repository';
import { ShareLinksController } from './share-links.controller';

@Module({
  imports: [IdentityModule, RoomsModule],
  controllers: [ShareLinksController],
  providers: [ShareLinksRepository, ShareLinksService],
  exports: [ShareLinksService],
})
export class ShareLinksModule {}
