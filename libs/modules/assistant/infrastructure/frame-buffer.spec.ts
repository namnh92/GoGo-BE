import { describe, expect, it } from 'vitest';
import type { AssistantFrame } from '../domain/assistant.types';
import { RedisFrameBuffer, contiguousAfter, type FrameRedis } from './frame-buffer';

/** A Redis list whose pushes can be made to fail, like a dropped connection. */
function fakeRedis() {
  const lists = new Map<string, string[]>();
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

  it('drop removes the frames (A-R-08)', async () => {
    const { redis } = fakeRedis();
    const buffer = new RedisFrameBuffer(redis);
    await buffer.append('m', [delta(1)]);
    await buffer.drop('m');
    expect(await buffer.read('m', 0)).toEqual([]);
  });
});
