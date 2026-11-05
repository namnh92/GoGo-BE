import { UPSTASH_REDIS_OPERATIONS } from '@gogo/cost-observability';
import { meterRuntimeCall, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type {
  RoutingReservation,
  RoutingReservationRequest,
  RoutingReservationResult,
} from '../application/routing-reservation';

export type RoutingRedis = {
  eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArguments: (string | number)[]
  ): Promise<unknown>;
};

/**
 * Check both ceilings and increment both counters as one Redis operation.
 * A refused reservation changes neither counter, so one exhausted scope
 * cannot consume the other scope's remaining capacity.
 */
const RESERVE_SCRIPT = `
local room_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local actor_count = tonumber(redis.call('GET', KEYS[2]) or '0')
local room_exhausted = room_count >= tonumber(ARGV[1])
local actor_exhausted = actor_count >= tonumber(ARGV[2])

if room_exhausted or actor_exhausted then
  return {0, room_exhausted and 1 or 0, actor_exhausted and 1 or 0}
end

room_count = redis.call('INCR', KEYS[1])
if room_count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
actor_count = redis.call('INCR', KEYS[2])
if actor_count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return {1, 0, 0}
`;

/** Leave most of the request budget for Routes; Redis admission is optional enrichment. */
export const ROUTING_RESERVATION_DEADLINE_MS = 500;

export type RedisRoutingReservationOptions = {
  deadlineMs?: number;
};

/** Shared across replicas when Redis is healthy; explicitly unavailable otherwise. */
export class RedisRoutingReservation implements RoutingReservation {
  constructor(
    private readonly redis: RoutingRedis | null,
    private readonly metrics: MetricsPort = new NoopMetrics(),
    private readonly options: RedisRoutingReservationOptions = {},
  ) {}

  async reserve(request: RoutingReservationRequest): Promise<RoutingReservationResult> {
    const redis = this.redis;
    if (!redis) return { ok: false, reason: 'unavailable' };

    let timer: NodeJS.Timeout | undefined;
    try {
      const admission = redis.eval(
        RESERVE_SCRIPT,
        2,
        `routing:suggestion:room:${request.roomId}`,
        `routing:suggestion:actor:${request.actorKey}`,
        request.perRoom,
        request.perActor,
        request.windowSeconds,
      );
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Routing reservation exceeded its deadline')),
          this.options.deadlineMs ?? ROUTING_RESERVATION_DEADLINE_MS,
        );
        timer.unref?.();
      });
      // EVAL cannot be cancelled safely: it may already have incremented the
      // counters. The settled race ignores a late reply, so it cannot authorise Routes.
      const result = await meterRuntimeCall(
        this.metrics,
        UPSTASH_REDIS_OPERATIONS.rateLimitHit,
        () => Promise.race([admission, deadline]),
      );
      if (!Array.isArray(result) || result.length < 3) {
        return { ok: false, reason: 'unavailable' };
      }
      if (Number(result[0]) === 1) return { ok: true };

      const roomExhausted = Number(result[1]) === 1;
      const actorExhausted = Number(result[2]) === 1;
      if (roomExhausted && actorExhausted) return { ok: false, reason: 'both' };
      if (roomExhausted) return { ok: false, reason: 'room' };
      if (actorExhausted) return { ok: false, reason: 'actor' };
      return { ok: false, reason: 'unavailable' };
    } catch {
      // Cost admission fails closed: the request still succeeds on estimates.
      return { ok: false, reason: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
}
