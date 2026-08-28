import { describe, expect, it } from 'vitest';
import { assign, bucket, CONTROL } from './assignment';

const half = { treatment: 0.5 };

describe('experiment assignment (SG-010, #49)', () => {
  it('gives the same room the same variant every time', () => {
    const first = assign('ranking.v2', 'room-1', half);
    for (let i = 0; i < 20; i += 1) expect(assign('ranking.v2', 'room-1', half)).toBe(first);
  });

  it('does not correlate two experiments run on the same rooms', () => {
    const rooms = Array.from({ length: 400 }, (_, i) => `room-${i}`);
    const agree = rooms.filter((r) => assign('exp.a', r, half) === assign('exp.b', r, half)).length;
    // Salted per key: without the salt this would be 400.
    expect(agree).toBeGreaterThan(140);
    expect(agree).toBeLessThan(260);
  });

  it('splits roughly according to the configured weight', () => {
    const rooms = Array.from({ length: 2000 }, (_, i) => `room-${i}`);
    const treated = rooms.filter((r) => assign('split', r, { treatment: 0.25 }) === 'treatment');
    expect(treated.length / rooms.length).toBeGreaterThan(0.22);
    expect(treated.length / rooms.length).toBeLessThan(0.28);
  });

  it('sends the remainder to control rather than over-exposing', () => {
    const rooms = Array.from({ length: 1000 }, (_, i) => `room-${i}`);
    // Weights summing to 0.3: the other 70% must be control, not spread.
    const counts = new Map<string, number>();
    for (const r of rooms) {
      const v = assign('partial', r, { a: 0.15, b: 0.15 });
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(counts.get(CONTROL)! / rooms.length).toBeGreaterThan(0.65);
  });

  it('does not move a room when the config is rewritten in another order', () => {
    const rooms = Array.from({ length: 200 }, (_, i) => `room-${i}`);
    for (const r of rooms) {
      expect(assign('order', r, { alpha: 0.3, beta: 0.3 })).toBe(
        assign('order', r, { beta: 0.3, alpha: 0.3 }),
      );
    }
  });

  it('assigns everyone to control when no variant has weight', () => {
    expect(assign('empty', 'room-1', {})).toBe(CONTROL);
    expect(assign('zeroed', 'room-1', { treatment: 0 })).toBe(CONTROL);
  });

  it('buckets inside [0, 1)', () => {
    for (let i = 0; i < 500; i += 1) {
      const b = bucket('k', `s-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(1);
    }
  });
});
