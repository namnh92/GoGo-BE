import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { APP_CONFIG } from '../../shared/config';
import { RoomEventsService } from '../application/room-events.service';
import { RoomEventsController } from './room-events.controller';
import { RoomMemberGuard } from './room-member.guard';
import { REALTIME_ENABLED } from './realtime.tokens';

type RealtimeConfig = { REALTIME_SSE_ENABLED?: boolean };

/**
 * The endpoint half. Separate from `RealtimeBusModule` on purpose: the bus is
 * global so publishers can reach it, while this imports RoomsModule for the
 * membership policy — folding the two together would make the global module
 * depend on a module that depends on it.
 */
@Module({
  imports: [IdentityModule, RoomsModule],
  controllers: [RoomEventsController],
  providers: [
    RoomEventsService,
    RoomMemberGuard,
    {
      provide: REALTIME_ENABLED,
      useFactory: (config: RealtimeConfig) => config.REALTIME_SSE_ENABLED !== false,
      inject: [APP_CONFIG],
    },
  ],
})
export class RoomEventsModule {}
