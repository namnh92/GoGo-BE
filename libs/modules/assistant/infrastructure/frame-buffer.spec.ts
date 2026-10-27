import { describe, expect, it } from 'vitest';
import type { AssistantFrame } from '../domain/assistant.types';
import {
  InMemoryFrameBuffer,
  RedisFrameBuffer,
  contiguousAfter,
  type FrameRedis,
} from './frame-buffer';

/** A Redis list whose pushes can be made to fail, like a dropped connection. */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const gone = new Set<string>();
  let failNext = false;
  const redis: FrameRedis = {
    rpush: async (key, ...values) => {
      if (failNext) {
        failNext = false;
        throw new Error('ECONNRESET');
      }
      const list = lists.get(key) ?? [];
      list.push(...values);
      lists.set(key, list);
      return list.length;
    },
    expire: async () => 1,
    lrange: async (key, start, stop) => {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop === -1 ? undefined : stop + 1);
    },
    set: async () => 'OK',
    exists: async () => 0,
    del: async (...keys) => {
      let n = 0;
      for (const k of keys) if (lists.delete(k)) n += 1;
      return n;
    },
    // The two scripts' semantics; the scripts themselves run against a real
    // Redis in apps/api/test/assistant-frame-buffer-redis.int.spec.ts.
    eval: async (_script, numKeys, ...args) => {
      const keys = args.slice(0, numKeys).map(String);
      const argv = args.slice(numKeys).map(String);
      if (numKeys === 3) {
        gone.add(keys[2]!);
        lists.delete(keys[0]!);
        return 1;
      }
      if (gone.has(keys[1]!)) return -1;
      return redis.rpush(keys[0]!, ...argv.slice(1));
    },
  };
  return { redis, failNextPush: () => (failNext = true) };
}

const delta = (seq: number): AssistantFrame => ({
  type: 'delta',
  seq,
  messageId: 'm',
  text: `t${seq}`,
});

describe('frame buffer (A-R-10: replay after a failed append)', () => {
  it('reads by each frame’s seq, not by list position, after a lost append', async () => {
    const { redis, failNextPush } = fakeRedis();
    const buffer = new RedisFrameBuffer(redis);
    await buffer.append('m', [delta(1)]);
    failNextPush();
    await buffer.append('m', [delta(2)]).catch(() => undefined);
    await buffer.append('m', [delta(3)]);
    await buffer.append('m', [delta(4)]);
    // Position 2 now holds seq 4: an offset read after seq 2 would skip seq 3.
    expect((await buffer.read('m', 2)).map((f) => f.seq)).toEqual([3, 4]);
    expect((await buffer.read('m', 0)).map((f) => f.seq)).toEqual([1, 3, 4]);
  });

  it('a reader never advances past a hole', async () => {
    const frames = [delta(1), delta(3), delta(4)];
    expect(contiguousAfter(frames, 0).map((f) => f.seq)).toEqual([1]);
    expect(contiguousAfter(frames, 1)).toEqual([]);
    expect(contiguousAfter(frames, 2).map((f) => f.seq)).toEqual([3, 4]);
  });

  it('drop removes the frames, and a late append cannot bring them back (A-R-08, A-R3-04)', async () => {
    const { redis } = fakeRedis();
    const buffer = new RedisFrameBuffer(redis);
    await buffer.append('m', [delta(1)]);
    await buffer.drop('m');
    expect(await buffer.read('m', 0)).toEqual([]);
    await buffer.append('m', [delta(2)]);
    expect(await buffer.read('m', 0)).toEqual([]);
  });

  it('the in-memory buffer refuses a late append after a drop too (A-R3-04)', async () => {
    const buffer = new InMemoryFrameBuffer();
    await buffer.append('m', [delta(1)]);
    await buffer.drop('m');
    await buffer.append('m', [delta(2)]);
    expect(await buffer.read('m', 0)).toEqual([]);
  });
});
