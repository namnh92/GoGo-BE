import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProviderPhotoBackfillCli } from './backfill-place-provider-photos';

const f = vi.hoisted(() => ({
  end: vi.fn(),
  run: vi.fn(),
  ledger: vi.fn(),
  flush: vi.fn(),
  stop: vi.fn(),
  prepare: vi.fn(),
  photos: vi.fn(),
  storage: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: vi.fn(function () {
    return { end: f.end };
  }),
}));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: () => ({}) }));
vi.mock('@gogo/database', () => ({ schema: {} }));
vi.mock('@gogo/observability', () => ({
  createLogger: vi.fn(),
  LogMetrics: vi.fn(function () {}),
  TeeMetrics: vi.fn(function () {}),
}));
vi.mock('@gogo/providers', () => ({
  GooglePlacesAdapter: vi.fn(function () {}),
  R2StorageAdapter: vi.fn(function () {
    f.storage();
  }),
  resolveR2AccountId: () => 'synthetic',
}));
vi.mock('@gogo/modules', () => ({
  backfillProviderPhotos: f.run,
  DbPhotoBackfillStore: vi.fn(function () {}),
  SubmissionPhotoService: vi.fn(function () {
    return { prepare: f.prepare };
  }),
  ProviderPhotosService: vi.fn(function () {
    f.photos();
  }),
  DbUsageLedger: vi.fn(function () {
    f.ledger();
    return { flush: f.flush, stop: f.stop };
  }),
  DEFAULT_LEDGER_FLUSH_MS: 50,
}));
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv('DATABASE_URL', 'postgres://synthetic');
  vi.stubEnv('APP_ENV', 'dev');
  vi.stubEnv('GOOGLE_PLACES_API_KEY', 'synthetic-key');
  for (const name of [
    'R2_PUBLIC_BUCKET',
    'R2_PUBLIC_ACCESS_KEY_ID',
    'R2_PUBLIC_SECRET_ACCESS_KEY',
    'MEDIA_PUBLIC_BASE_URL',
  ])
    vi.stubEnv(name, 'synthetic');
  for (const name of [
    'PLACE_DISPLAY_DAILY_MAX_CALLS',
    'PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD',
    'PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA',
    'FLAG_PLACE_PROVIDER_PHOTOS',
    'PROVENANCE_UNIFIED_READS',
  ])
    vi.stubEnv(name, undefined);
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'script', '--limit', '1']);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = 0;
  f.run.mockResolvedValue({ total: 1, errors: 0 });
});
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const args = (...values: string[]) =>
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'script', ...values]);

describe('#797 CLI lifecycle', () => {
  it.each([[], ['--probe']])(
    'dry-run %j never creates or flushes a DB ledger',
    async (...extra) => {
      args('--limit', '1', ...(extra as string[]));
      await runProviderPhotoBackfillCli();
      expect(f.run).toHaveBeenCalled();
      expect(f.ledger).not.toHaveBeenCalled();
      expect(f.flush).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.end).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
      expect(stdout.mock.calls.flat().join('')).toContain(extra.length ? 'probe' : 'dry-run');
    },
  );
  it('apply flushes the durable usage ledger before pool shutdown', async () => {
    args('--apply', '--limit', '1');
    await runProviderPhotoBackfillCli();
    expect(f.ledger).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.end.mock.invocationCallOrder[0]!);
  });
  it('periodic flush failure stops the loop and exits nonzero, still closing DB', async () => {
    args('--apply', '--limit', '1');
    f.flush.mockRejectedValueOnce(new Error('key=secret'));
    f.run.mockImplementationOnce(async (_store, _photos, _persistence, options) => {
      await vi.advanceTimersByTimeAsync(50);
      expect(options.signal.aborted).toBe(true);
      return { errors: 0 };
    });
    await runProviderPhotoBackfillCli();
    expect(process.exitCode).toBe(1);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.end).toHaveBeenCalledOnce();
    expect(stderr.mock.calls.flat().join('')).not.toContain('secret');
  });
  it('handles SIGTERM between candidates and removes listeners', async () => {
    args('--apply', '--limit', '1');
    const listeners = process.listenerCount('SIGTERM');
    f.run.mockImplementationOnce(async (_store, _photos, _persistence, options) => {
      process.emit('SIGTERM');
      expect(options.signal.aborted).toBe(true);
      return { errors: 0 };
    });
    await runProviderPhotoBackfillCli();
    expect(process.exitCode).toBe(143);
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.end).toHaveBeenCalledOnce();
  });
  it('reports sanitized configuration failure before any DB work', async () => {
    args('--apply', '--limit', '1');
    vi.stubEnv('R2_PUBLIC_SECRET_ACCESS_KEY', undefined);
    await runProviderPhotoBackfillCli();
    expect(process.exitCode).toBe(1);
    expect(f.run).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('')).not.toContain('synthetic-key');
  });
});
