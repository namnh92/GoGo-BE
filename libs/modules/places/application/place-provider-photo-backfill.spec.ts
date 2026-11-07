import { describe, expect, it, vi } from 'vitest';
import { backfillProviderPhotos } from './place-provider-photo-backfill';

function setup() {
  const candidate = { id: 'internal-id', externalId: 'provider-id-never-logged' };
  const photo = {
    key: 'places/provider/test.jpg',
    cleanupId: 'cleanup',
    metadata: {
      provider: 'google' as const,
      sourceReference: candidate.externalId,
      fetchedAt: new Date().toISOString(),
      authorAttributions: [],
      googleMapsUri: null,
    },
  };
  const store = {
    scan: vi.fn(async (after: string | null) => (after ? [] : [candidate])),
    claimIfEligible: vi.fn(async () => true),
    attachIfEligible: vi.fn(async () => true),
  };
  const photos = {
    enabled: vi.fn(async () => true),
    probeForProvider: vi.fn(async () => ({ status: 'ok' as const, hasPhoto: true })),
  };
  const persistence = {
    prepare: vi.fn(async () => photo as typeof photo | undefined),
    discard: vi.fn(async () => undefined),
  };
  const options = { dryRun: true, probe: false, limit: 1, reportCandidate: vi.fn() };
  const run = () => backfillProviderPhotos(store, photos, persistence, options);
  return { candidate, photo, store, photos, persistence, options, run };
}

describe('#797 photo backfill orchestration', () => {
  it('dry-run lists only internal IDs, estimates baseline/retry cost, no provider/storage writes', async () => {
    const f = setup();
    expect(await f.run()).toMatchObject({
      total: 1,
      errors: 0,
      written: 0,
      estimate: {
        detailsCalls: 1,
        mediaCalls: 1,
        maxMediaCallsWithRetry: 2,
        listCostUsdMicros: 7000,
      },
    });
    expect(f.options.reportCandidate).toHaveBeenCalledExactlyOnceWith('internal-id');
    expect(f.photos.probeForProvider).not.toHaveBeenCalled();
    expect(f.persistence.prepare).not.toHaveBeenCalled();
    expect(f.store.attachIfEligible).not.toHaveBeenCalled();
    expect(f.store.claimIfEligible).not.toHaveBeenCalled();
  });
  it('probe calls references only and reports with/without/error separately', async () => {
    const f = setup();
    f.options.probe = true;
    expect(await f.run()).toMatchObject({ withPhoto: 1, withoutPhoto: 0, errors: 0 });
    f.photos.probeForProvider.mockResolvedValue({ status: 'ok', hasPhoto: false });
    expect(await f.run()).toMatchObject({ withPhoto: 0, withoutPhoto: 1 });
    f.photos.probeForProvider.mockRejectedValue(new Error('secret'));
    expect(await f.run()).toMatchObject({ errors: 1, withoutPhoto: 0 });
    expect(f.persistence.prepare).not.toHaveBeenCalled();
  });
  it('apply reuses prepare and attach; no-photo has no attachment', async () => {
    const f = setup();
    f.options.dryRun = false;
    expect(await f.run()).toMatchObject({ withPhoto: 1, written: 1 });
    expect(f.store.attachIfEligible).toHaveBeenCalledWith(f.candidate, f.photo);
    expect(f.persistence.discard).not.toHaveBeenCalled();
    f.persistence.prepare.mockResolvedValue(undefined);
    expect(await f.run()).toMatchObject({ withoutPhoto: 1, written: 0 });
  });
  it('compensates both lost eligibility and DB failure', async () => {
    const f = setup();
    f.options.dryRun = false;
    f.store.attachIfEligible.mockResolvedValue(false);
    expect(await f.run()).toMatchObject({ skipped: 1, written: 0 });
    expect(f.persistence.discard).toHaveBeenCalledWith(f.photo);
    f.store.attachIfEligible.mockRejectedValue(new Error('PII'));
    expect(await f.run()).toMatchObject({ errors: 1, written: 0 });
    expect(f.persistence.discard).toHaveBeenCalledTimes(2);
  });
  it.each(['prepare', 'attach', 'discard'])(
    'does not purchase again on rerun after %s failure',
    async (stage) => {
      const f = setup();
      f.options.dryRun = false;
      // Models the durable reservation surviving both failure and a fresh run.
      f.store.claimIfEligible.mockResolvedValueOnce(true).mockResolvedValue(false);
      if (stage === 'prepare') f.persistence.prepare.mockRejectedValue(new Error('upload'));
      else f.store.attachIfEligible.mockRejectedValue(new Error('DB'));
      if (stage === 'discard') f.persistence.discard.mockRejectedValue(new Error('storage'));
      expect(await f.run()).toMatchObject({ errors: 1, written: 0 });
      expect(await f.run()).toMatchObject({ skipped: 1, errors: 0, written: 0 });
      expect(f.persistence.prepare).toHaveBeenCalledTimes(1);
      expect(f.store.claimIfEligible.mock.invocationCallOrder[0]).toBeLessThan(
        f.persistence.prepare.mock.invocationCallOrder[0]!,
      );
    },
  );
  it('does not purchase when the reservation cannot be persisted', async () => {
    const f = setup();
    f.options.dryRun = false;
    f.store.claimIfEligible.mockRejectedValue(new Error('DB'));
    expect(await f.run()).toMatchObject({ errors: 1, written: 0 });
    expect(f.persistence.prepare).not.toHaveBeenCalled();
  });
  it('does not purchase if stopped while waiting for the reservation', async () => {
    const f = setup();
    const stop = new AbortController();
    f.store.claimIfEligible.mockImplementation(async () => {
      stop.abort();
      return true;
    });
    expect(
      await backfillProviderPhotos(f.store, f.photos, f.persistence, {
        ...f.options,
        dryRun: false,
        signal: stop.signal,
      }),
    ).toMatchObject({ stopped: 'signal', written: 0 });
    expect(f.persistence.prepare).not.toHaveBeenCalled();
  });
  it('stops on disabled flag before any call and compensates if disabled during upload', async () => {
    const f = setup();
    f.options.dryRun = false;
    f.photos.enabled.mockResolvedValue(false);
    expect(await f.run()).toMatchObject({ total: 0, stopped: 'disabled' });
    expect(f.store.scan).not.toHaveBeenCalled();
    f.photos.enabled.mockResolvedValue(true);
    f.persistence.prepare.mockImplementation(async () => {
      f.photos.enabled.mockResolvedValue(false);
      return f.photo;
    });
    expect(await f.run()).toMatchObject({ written: 0, stopped: 'disabled' });
    expect(f.persistence.discard).toHaveBeenCalledWith(f.photo);
    expect(f.store.attachIfEligible).not.toHaveBeenCalled();
  });
  it('sanitizes provider failures and respects an already aborted signal', async () => {
    const f = setup();
    f.options.dryRun = false;
    f.persistence.prepare.mockRejectedValue(new Error('key=secret'));
    const result = await f.run();
    expect(result.errors).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
    const result2 = await backfillProviderPhotos(f.store, f.photos, f.persistence, {
      ...f.options,
      signal: AbortSignal.abort(),
    });
    expect(result2).toMatchObject({ total: 0, stopped: 'signal' });
  });
});
