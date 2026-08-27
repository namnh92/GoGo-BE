import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { RoomsService } from '../application/rooms.service';
import { RoomsRepository } from '../infrastructure/rooms.repository';
import { RoomPolicy } from './room-policy';
import { RoomsController } from './rooms.controller';

@Module({
  imports: [IdentityModule],
  controllers: [RoomsController],
  providers: [RoomPolicy, RoomsRepository, RoomsService],
  exports: [RoomPolicy, RoomsRepository, RoomsService],
})
export class RoomsModule {}
