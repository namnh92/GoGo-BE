import { MetricsRegistry } from '@gogo/observability';
import { describe, expect, it } from 'vitest';
import type { PublishInput } from '../domain/room-event';
import { RedisRoomEventBus, type RedisPubSubLike } from './redis-room-event-bus';

function fakeRedis(): RedisPubSubLike & { published: string[]; subscribed: string[] } {
  let seq = 0;
  const buffer: string[] = [];
  const published: string[] = [];
  const subscribed: string[] = [];
  return {
    published,
    subscribed,
    async incr() {
      seq += 1;
      return seq;
    },
    async publish(_channel, message) {
      published.push(message);
      return 1;
    },
    async zadd(_key, _score, member) {
      buffer.push(member);
    },
    async zremrangebyrank() {},
    async zrangebyscore() {
      return buffer;
    },
    async expire() {},
    async subscribe(channel) {
      subscribed.push(channel);
    },
    async unsubscribe() {},
    on() {},
    off() {},
  };
}

const input: PublishInput = {
  roomId: 'room-1',
  type: 'room.status_changed',
  actorId: 'u1',
  payload: { status: 'matching' },
};

describe('RedisRoomEventBus runtime telemetry (#414)', () => {
  it('publish is one ok call however many commands it issued', async () => {
    const registry = new MetricsRegistry();
    const commands = fakeRedis();
    const bus = new RedisRoomEventBus(commands, fakeRedis(), registry);
    const out = await bus.publish(input);
    expect(out.seq).toBe(1);
    expect(commands.published).toHaveLength(1);
    expect(registry.render()).toContain(
      'provider_requests_total{operation="upstash.redis.room_events.publish",provider="upstash",service="upstash.redis",status="ok"} 1',
    );
    expect(registry.render()).not.toContain('room-1');
  });

  it('subscribe is one ok call covering the replay read and the SUBSCRIBE', async () => {
    const registry = new MetricsRegistry();
    const commands = fakeRedis();
    const subscriber = fakeRedis();
    const bus = new RedisRoomEventBus(commands, subscriber, registry);
    await bus.publish(input);
    const sub = await bus.subscribe('room-1', 0, () => undefined);
    expect(sub.replay).toHaveLength(1);
    expect(subscriber.subscribed).toEqual(['room:room-1:events']);
    expect(registry.render()).toContain(
      'provider_requests_total{operation="upstash.redis.room_events.subscribe",provider="upstash",service="upstash.redis",status="ok"} 1',
    );
    sub.unsubscribe();
  });

  it('a failed publish is recorded as error and rethrown', async () => {
    const registry = new MetricsRegistry();
    const commands = fakeRedis();
    commands.incr = () => Promise.reject(new Error('READONLY'));
    const bus = new RedisRoomEventBus(commands, fakeRedis(), registry);
    await expect(bus.publish(input)).rejects.toThrow('READONLY');
    expect(registry.render()).toContain('operation="upstash.redis.room_events.publish"');
    expect(registry.render()).toContain('status="error"} 1');
  });
});
