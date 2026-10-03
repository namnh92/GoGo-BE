import { Global, Module } from '@nestjs/common';
import IORedis from 'ioredis';
import { NoopMetrics, RUNTIME_METRICS, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG } from '../../shared/config';
import { ROOM_EVENT_BUS } from '../application/room-event-bus';
import { InMemoryRoomEventBus } from '../infrastructure/in-memory-room-event-bus';
import { RedisRoomEventBus } from '../infrastructure/redis-room-event-bus';

type RealtimeConfig = { NODE_ENV: string; REDIS_URL?: string };

/*
 * ADR-0027 D5. Exported so the Redis test suites build their buses with
 * exactly these options. A publication is never resent or queued for later —
 * an ambiguous result must not become a second event — and a dropped
 * subscriber is never silently resubscribed: the bus ends its streams so
 * clients reattach (Pub/Sub does not replay the gap).
 */
export const ROOM_EVENTS_COMMANDS_OPTIONS = {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
} as const;

export const ROOM_EVENTS_SUBSCRIBER_OPTIONS = {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  autoResubscribe: false,
  autoResendUnfulfilledCommands: false,
} as const;

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
      useFactory: (config: RealtimeConfig, metrics?: MetricsPort) => {
        if (!config.REDIS_URL || config.NODE_ENV === 'test') return new InMemoryRoomEventBus();
        // Two connections: ioredis refuses ordinary commands on a connection
        // that is in subscriber mode, and publishing needs both.
        const commands = new IORedis(config.REDIS_URL, ROOM_EVENTS_COMMANDS_OPTIONS);
        const subscriber = new IORedis(config.REDIS_URL, ROOM_EVENTS_SUBSCRIBER_OPTIONS);
        commands.on('error', () => undefined);
        subscriber.on('error', () => undefined);
        return new RedisRoomEventBus(commands, subscriber, metrics ?? new NoopMetrics());
      },
      // #414 — optional: the registry sink exists in the API, not in every test module.
      inject: [APP_CONFIG, { token: RUNTIME_METRICS, optional: true }],
    },
  ],
  exports: [ROOM_EVENT_BUS],
})
export class RealtimeBusModule {}
