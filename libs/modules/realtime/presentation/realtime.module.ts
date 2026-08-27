import { Global, Module } from '@nestjs/common';
import IORedis from 'ioredis';
import { APP_CONFIG } from '../../shared/config';
import { ROOM_EVENT_BUS } from '../application/room-event-bus';
import { InMemoryRoomEventBus } from '../infrastructure/in-memory-room-event-bus';
import { RedisRoomEventBus } from '../infrastructure/redis-room-event-bus';

type RealtimeConfig = { NODE_ENV: string; REDIS_URL?: string };

/**
 * Global so any module can publish room events without importing realtime —
 * rooms, preferences, suggestions and plans all emit, and wiring those as
 * imports would close a dependency cycle (the same one that crashed the app
 * at boot when travel-time briefly lived inside suggestions).
 */
@Global()
@Module({
  providers: [
    {
      provide: ROOM_EVENT_BUS,
      useFactory: (config: RealtimeConfig) => {
        if (!config.REDIS_URL || config.NODE_ENV === 'test') return new InMemoryRoomEventBus();
        // Two connections: ioredis refuses ordinary commands on a connection
        // that is in subscriber mode, and publishing needs both.
        const options = { lazyConnect: true, maxRetriesPerRequest: 1 } as const;
        const commands = new IORedis(config.REDIS_URL, options);
        const subscriber = new IORedis(config.REDIS_URL, options);
        commands.on('error', () => undefined);
        subscriber.on('error', () => undefined);
        return new RedisRoomEventBus(commands, subscriber);
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [ROOM_EVENT_BUS],
})
export class RealtimeBusModule {}
