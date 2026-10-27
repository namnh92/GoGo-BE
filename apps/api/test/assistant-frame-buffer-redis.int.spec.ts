import IORedis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantFrame } from '../../../libs/modules/assistant/domain/assistant.types';
import {
  FRAME_TTL_SECONDS,
  RedisFrameBuffer,
  type FrameRedis,
} from '../../../libs/modules/assistant/infrastructure/frame-buffer';

/** An expiry far in the future: the write is not late. */
const FAR = Date.now() + 3_600_000;

/**
 * GoGo-BE#717 — the assistant's live frame buffer against a real Redis: the
 * two Lua scripts (append unless tombstoned, drop with tombstone), reads by
 * seq after a lost append, and the TTL. Nothing here touches the DEV stack.
 */
let redis: StartedTestContainer;
let client: IORedis;

beforeAll(async () => {
  redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  client = new IORedis(`redis://${redis.getHost()}:${redis.getMappedPort(6379)}`, {
    maxRetriesPerRequest: 1,
  });
}, 180_000);

afterAll(async () => {
  client?.disconnect();
  await redis?.stop();
});

const delta = (seq: number, messageId: string): AssistantFrame => ({
  type: 'delta',
  seq,
  messageId,
  text: `t${seq}`,
});

describe('assistant frame buffer on Redis', () => {
  it('first append sets the TTL; frames read back by seq', async () => {
    const buffer = new RedisFrameBuffer(client as unknown as FrameRedis);
    await buffer.append('a', [delta(1, 'a'), delta(2, 'a')], FAR);
    await buffer.append('a', [delta(3, 'a')], FAR);
    expect((await buffer.read('a', 1)).map((f) => f.seq)).toEqual([2, 3]);
    const ttl = await client.ttl('assistant:frames:a');
    expect(ttl).toBeGreaterThan(FRAME_TTL_SECONDS - 10);
  });

  it('A-R-10: a lost append does not shift later reads', async () => {
    let failNext = false;
    const flaky = new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'eval') {
          return async (...args: unknown[]) => {
            if (failNext) {
              failNext = false;
              throw new Error('ECONNRESET');
            }
            return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const buffer = new RedisFrameBuffer(flaky as unknown as FrameRedis);
    await buffer.append('b', [delta(1, 'b')], FAR);
    failNext = true;
    await buffer.append('b', [delta(2, 'b')], FAR).catch(() => undefined);
    await buffer.append('b', [delta(3, 'b')], FAR);
    expect((await buffer.read('b', 2)).map((f) => f.seq)).toEqual([3]);
  });

  it('A-R3-04: after a drop, a late append from a stale runner is refused', async () => {
    const buffer = new RedisFrameBuffer(client as unknown as FrameRedis);
    await buffer.append('c', [delta(1, 'c')], FAR);
    await buffer.drop('c');
    expect(await client.exists('assistant:frames:c')).toBe(0);
    await buffer.append('c', [delta(2, 'c')], FAR);
    expect(await client.exists('assistant:frames:c')).toBe(0);
    expect(await buffer.read('c', 0)).toEqual([]);
    expect(await client.ttl('assistant:gone:c')).toBeGreaterThan(FRAME_TTL_SECONDS);
  });

  it('S2-F-02: a write past its expiry is refused by the server clock', async () => {
    const buffer = new RedisFrameBuffer(client as unknown as FrameRedis);
    await buffer.append('d', [delta(1, 'd')], Date.now() - 1_000);
    expect(await client.exists('assistant:frames:d')).toBe(0);
    await buffer.append('d', [delta(1, 'd')], Date.now() + 60_000);
    expect((await buffer.read('d', 0)).map((f) => f.seq)).toEqual([1]);
  });
});
