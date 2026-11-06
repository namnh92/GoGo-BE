import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { MetricsPort } from '@gogo/observability';
import type * as Observability from '@gogo/observability';
import type { DbUsageLedger } from '@gogo/modules';
import { runAddressBackfillCli } from './backfill-place-addresses';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';
type SignalListener = ReturnType<typeof process.listeners<ShutdownSignal>>[number];

const f = vi.hoisted(() => ({
  scan: vi.fn(),
  write: vi.fn(),
  address: vi.fn<(id: string, metrics: MetricsPort) => Promise<string | null>>(),
  execute: vi.fn(),
  end: vi.fn(),
  ledger: null as DbUsageLedger | null,
}));

vi.mock('pg', () => ({
  Pool: vi.fn(function () {
    return { end: f.end };
  }),
}));
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({ execute: f.execute }),
}));
vi.mock('@gogo/database', () => ({ schema: {} }));
vi.mock('@gogo/observability', async () => {
  const { NoopMetrics, TeeMetrics } =
    await vi.importActual<typeof Observability>('@gogo/observability');
  return { createLogger: () => undefined, LogMetrics: NoopMetrics, TeeMetrics };
});
vi.mock('@gogo/providers', () => ({
  GooglePlacesAdapter: vi.fn(function (_key: string, metrics: MetricsPort) {
    return { address: (id: string) => f.address(id, metrics) };
  }),
}));
vi.mock('@gogo/modules', async () => {
  const { backfillPlaceAddresses } =
    await import('../libs/modules/places/application/place-address-backfill.js');
  const { DbUsageLedger, DEFAULT_LEDGER_FLUSH_MS } =
    await import('../libs/cost-observability/application/usage-ledger.js');
  return {
    backfillPlaceAddresses,
    DEFAULT_LEDGER_FLUSH_MS,
    DbAddressBackfillStore: vi.fn(function () {
      return { scan: f.scan, writeIfEmpty: f.write };
    }),
    DbUsageLedger: vi.fn(function (...args: ConstructorParameters<typeof DbUsageLedger>) {
      f.ledger = new DbUsageLedger(...args);
      return f.ledger;
    }),
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('address backfill CLI shutdown (#776 F-01/F-02)', () => {
  const dialect = new PgDialect();
  let events: string[];
  let writes: { sql: string; params: unknown[] }[];
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;
  let originalListeners: Map<ShutdownSignal, Set<SignalListener>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    events = [];
    writes = [];
    f.ledger = null;
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    process.argv = ['node', 'backfill-place-addresses.ts', '--execute', '--max-google-calls', '2'];
    process.exitCode = undefined;
    vi.stubEnv('DATABASE_URL', 'postgres://fixture');
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'fixture-key');
    vi.stubEnv('APP_ENV', 'dev');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    originalListeners = new Map(
      (['SIGINT', 'SIGTERM'] as const).map((signal) => [
        signal,
        new Set(process.listeners(signal)),
      ]),
    );
    f.scan.mockResolvedValue([
      { id: '1', externalId: 'google-1' },
      { id: '2', externalId: 'google-2' },
    ]);
    f.write.mockImplementation(async () => {
      events.push('place written');
      return true;
    });
    f.execute.mockImplementation(async (query: SQL) => {
      events.push('ledger written');
      writes.push(dialect.sqlToQuery(query));
      return { rows: [] };
    });
    f.end.mockImplementation(async () => {
      events.push('pool closed');
    });
    f.address.mockImplementation(async (_id, metrics) => {
      metrics.increment('places_provider_requests_total', {
        method: 'google.details.address',
        status: 200,
      });
      metrics.increment('places_provider_cost_units', { sku: 'google.details.address' });
      return 'Fixture address';
    });
  });

  afterEach(() => {
    for (const [signal, previous] of originalListeners) {
      for (const listener of process.listeners(signal)) {
        if (!previous.has(listener)) process.off(signal, listener);
      }
    }
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function signalHandler(signal: ShutdownSignal) {
    const previous = originalListeners.get(signal)!;
    const added = process.listeners(signal).filter((listener) => !previous.has(listener));
    expect(added).toHaveLength(1);
    return added[0]!;
  }

  function expectCleanedUp() {
    expect(f.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    for (const [signal, previous] of originalListeners) {
      expect(new Set(process.listeners(signal))).toEqual(previous);
    }
  }

  function expectOnePaidCallPersisted() {
    expect(f.ledger!.pending()).toBe(0);
    const legacy = writes.filter((query) => query.sql.includes('into provider_usage_daily'));
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.params).toContain('google.details.address');
    expect(legacy[0]!.params.slice(-3)).toEqual([1, 1, 1]);
    expect(writes.some((query) => query.sql.includes('into provider_usage_meter_daily'))).toBe(
      true,
    );
    expect(events.at(-1)).toBe('pool closed');
  }

  it('handles a rejected interval flush, retains counts, awaits work and cleanup, and exits 1', async () => {
    const provider = deferred();
    const entered = deferred();
    const paidCall = f.address.getMockImplementation()!;
    f.address.mockImplementation(async (id, metrics) => {
      await paidCall(id, metrics);
      entered.resolve();
      await provider.promise;
      return 'Fixture address';
    });
    f.execute.mockRejectedValueOnce(new Error('private database connection detail'));

    const running = runAddressBackfillCli();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.ledger!.pending()).toBe(1);
    expect(f.end).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    provider.resolve();
    await running;

    expect(f.address).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      'Place address backfill failed; check configuration and count logs.\n',
    );
    expect(events[0]).toBe('place written');
    expectOnePaidCallPersisted();
    expectCleanedUp();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    '%s waits for the in-flight call and write, drains and exits %s',
    async (signal, code) => {
      const provider = deferred();
      const entered = deferred();
      const write = deferred();
      const writing = deferred();
      const paidCall = f.address.getMockImplementation()!;
      f.address.mockImplementation(async (id, metrics) => {
        await paidCall(id, metrics);
        entered.resolve();
        await provider.promise;
        events.push('provider completed');
        return 'Fixture address';
      });
      f.write.mockImplementation(async () => {
        writing.resolve();
        await write.promise;
        events.push('place written');
        return true;
      });

      const running = runAddressBackfillCli();
      await entered.promise;
      const handler = signalHandler(signal);
      handler(signal);
      handler(signal); // Repeated signals must not start concurrent cleanup.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.end).not.toHaveBeenCalled();
      provider.resolve();
      await writing.promise;
      expect(f.end).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      write.resolve();
      await running;

      expect(f.address).toHaveBeenCalledTimes(1);
      expect(f.scan).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(code);
      expect(process.stderr.write).not.toHaveBeenCalled();
      expect(events.slice(0, 2)).toEqual(['provider completed', 'place written']);
      expectOnePaidCallPersisted();
      expectCleanedUp();
    },
  );

  it('closes the pool and sanitizes a failed final drain', async () => {
    f.execute.mockRejectedValue(new Error('private database connection detail'));
    await runAddressBackfillCli();

    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      'Place address backfill failed; check configuration and count logs.\n',
    );
    expect(f.ledger!.pending()).toBe(1);
    expectCleanedUp();
  });

  it('completes normally and removes its timer and signal listeners', async () => {
    await runAddressBackfillCli();

    expect(f.address).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(f.ledger!.pending()).toBe(0);
    expectCleanedUp();
  });
});
