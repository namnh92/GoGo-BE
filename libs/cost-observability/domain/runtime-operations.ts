import type { RuntimeOperation } from '@gogo/observability';

/**
 * #414 — the operations this process performs against infrastructure
 * providers, named once here and used twice: the registry declares them
 * (`instrumented: true`, so `/monitoring` reads FULL) and the adapters label
 * `provider_requests_total` with them. One constant for both is what keeps a
 * row on the console and a series in Prometheus pointing at the same thing —
 * the Google adapters carry their `method` literals separately, and the
 * registry spec is what stops those drifting.
 *
 * An operation is a unit of work the caller asked for, not a Redis command:
 * a rate-limit hit is INCR (+ EXPIRE on the first hit) and is one operation,
 * because "how long does a rate-limit check take" is the question — the
 * command count is Upstash's meter, read by its collector (epic §8).
 */
const UPSTASH = { provider: 'upstash', service: 'upstash.redis' } as const;

export const UPSTASH_REDIS_OPERATIONS = {
  /** `RedisRateLimitStore.hit` — INCR, then EXPIRE on the window's first hit. */
  rateLimitHit: { ...UPSTASH, operation: 'upstash.redis.rate_limit.hit' },
  /** `RedisRevocationStore.revoke` — SET EX. */
  sessionRevoke: { ...UPSTASH, operation: 'upstash.redis.session.revoke' },
  /** `RedisRevocationStore.isRevoked` — GET, behind the in-process cache. */
  sessionIsRevoked: { ...UPSTASH, operation: 'upstash.redis.session.is_revoked' },
  /** `RedisRoomEventBus.publish` — INCR, EXPIRE, ZADD, ZREMRANGEBYRANK, EXPIRE, PUBLISH. */
  roomEventsPublish: { ...UPSTASH, operation: 'upstash.redis.room_events.publish' },
  /** `RedisRoomEventBus.subscribe` — the replay ZRANGEBYSCORE and the channel SUBSCRIBE. */
  roomEventsSubscribe: { ...UPSTASH, operation: 'upstash.redis.room_events.subscribe' },
} as const satisfies Record<string, RuntimeOperation>;

const NEON = { provider: 'neon', service: 'neon.postgres' } as const;

export const NEON_POSTGRES_OPERATIONS = {
  /**
   * Every statement the pool runs, Drizzle's and raw alike, timed from the
   * checked-out client — pool wait is not in it. One operation on purpose:
   * the SQL text is the one thing that must never be a label.
   */
  query: { ...NEON, operation: 'neon.postgres.query' },
} as const satisfies Record<string, RuntimeOperation>;

/** Every infrastructure operation this process declares, for the registry and its spec. */
export const RUNTIME_OPERATIONS: readonly RuntimeOperation[] = [
  ...Object.values(UPSTASH_REDIS_OPERATIONS),
  ...Object.values(NEON_POSTGRES_OPERATIONS),
];
