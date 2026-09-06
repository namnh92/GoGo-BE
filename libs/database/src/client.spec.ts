import { describe, expect, it } from 'vitest';
import { withQueryTelemetry } from './client';

type Record = { status: 'ok' | 'error'; startedAtMs: number };

function recorder() {
  const records: Record[] = [];
  return {
    records,
    record: (status: 'ok' | 'error', startedAtMs: number) => records.push({ status, startedAtMs }),
  };
}

describe('withQueryTelemetry (#414)', () => {
  it('times the callback form the pool uses, and records before handing the result on', async () => {
    const { records, record } = recorder();
    const invoke = (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: unknown, res?: unknown) => void;
      setTimeout(() => cb(null, { rows: [1] }), 5);
    };
    const result = await new Promise((resolve) =>
      withQueryTelemetry(
        invoke,
        ['select 1', [], (err: unknown, res?: unknown) => resolve(err ?? res)],
        record,
      ),
    );
    expect(result).toEqual({ rows: [1] });
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('ok');
  });

  it('records a callback error as error and still delivers it', async () => {
    const { records, record } = recorder();
    const boom = new Error('deadlock');
    const invoke = (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: unknown) => void;
      cb(boom);
    };
    const seen = await new Promise((resolve) =>
      withQueryTelemetry(invoke, ['select 1', (err: unknown) => resolve(err)], record),
    );
    expect(seen).toBe(boom);
    expect(records.map((r) => r.status)).toEqual(['error']);
  });

  it('times the promise form and returns the same value', async () => {
    const { records, record } = recorder();
    const value = await withQueryTelemetry(
      () => Promise.resolve({ rows: [] }),
      ['select 1'],
      record,
    );
    expect(value).toEqual({ rows: [] });
    expect(records.map((r) => r.status)).toEqual(['ok']);
  });

  it('records a rejected promise as error and rethrows it', async () => {
    const { records, record } = recorder();
    const boom = new Error('timeout');
    await expect(withQueryTelemetry(() => Promise.reject(boom), ['select 1'], record)).rejects.toBe(
      boom,
    );
    expect(records.map((r) => r.status)).toEqual(['error']);
  });

  it('passes a Submittable through untouched and unmeasured', () => {
    const { records, record } = recorder();
    const cursor = { submit: () => undefined };
    const out = withQueryTelemetry((...a) => a[0], [cursor], record);
    expect(out).toBe(cursor);
    expect(records).toHaveLength(0);
  });
});
