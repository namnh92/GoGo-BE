import { describe, expect, it } from 'vitest';
import { WORKER_HEARTBEAT_STALE_MS, workerHealthFrom } from './cms-observability.service';

const AT = '2026-08-31T00:00:00.000Z';
const now = Date.parse(AT);
const ago = (ms: number) => new Date(now - ms);

describe('workerHealthFrom', () => {
  it('is unknown, not healthy, when no worker has ever written a heartbeat', () => {
    const health = workerHealthFrom([], now, AT);
    expect(health.status).toBe('unknown');
    expect(health.detail).toMatch(/heartbeat/);
  });

  it('is healthy while the newest heartbeat is within the stale window', () => {
    const health = workerHealthFrom(
      [{ worker_id: 'a', last_seen_at: ago(WORKER_HEARTBEAT_STALE_MS - 1) }],
      now,
      AT,
    );
    expect(health.status).toBe('healthy');
  });

  it('is down once every heartbeat is older than the window, and says how old', () => {
    const health = workerHealthFrom([{ worker_id: 'a', last_seen_at: ago(10 * 60_000) }], now, AT);
    expect(health.status).toBe('down');
    expect(health.detail).toBe('Last heartbeat 10 min ago');
  });

  it('one live worker among stale rows is enough — old replicas do not page anyone', () => {
    const health = workerHealthFrom(
      [
        { worker_id: 'old-container', last_seen_at: ago(3 * 24 * 60 * 60_000) },
        { worker_id: 'current', last_seen_at: ago(30_000) },
      ],
      now,
      AT,
    );
    expect(health.status).toBe('healthy');
  });

  it('accepts the timestamp as a string, which is how a raw query returns it', () => {
    const health = workerHealthFrom(
      [{ worker_id: 'a', last_seen_at: ago(1_000).toISOString() }],
      now,
      AT,
    );
    expect(health.status).toBe('healthy');
  });
});
